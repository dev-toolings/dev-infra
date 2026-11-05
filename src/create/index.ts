import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DevHubError, type CatalogPort, type CreateInput, type CreateMode, type CreatePlan, type DockerCustom, type Toolchain, type CreatePort, type CreateResult, type DiscoveryPort, type Executor, type ImportPlan, type ImportPort, type OperationsPort, type ServiceInstance, type SharedServicesPort, type Project, type ProjectInput, type StackDefinition } from "../contracts";
import { gitRun } from "../git";
import { redactText } from "../operations/logger";
import versions from "../../data/versions.json";
import { assertProjectAvailable, databaseName, DEFAULT_CONTAINER_PORT, FIRST_PORT, renderDockerfile } from "../imports";
import { STACKS } from "./catalog";
import { AGENT_FEATURE, AGENT_RULES, agentFiles } from "./agents";
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
type Recipe = { files: Record<string, string>; install: string; /** What a new project must pass. */ checks: string[]; dev: string; env: Record<string, string>; toolchain: Toolchain; image: string; /** Needed on this machine in native mode. */ tools?: string[] };
const lineImage = (line: Record<string, string>, version: string | undefined) => line[version ?? ""] ?? Object.values(line)[0]!;
const DOCKER_IGNORE = [".git", ".env*", "!.env.example", "*.key", "*.pem", ".venv", "__pycache__", "dist", "node_modules", "storage", "vendor", "var", ""].join("\n");
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,200}$/, PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,63}$/, EXTENSION = /^[a-z0-9_]{1,40}$/;

