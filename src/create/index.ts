import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DevHubError, type CatalogPort, type CreateInput, type CreateMode, type CreatePlan, type DockerCustom, type Toolchain, type CreatePort, type CreateResult, type DiscoveryPort, type Executor, type ImportPlan, type ImportPort, type OperationsPort, type ServiceInstance, type SharedServicesPort, type Project, type ProjectInput, type StackDefinition } from "../contracts";
import { gitRun } from "../git";
import { redactText } from "../operations/logger";
import versions from "../../data/versions.json";
import { assertProjectAvailable, databaseName, DEFAULT_CONTAINER_PORT, FIRST_PORT, renderDockerfile, type ProdStage } from "../imports";
import { STACKS } from "./catalog";
import { AGENT_FEATURE, AGENT_RULES, agentFiles } from "./agents";
import { fillEnv, frameworkEnv } from "./env";
import { makefile } from "./makefile";
import { nodeFiles } from "./node";
import { phpFiles } from "./php";
import { pythonFiles } from "./python";
import { serviceContainer } from "../services";

type Options = { catalog: CatalogPort; discovery: DiscoveryPort; imports: ImportPort; operations: OperationsPort; services: SharedServicesPort; run: Executor; infraDir: string };
/** What the selected services give the project: the containers its network joins and the variables that reach them. */
type Links = { infra: string[]; env: Record<string, string>; postgres?: ServiceInstance };
const MYSQL_USER_LIMIT = 32;
/** MySQL cuts nothing for us: a plain truncation would give two long project names the same database. */
function mysqlName(id: string): string {
  const name = databaseName(id);
  return name.length <= MYSQL_USER_LIMIT ? name : `${name.slice(0, MYSQL_USER_LIMIT - 9)}_${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}
type Recipe = { files: Record<string, string>; install: string; /** What a new project must pass. */ checks: string[]; dev: string; env: Record<string, string>; prod: ProdStage; toolchain: Toolchain; image: string; /** Needed on this machine in native mode. */ tools?: string[]; /** PHP extensions the code needs in its image. */ extensions?: string[]; /** PHP extensions needed on this machine in native mode. */ hostExtensions?: string[]; /** Where the values of this machine go, when it is not `.env`. */ envFile?: string; /** From DevHub names to the ones the framework reads. */ translateEnv?: (env: Record<string, string>) => Record<string, string> };
const lineImage = (line: Record<string, string>, version: string | undefined) => line[version ?? ""] ?? Object.values(line)[0]!;
// `bootstrap/cache` lists the dev packages of the last local install: an image without them would not boot.
const DOCKER_IGNORE = [".git", ".env*", "!.env.example", "*.key", "*.pem", ".venv", "__pycache__", "bootstrap/cache/*.php", "dist", "node_modules", "storage", "vendor", "var", ""].join("\n");
/** A stack whose local values live apart commits its `.env`, and the app needs it in the image. */
const dockerIgnore = ({ envFile }: Recipe) => envFile ? `${DOCKER_IGNORE}!.env\n` : DOCKER_IGNORE;
const SERVE = ["--host=0.0.0.0", `--port=${DEFAULT_CONTAINER_PORT}`];
const hidden = (key: string) => /SECRET|PASSWORD|_KEY$/.test(key);
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,200}$/, PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,63}$/, EXTENSION = /^[a-z0-9_]{1,40}$/;

/** What each stack generates and runs. */
export function recipe(stack: string, id: string, mode: CreateMode, port: number, options: Record<string, string>, services: string[]): Recipe {
  const docker = mode === "docker";
  const agents = (label: string, checks: string[], layout: string[], rules: string[], feature: string[]) => agentFiles({ name: id, stack: label, checks, layout, rules, feature, services, docker, ...(label === "Symfony" ? { localEnv: ".env.local" } : {}) });
  const host = docker ? "0.0.0.0" : "127.0.0.1", listen = docker ? DEFAULT_CONTAINER_PORT : port;
  if (stack === "python") {
    const checks = ["uv run ruff check .", "uv run ruff format --check .", "uv run mypy", "uv run pytest"];
    const modules = options.pattern === "modules", sqlalchemy = options.orm === "sqlalchemy";
    return { toolchain: "uv", checks, image: lineImage(versions.lines.python, options.pythonVersion), tools: ["uv"], files: {
      ...pythonFiles({ name: id, pattern: options.pattern!, orm: options.orm!, services }),
      Makefile: makefile({ id, docker, install: "uv sync",
        tools: [{ name: "format", about: "Format the code", command: "uv run ruff format ." }],
        checks: [{ name: "lint", about: "Lint the code", command: "uv run ruff check ." }, { name: "format-check", about: "Check the format", command: "uv run ruff format --check ." }, { name: "typecheck", about: "Check the types", command: "uv run mypy" }, { name: "test", about: "Run the tests", command: "uv run pytest" }],
        ...(sqlalchemy ? { database: [{ name: "migrate", about: "Apply the migrations", command: "uv run alembic upgrade head" }] } : {}) }),
      ...agents("FastAPI", checks, [
        ...(modules ? [
          "`app/modules/<name>`: one folder per feature, which shows only its `__init__.py`.",
          "`app/modules/<name>/domain`: the rules and the ports.",
          "`app/modules/<name>/application`: the use cases.",
          "`app/modules/<name>/infrastructure`: HTTP and storage.",
          "Dependencies point inward.",
        ] : [
          "`app/routes`: the routes.",
          "`app/schemas`: the request shapes.",
          "`app/services`: the logic.",
          "`app/middleware`: the access log and the error handlers.",
          "`app/lib`: the shared code.",
        ]),
        "`app/app.py`: `create_app()` mounts the routes.",
        "`app/main.py`: wires the real dependencies.",
        ...(sqlalchemy ? ["The table of `notes` needs `uv run alembic upgrade head`."] : []),
      ], [...AGENT_RULES.fastapi, ...(sqlalchemy ? AGENT_RULES.sqlalchemy : [])], AGENT_FEATURE.fastapi(options.pattern!, sqlalchemy)),
    }, install: "uv sync", dev: `uv run uvicorn app.main:app --host ${host} --port ${listen} --reload --no-access-log`, env: { APP_ENV: "development" },
      prod: { env: { APP_ENV: "production" }, setup: [], command: [".venv/bin/uvicorn", "app.main:app", ...SERVE, "--no-access-log"] } };
  }
  if (stack === "php") {
    const laravel = options.framework === "laravel", modules = options.pattern === "modules";
    const orm = laravel ? options.laravelOrm : options.symfonyOrm;
    const apiPlatform = !laravel && options.symfonyApi === "api-platform";
    const checks = ["composer validate --no-check-publish", "composer lint", "composer analyse", "composer test"];
    const layout = modules ? [
      `\`${laravel ? "app" : "src"}/Modules/<Name>\`: one folder per feature, like \`Health\`.`,
      `\`${laravel ? "app" : "src"}/Modules/<Name>/Domain\`: the rules and the ports.`,
      `\`${laravel ? "app" : "src"}/Modules/<Name>/Application\`: the use cases.`,
      `\`${laravel ? "app" : "src"}/Modules/<Name>/Infrastructure\`: HTTP and storage.`,
      "Dependencies point inward.",
    ] : laravel ? [
      "`app/Http/Controllers`: the controllers.",
      "`app/Http/Middleware`: the access log.",
      "`app/Exceptions`: the error shape.",
    ] : [
      "`src/Controller`: the controllers.",
      "`src/EventListener`: the access log and the error handler.",
      ...(orm === "doctrine" ? ["`src/Entity`: the Doctrine entities."] : []),
      ...(apiPlatform ? ["`src/ApiResource`: the API Platform resources.", "`src/State`: their providers and processors."] : []),
    ];
    return {
      toolchain: "composer", checks, image: lineImage(versions.lines.php, options.phpVersion), tools: ["php", "composer"], ...(laravel ? { extensions: ["pcntl"] } : {}),
      hostExtensions: services.includes("postgres") ? ["pdo_pgsql"] : [],
      ...(laravel ? {} : { envFile: ".env.local" }), translateEnv: (env) => frameworkEnv(options.framework!, env), files: {
        Makefile: makefile({ id, docker, install: "composer install",
          checks: [{ name: "validate", about: "Validate composer.json", command: "composer validate --no-check-publish" }, { name: "lint", about: "Check the code style", command: "composer lint" }, { name: "analyse", about: "Run the static analysis", command: "composer analyse" }, { name: "test", about: "Run the tests", command: "composer test" }],
          ...(orm === "doctrine" ? { database: [{ name: "migrate", about: "Apply the migrations", command: "php bin/console doctrine:migrations:migrate --no-interaction" }] } : orm === "eloquent" ? { database: [{ name: "migrate", about: "Apply the migrations", command: "php artisan migrate" }] } : {}) }),
        ...phpFiles({ name: id, framework: options.framework!, pattern: options.pattern!, symfonyVersion: options.symfonyVersion, orm: orm!, apiPlatform, services, docker }),
        ...agents(laravel ? "Laravel" : "Symfony", checks, [
          ...layout,
          ...(laravel ? ["`routes/api.php`: the routes.", "`app/Providers/AppServiceProvider.php`: wires the services."] : ["`config/services.php`: wires the services.", "`config/packages`: configures the bundles."]),
        ], [...AGENT_RULES.php, ...(laravel ? AGENT_RULES.laravel : AGENT_RULES.symfony), ...(apiPlatform ? AGENT_RULES.apiPlatform : []), ...(docker ? (laravel ? AGENT_RULES.octane : AGENT_RULES.frankenphp) : [])], laravel ? AGENT_FEATURE.laravel(modules, orm === "eloquent") : AGENT_FEATURE.symfony(modules, orm === "doctrine", apiPlatform)),
      }, install: "composer install",
      dev: !docker ? `php -S ${host}:${listen} -t public public/index.php` : laravel ? `php artisan octane:frankenphp --host=${host} --port=${listen} --watch --log-level=WARN` : "frankenphp run --config Caddyfile",
      prod: laravel
        // `.dockerignore` keeps `storage` out of the image, and the app needs its folders.
        ? { env: { APP_ENV: "production", APP_DEBUG: "false" }, setup: ["RUN mkdir -p storage/app storage/logs storage/framework/cache storage/framework/sessions storage/framework/views"], command: ["php", "artisan", "octane:frankenphp", ...SERVE, "--log-level=WARN"] }
        // Composer runs without scripts here, and the docs of API Platform need their assets.
        : { env: { APP_ENV: "prod", APP_DEBUG: "0", PORT: String(DEFAULT_CONTAINER_PORT) }, setup: apiPlatform ? ["RUN php bin/console assets:install public --no-interaction"] : [], command: ["frankenphp", "run", "--config", "Caddyfile"] },
      env: laravel
        ? { APP_ENV: "local", APP_DEBUG: "true", APP_KEY: `base64:${randomBytes(32).toString("base64")}`, APP_URL: `http://127.0.0.1:${port}`, ...(services.includes("redis") ? { REDIS_CLIENT: "predis" } : {}) }
        : { APP_ENV: "dev", APP_DEBUG: "1", APP_SECRET: randomBytes(16).toString("hex"), DEFAULT_URI: `http://127.0.0.1:${port}` },
    };
  }
  const bun = options.runtime === "bun", tool = bun ? "bun" : "npm";
  const checks = [`${tool} run typecheck`, `${tool} run lint`, `${tool} test`];
  return {
    toolchain: tool, checks, image: bun ? versions.images.bun : lineImage(versions.lines.node, options.nodeVersion),
    files: {
      ...nodeFiles({ name: id, runtime: options.runtime!, pattern: options.pattern!, orm: options.orm!, services }),
      Makefile: makefile({ id, docker, install: `${tool} install`,
        checks: [{ name: "typecheck", about: "Check the types", command: `${tool} run typecheck` }, { name: "lint", about: "Lint the code", command: `${tool} run lint` }, { name: "test", about: "Run the tests", command: `${tool} test` }],
        ...(options.orm === "drizzle" ? { database: [{ name: "db-generate", about: "Generate a migration", command: `${tool} run db:generate` }, { name: "migrate", about: "Apply the migrations", command: `${tool} run db:migrate` }] } : {}) }),
      ...agents("Hono", checks, [
        ...(options.pattern === "modules" ? [
          "`src/modules/<name>`: one folder per feature, which shows only its `index.ts`.",
          "`src/modules/<name>/domain`: the rules and the ports.",
          "`src/modules/<name>/application`: the use cases.",
          "`src/modules/<name>/infrastructure`: HTTP and storage.",
          "Dependencies point inward.",
          "To add a feature: copy `notes`, mount its routes in `src/app.ts` and wire it in `src/index.ts`.",
        ] : [
          "`src/routes`: the routes.",
          "`src/schemas`: the request shapes.",
          "`src/services`: the logic.",
          "`src/middleware`: the middleware.",
          "`src/lib`: the shared code.",
          "To add a resource: copy `notes`, mount its routes in `src/app.ts`, add its store to `AppDeps`, and pass it in `src/index.ts` and the tests.",
        ]),
        ...(options.orm === "drizzle" ? [`The table of \`notes\` needs \`${tool} run db:generate\`, then \`${tool} run db:migrate\`.`] : []),
      ], [...AGENT_RULES.hono, ...(bun ? AGENT_RULES.bun : AGENT_RULES.node), ...(options.orm === "drizzle" ? AGENT_RULES.drizzle(tool) : [])], AGENT_FEATURE.hono(options.pattern!, tool, options.orm === "drizzle")),
    },
    install: bun ? "bun install" : "npm install",
    dev: docker ? `${bun ? "bun" : "npm"} run dev` : bun ? "bun run --hot src/index.ts" : "node --watch src/index.ts",
    env: { NODE_ENV: "development" },
    prod: { env: { NODE_ENV: "production", HOST: "0.0.0.0", PORT: String(DEFAULT_CONTAINER_PORT) }, setup: [], command: [bun ? "bun" : "node", "src/index.ts"] },
  };
}

const fail = (message: string, code = "invalid", status = 400): never => { throw new DevHubError(message, code, status); };

/** Fields end up in a Dockerfile, so each one has to be a plain name. A whole file is the user's own text. */
/** The two values a user can reach through the panel, kept to what a Dockerfile line or an env file can hold. */
const ARG_VALUE = /^[A-Za-z0-9_.+:/@ -]{0,256}$/, ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/, ENV_VALUE = /^[^\s#"'`$\\]{0,1024}$/;
/** Provisioning writes these last, so a value typed in the panel would never reach the app. */
const MANAGED_ENV = /^(HOST|PORT|DATABASE_URL|DB_URL|DB_CONNECTION|REDIS_(URL|PREFIX|HOST|PORT)|SMTP_(HOST|PORT)|MAILER_DSN|MAIL_(MAILER|HOST|PORT)|MYSQL_URL|MARIADB_URL|RABBITMQ_URL|MEILISEARCH_\w+|DEVHUB_\w+)$/;
const quoted = (value: string) => /^\S+$/.test(value) ? value : `"${value}"`;
function withArgs(dockerfile: string, args: Record<string, string>): string {
  return Object.entries(args).reduce((text, [name, value]) => {
    const line = new RegExp(`^ARG ${name}=.*$`, "m");
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name.startsWith("DEVHUB_") || !line.test(text)) fail(`Unknown build variable: ${name}`);
    if (!ARG_VALUE.test(value) || (value === "" && name !== "SYSTEM_PACKAGES")) fail(`Invalid value for ${name}`);
    return text.replace(line, () => `ARG ${name}=${quoted(value)}`);
  }, dockerfile);
}
function checkEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) fail(`Invalid variable name: ${key}`);
    if (MANAGED_ENV.test(key)) fail(`DevHub sets ${key}`);
    if (hidden(key)) fail(`${key} looks like a secret: add it to app.env after creation`);
    // The value lands unquoted in an env file, which Laravel and Compose each read their own way.
    if (!ENV_VALUE.test(value)) fail(`The value of ${key} cannot hold spaces, quotes, # or $: add it to app.env after creation`);
  }
}
/** A whole Dockerfile may have no `dev` stage, and then Compose builds it as it is. */
const buildTarget = (dockerfile: string) => /^\s*FROM\s.+\sAS\s+dev\s*$/im.test(dockerfile) ? { buildTarget: "dev" } : {};