/** What each stack generates and runs. */
export function recipe(stack: string, id: string, mode: CreateMode, port: number, options: Record<string, string>, services: string[]): Recipe {
  const docker = mode === "docker";
  const agents = (label: string, checks: string[], layout: string[], rules: string[], feature: string[]) => agentFiles({ name: id, stack: label, checks, layout, rules, feature, services, docker });
  const host = docker ? "0.0.0.0" : "127.0.0.1", listen = docker ? DEFAULT_CONTAINER_PORT : port;
  if (stack === "python") {
    const checks = ["uv run ruff check .", "uv run pytest"];
    return { toolchain: "uv", checks, image: lineImage(versions.lines.python, options.pythonVersion), tools: ["uv"], files: {
      ...pythonFiles({ name: id, pattern: options.pattern!, services }),
      ...agents("FastAPI", checks, [options.pattern === "modules" ? "`app/modules/<name>`: one folder per feature." : "`app/routes`: the routes.", "`app/main.py`: wires them together."], AGENT_RULES.fastapi, AGENT_FEATURE.fastapi(options.pattern!)),
    }, install: "uv sync", dev: `uv run uvicorn app.main:app --host ${host} --port ${listen} --reload`, env: {} };
  }
  if (stack === "php") {
    const laravel = options.framework === "laravel", checks = ["composer validate --no-check-publish"];
    return {
      toolchain: "composer", checks, image: lineImage(versions.lines.php, options.phpVersion), tools: ["php", "composer"], files: {
        ...phpFiles({ name: id, framework: options.framework!, symfonyVersion: options.symfonyVersion, services }),
        ...agents(laravel ? "Laravel" : "Symfony", checks, laravel ? ["`routes/api.php`: the routes.", "`bootstrap/app.php`: configures the app."] : ["`src/Controller`: the controllers.", "`src/Kernel.php`: configures the app."], laravel ? AGENT_RULES.laravel : AGENT_RULES.symfony, laravel ? AGENT_FEATURE.laravel : AGENT_FEATURE.symfony),
      }, install: "composer install", dev: `php -S ${host}:${listen} -t public public/index.php`,
      env: laravel ? { APP_ENV: "local", APP_DEBUG: "true", ...(services.includes("redis") ? { REDIS_CLIENT: "predis" } : {}) } : { APP_ENV: "dev", APP_DEBUG: "1", APP_SECRET: randomBytes(16).toString("hex") },
    };
  }
  const bun = options.runtime === "bun", tool = bun ? "bun" : "npm";
  const checks = [`${tool} run typecheck`, `${tool} run lint`, `${tool} test`];
  return {
    toolchain: tool, checks, image: bun ? versions.images.bun : lineImage(versions.lines.node, options.nodeVersion),
    files: {
      ...nodeFiles({ name: id, runtime: options.runtime!, pattern: options.pattern!, orm: options.orm!, services }),
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
  };
}

const fail = (message: string, code = "invalid", status = 400): never => { throw new DevHubError(message, code, status); };

/** Fields end up in a Dockerfile, so each one has to be a plain name. A whole file is the user's own text. */
function dockerfileFor({ toolchain, image }: Recipe, custom: DockerCustom = {}): string {
  if (custom.dockerfile !== undefined) {
    if (custom.dockerfile.length > 48_000 || !/^\s*FROM\s/im.test(custom.dockerfile)) fail("The Dockerfile needs a FROM line and at most 48 KB");
    return custom.dockerfile;
  }
  if (custom.image !== undefined && !IMAGE.test(custom.image)) fail(`Invalid image: ${custom.image}`);
  const packages = custom.packages ?? [], extensions = custom.extensions ?? [];
  const wrong = packages.find((item) => !PACKAGE.test(item));
  if (wrong !== undefined) fail(`Invalid system package: ${wrong}`);
  if (extensions.length > 0 && toolchain !== "composer") fail("Extensions apply to PHP projects only");
  const extension = extensions.find((item) => !EXTENSION.test(item));
  if (extension !== undefined) fail(`Invalid extension: ${extension}`);
  return renderDockerfile(toolchain, custom.image ?? image, packages, extensions);
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
    const { files, install, dev, tools = [], toolchain, image, env } = built;
    if (input.mode === "native") {
      for (const tool of tools) {
        const found = await this.options.run(["which", tool], { timeoutMs: 5_000, maxOutputBytes: 4_000 });
        if (found.code !== 0) fail(`${tool} is not installed on this machine; install it or choose Docker`, "missing_tool", 409);
      }
    }
    const url = `http://127.0.0.1:${port}`;
    const dockerfile = input.mode === "docker" ? dockerfileFor(built, input.docker) : undefined;
    const contents = { ...files, ...input.instructions, ...(dockerfile ? { Dockerfile: dockerfile, ".dockerignore": DOCKER_IGNORE } : {}) };
    const scaffold = dockerfile ? this.options.imports.scaffold({ root: path, name, id, toolchain, image, url, install, dev, services, env }) : undefined;
    const hidden = (key: string) => /SECRET|PASSWORD/.test(key);
    return {
      input: { ...input, name, options, services, versions },
      id, path, url,
      files: Object.keys(contents).sort(), contents, generatedInstructions: { "AGENTS.md": files["AGENTS.md"]! }, install, dev,
      ...(dockerfile && scaffold ? { docker: {
        dockerfile, compose: this.options.imports.compose({ ...scaffold, infra: services.map((service) => serviceContainer(service, versions[service]!)) }),
        env: Object.fromEntries(Object.entries({ ...scaffold.env, ...(services.includes("postgres") ? { DATABASE_URL: "<generated>" } : {}) }).map(([key, value]) => [key, hidden(key) ? "<generated>" : value])),
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
    const { files, toolchain, image, env } = recipe(input.stack, id, input.mode, Number(new URL(plan.url).port), input.options, input.services);
    mkdirSync(path);
    try {
      const own = plan.docker ? { Dockerfile: plan.docker.dockerfile, ".dockerignore": DOCKER_IGNORE } : {};
      for (const [file, content] of Object.entries({ ...files, ...input.instructions, ...own })) {
        mkdirSync(dirname(join(path, file)), { recursive: true });
        writeFileSync(join(path, file), content);
      }
      if (input.git) {
        const git = await gitRun(this.options.run, ["init"], { cwd: path, timeoutMs: 30_000, maxOutputBytes: 64_000 });
        if (git.code !== 0) fail("git init failed", "provisioning_failed", 409);
      }
      const links = await this.connect(plan);
      if (input.mode === "native") return await this.prepareNative(plan, env, links);
      if (toolchain === "uv" || toolchain === "composer") return await imports.prepare(this.linked(imports.scaffold({ root: path, name: input.name, id, toolchain, image, url: plan.url, install: plan.install, dev: plan.dev, services: input.services, env }), plan, links));
      return await imports.prepare(this.linked({ ...await imports.plan({ path, name: input.name, id, toolchain, fresh: true }), image, ownDockerfile: true }, plan, links));
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
      ...imported, url: plan.url, infra, linkedEnv: env,
      ...(postgres ? { databaseHost: postgres.container, ...(postgres.admin ? { databaseAdmin: postgres.admin } : {}) } : {}),
      project: { ...imported.project, components: imported.project.components.map((component) => ({ ...component, url: plan.url, compose: { ...component.compose!, managed: { infra } } })) },
    };
  }

  private async prepareNative(plan: CreatePlan, stackEnv: Record<string, string>, links: Links) {
    const { input, id, path, url, database } = plan;
    const { catalog, run, infraDir } = this.options;
    const envFile = join(path, ".env");
    const env: Record<string, string> = { ...stackEnv, HOST: "127.0.0.1", PORT: new URL(url).port, ...links.env };
    const postgres = links.postgres;
    if (database && postgres) {
      const password = randomBytes(24).toString("hex");
      env.DEVHUB_DB_PASSWORD = password;
      env.DATABASE_URL = `postgres://${database}:${password}@127.0.0.1:${postgres.hostPort}/${database}`;
    }
    writeFileSync(envFile, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
    // Install first: a failure here leaves no Postgres role behind.
    const installed = await run(plan.install.split(" "), { cwd: path, timeoutMs: 300_000, maxOutputBytes: 2_000_000 });
    if (installed.code !== 0) fail(`${plan.install} failed: ${redactText(installed.stderr.slice(-500))}`, "provisioning_failed", 409);
    if (database && postgres) {
      const created = await run(["bash", resolve(infraDir, "bin/devhub"), "db", "provision", database, envFile, postgres.container, ...(postgres.admin ? [postgres.admin] : [])], { cwd: infraDir, timeoutMs: 60_000, maxOutputBytes: 64_000 });
      if (created.code !== 0) fail(`Database provisioning failed; check that ${postgres.container} runs with devhub up`, "provisioning_failed", 409);
    }
    const project: ProjectInput = {
      id, name: input.name, root: path,
      components: [{ id: "app", name: "App", kind: "native", cwd: path, argv: plan.dev.split(" "), envFiles: [".env"], url, health: { url: `${url}/health` }, dependsOn: [] }],
    };
    return catalog.createProject(project);
  }
}