function dockerfileFor({ toolchain, image, extensions: needed = [], prod }: Recipe, custom: DockerCustom = {}): string {
  if (custom.dockerfile !== undefined) {
    if (custom.dockerfile.length > 48_000 || !/^\s*FROM\s/im.test(custom.dockerfile)) fail("The Dockerfile needs a FROM line and at most 48 KB");
    return custom.dockerfile;
  }
  if (custom.image !== undefined && !IMAGE.test(custom.image)) fail(`Invalid image: ${custom.image}`);
  // The project starts with `frankenphp` and the Dockerfile uses apt: another image would fail at start, not here.
  if (toolchain === "composer" && custom.image !== undefined && (!custom.image.startsWith("dunglas/frankenphp:") || custom.image.includes("alpine"))) fail("PHP projects run on FrankenPHP: choose a Debian dunglas/frankenphp image, or write a whole Dockerfile");
  const packages = custom.packages ?? [], extensions = custom.extensions ?? [];
  const wrong = packages.find((item) => !PACKAGE.test(item));
  if (wrong !== undefined) fail(`Invalid system package: ${wrong}`);
  if (extensions.length > 0 && toolchain !== "composer") fail("Extensions apply to PHP projects only");
  const extension = extensions.find((item) => !EXTENSION.test(item));
  if (extension !== undefined) fail(`Invalid extension: ${extension}`);
  const args = custom.args ?? {};
  // The row replaces the whole line, and a framework cannot run without the extensions it needs.
  const merged = args.PHP_EXTENSIONS === undefined ? args : { ...args, PHP_EXTENSIONS: [...new Set([...needed, ...args.PHP_EXTENSIONS.split(/\s+/).filter(Boolean)])].join(" ") };
  return withArgs(renderDockerfile(toolchain, custom.image ?? image, packages, [...needed, ...extensions], prod), merged);
}

export class Creator implements CreatePort {
  /** Ports of creations still in progress: they are not listening or registered yet. */
  private readonly pending = new Set<number>();
  constructor(private readonly options: Options) {}
  stacks(): StackDefinition[] { return structuredClone(STACKS); }

  async plan(input: CreateInput, draft = false): Promise<CreatePlan> {
    const { catalog, discovery } = this.options;
    const stack = STACKS.find((item) => item.id === input.stack) ?? fail(`Unknown stack: ${input.stack}`);
    if (!stack.modes.includes(input.mode)) fail(`Unknown mode: ${input.mode}`);
    const options: Record<string, string> = {};
    for (const option of stack.options) {
      // Options are in dependency order, so the one a `when` looks at is already resolved.
      if (option.when && options[option.when.option] !== option.when.value) continue;
      if (option.docker && input.mode !== "docker") continue;
      const value = input.options[option.id] ?? option.default;
      if (!option.choices.some((choice) => choice.value === value)) fail(`Invalid value for ${option.id}: ${value}`);
      options[option.id] = value;
    }
    for (const key of Object.keys(input.options)) if (!stack.options.some((option) => option.id === key)) fail(`Unknown option: ${key}`);
    const unknown = input.services.find((service) => !stack.services.some((item) => item.id === service));
    if (unknown) fail(`Unknown service: ${unknown}`);
    const required = stack.options.flatMap((option) => option.choices.find((choice) => choice.value === options[option.id])?.services ?? []);
    const services = [...new Set([...input.services, ...required])];
    const versions: Record<string, string> = {};
    for (const service of stack.services.filter((item) => services.includes(item.id))) {
      const version = input.versions?.[service.id] ?? service.default;
      if (!service.versions.includes(version)) fail(`Unknown version of ${service.name}: ${version}`);
      versions[service.id] = version;
    }

    const name = input.name.trim();
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 56);
    if (!id) fail("Project name must contain letters or numbers");
    const root = catalog.listRoots().find((item) => item.id === input.rootId || item.path === input.rootId) ?? (draft ? { path: "~" } : fail("Choose an approved folder", "path_forbidden", 403));
    const path = join(root.path, id);
    if (!draft) {
      catalog.assertAllowedPath(path, false);
      if (existsSync(path)) fail(`${path} already exists`, "conflict", 409);
      assertProjectAvailable(catalog, id, path);
    }

    let port = await discovery.freePort(FIRST_PORT);
    while (this.pending.has(port)) port = await discovery.freePort(port + 1);
    const built = recipe(stack.id, id, input.mode, port, options, services);
    checkEnv(input.docker?.env ?? {});
    built.env = { ...built.env, ...input.docker?.env };
    const { files, install, dev, tools = [], hostExtensions = [], toolchain, image, env, translateEnv = (values) => values } = built;
    if (input.mode === "native") {
      for (const tool of tools) {
        const found = await this.options.run(["which", tool], { timeoutMs: 5_000, maxOutputBytes: 4_000 });
        if (found.code !== 0) fail(`${tool} is not installed on this machine; install it or choose Docker`, "missing_tool", 409);
      }
      for (const extension of hostExtensions) {
        const found = await this.options.run(["php", "-r", `exit(extension_loaded('${extension}') ? 0 : 1);`], { timeoutMs: 5_000, maxOutputBytes: 4_000 });
        if (found.code !== 0) fail(`The PHP extension ${extension} is missing on this machine; install it or choose Docker`, "missing_tool", 409);
      }
    }
    const url = `http://127.0.0.1:${port}`;
    const dockerfile = input.mode === "docker" ? dockerfileFor(built, input.docker) : undefined;
    const contents = { ...files, ...input.instructions, ...(dockerfile ? { Dockerfile: dockerfile, ".dockerignore": dockerIgnore(built) } : {}) };
    const scaffold = dockerfile ? this.options.imports.scaffold({ root: path, name, id, toolchain, image, url, install, dev, services, env }) : undefined;
    const shown = scaffold ? translateEnv({ ...scaffold.env, ...(services.includes("postgres") ? { DATABASE_URL: "<generated>" } : {}) }) : {};
    return {
      input: { ...input, name, options, services, versions },
      id, path, url,
      files: Object.keys(contents).sort(), contents, generatedInstructions: { "AGENTS.md": files["AGENTS.md"]! }, install, dev,
      ...(dockerfile && scaffold ? { docker: {
        dockerfile, image, compose: this.options.imports.compose({ ...scaffold, ...buildTarget(dockerfile), infra: services.map((service) => serviceContainer(service, versions[service]!)) }),
        env: Object.fromEntries(Object.entries(shown).map(([key, value]) => [key, hidden(key) ? "<generated>" : value])),
        locked: Object.keys(shown).filter((key) => hidden(key) || !(key in env)),
      } } : {}),
      ...(services.includes("postgres") ? { database: databaseName(id) } : {}),
      isolation: input.mode === "docker"
        ? "Isolated container: non-root, no capabilities, only the project mounted, its own network."
        : "Runs on this machine as your user, in a systemd service. Only the database and port are dedicated.",
    };
  }

  /** The caller decides whether to wait: the CLI blocks on the start, the panel follows the returned operation. */
  async apply(plan: CreatePlan, wait: boolean): Promise<CreateResult> {
    const port = Number(new URL(plan.url).port);
    if (this.pending.has(port)) fail("Another creation just took this port; preview again", "port_conflict", 409);
    this.pending.add(port);
    try {
      const project = await this.register(plan);
      const { operations } = this.options;
      const operation = wait ? await operations.execute(plan.id, "start") : operations.submit(plan.id, "start");
      return { project, operation, url: plan.url };
    } finally { this.pending.delete(port); }
  }

  /** Until the project is registered the folder is ours alone: a failure removes it, so a retry starts clean. */
  private async register(plan: CreatePlan): Promise<Project> {
    const { input, id, path } = plan;
    const { imports } = this.options;
    const built = recipe(input.stack, id, input.mode, Number(new URL(plan.url).port), input.options, input.services);
    built.env = { ...built.env, ...input.docker?.env };
    const { files, toolchain, image, env } = built;
    mkdirSync(path);
    try {
      const own = plan.docker ? { Dockerfile: plan.docker.dockerfile, ".dockerignore": dockerIgnore(built) } : {};
      for (const [file, content] of Object.entries({ ...files, ...input.instructions, ...own })) {
        mkdirSync(dirname(join(path, file)), { recursive: true });
        writeFileSync(join(path, file), content);
      }
      if (input.git) {
        const git = await gitRun(this.options.run, ["init"], { cwd: path, timeoutMs: 30_000, maxOutputBytes: 64_000 });
        if (git.code !== 0) fail("git init failed", "provisioning_failed", 409);
      }
      const links = await this.connect(plan);
      if (input.mode === "native") return await this.prepareNative(plan, built, links);
      // Laravel expects a `.env` next to its example. In Docker, the real environment wins over it.
      if (input.stack === "php" && !built.envFile) writeFileSync(join(path, ".env"), fillEnv(files[".env.example"]!, env), { mode: 0o600 });
      if (toolchain === "uv" || toolchain === "composer") return await imports.prepare({ ...this.linked(imports.scaffold({ root: path, name: input.name, id, toolchain, image, url: plan.url, install: plan.install, dev: plan.dev, services: input.services, env }), plan, links), ...(built.translateEnv ? { translateEnv: built.translateEnv } : {}) });
      const imported = await imports.plan({ path, name: input.name, id, toolchain, fresh: true });
      return await imports.prepare(this.linked({ ...imported, env: { ...imported.env, ...input.docker?.env }, image, ownDockerfile: true }, plan, links));
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  }

  /** Starts what the project needs: a Docker project reaches it by container name, a native one by its published port. */
  private async connect(plan: CreatePlan): Promise<Links> {
    const { input, id } = plan;
    const { services } = this.options;
    const links: Links = { infra: [], env: {} };
    for (const service of input.services) {
      const instance = await services.ensure(service, input.versions![service]!);
      const host = input.mode === "docker" ? instance.container : "127.0.0.1";
      const port = input.mode === "docker" ? instance.port : instance.hostPort;
      links.infra.push(instance.container);
      if (service === "postgres") links.postgres = instance;
      if (service === "redis") Object.assign(links.env, { REDIS_URL: `redis://${host}:${port}`, REDIS_PREFIX: `${id}:` });
      if (service === "mailpit") Object.assign(links.env, { SMTP_HOST: host, SMTP_PORT: String(port) });
      if (service === "mysql" || service === "mariadb") {
        const user = mysqlName(id);
        const password = randomBytes(24).toString("hex");
        await this.provisionMysql(instance.container, user, password);
        links.env[`${service.toUpperCase()}_URL`] = `mysql://${user}:${password}@${host}:${port}/${user}`;
      }
      if (service === "meilisearch") Object.assign(links.env, { MEILISEARCH_URL: `http://${host}:${port}`, MEILISEARCH_API_KEY: await services.containerEnv(instance.container, "MEILI_MASTER_KEY"), MEILISEARCH_INDEX_PREFIX: `${id}_` });
      if (service === "rabbitmq") {
        const user = await services.containerEnv(instance.container, "RABBITMQ_DEFAULT_USER");
        const password = await services.containerEnv(instance.container, "RABBITMQ_DEFAULT_PASS");
        links.env.RABBITMQ_URL = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/%2F`;
      }
    }
    return links;
  }

  /** The script reads the password from a private file, so it never reaches argv. */
  private async provisionMysql(container: string, name: string, password: string) {
    const { run, infraDir } = this.options;
    const dir = mkdtempSync(join(tmpdir(), "devhub-db-"));
    try {
      const envFile = join(dir, "env");
      writeFileSync(envFile, `DEVHUB_DB_PASSWORD=${password}\n`, { mode: 0o600 });
      const created = await run(["bash", resolve(infraDir, "data/scripts/provision-mysql-db.sh"), container, name, envFile], { cwd: infraDir, timeoutMs: 60_000, maxOutputBytes: 64_000 });
      if (created.code !== 0) fail(`Database provisioning failed on ${container}`, "provisioning_failed", 409);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  private linked(imported: ImportPlan, plan: CreatePlan, { infra, env, postgres }: Links): ImportPlan {
    return {
      ...imported, ...buildTarget(plan.docker!.dockerfile), url: plan.url, infra, linkedEnv: env,
      ...(postgres ? { databaseHost: postgres.container, ...(postgres.admin ? { databaseAdmin: postgres.admin } : {}) } : {}),
      project: { ...imported.project, components: imported.project.components.map((component) => ({ ...component, url: plan.url, compose: { ...component.compose!, managed: { infra } } })) },
    };
  }

  private async prepareNative(plan: CreatePlan, { env: stackEnv, envFile: target = ".env", translateEnv = (values) => values, files }: Recipe, links: Links) {
    const { input, id, path, url, database } = plan;
    const { catalog, run, infraDir } = this.options;
    const envFile = join(path, target);
    const env: Record<string, string> = { ...stackEnv, HOST: "127.0.0.1", PORT: new URL(url).port, ...links.env };
    const postgres = links.postgres;
    if (database && postgres) {
      const password = randomBytes(24).toString("hex");
      env.DEVHUB_DB_PASSWORD = password;
      env.DATABASE_URL = `postgres://${database}:${password}@127.0.0.1:${postgres.hostPort}/${database}`;
    }
    const values = translateEnv(env);
    const example = input.stack === "php" ? files[".env.example"] : undefined;
    writeFileSync(envFile, example ? fillEnv(example, values) : `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
    // Install first: a failure here leaves no Postgres role behind.
    const installed = await run(plan.install.split(" "), { cwd: path, timeoutMs: 300_000, maxOutputBytes: 2_000_000 });
    if (installed.code !== 0) fail(`${plan.install} failed: ${redactText(installed.stderr.slice(-500))}`, "provisioning_failed", 409);
    if (database && postgres) {
      const created = await run(["bash", resolve(infraDir, "bin/devhub"), "db", "provision", database, envFile, postgres.container, ...(postgres.admin ? [postgres.admin] : [])], { cwd: infraDir, timeoutMs: 60_000, maxOutputBytes: 64_000 });
      if (created.code !== 0) fail(`Database provisioning failed; check that ${postgres.container} runs with devhub up`, "provisioning_failed", 409);
    }
    const project: ProjectInput = {
      id, name: input.name, root: path,
      components: [{ id: "app", name: "App", kind: "native", cwd: path, argv: plan.dev.split(" "), envFiles: [target], url, health: { url: `${url}/health` }, dependsOn: [] }],
    };
    return catalog.createProject(project);
  }
}
