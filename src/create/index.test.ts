import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevHubError, type CatalogPort, type CreateInput, type DiscoveryPort, type Executor, type ImportPlan, type ImportPort, type OperationsPort, type Project, type ProjectInput, type SharedServicesPort } from "../contracts";
import { Creator } from "./index";
import { nodeFiles } from "./node";
import { phpFiles } from "./php";
import { pythonFiles } from "./python";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture({ installCode = 0, missingTool = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devhub-create-")); dirs.push(root);
  const created: ProjectInput[] = [], commands: string[][] = [], imported: unknown[] = [], prepared: ImportPlan[] = [];
  const catalog = {
    listRoots: () => [{ id: "root-1", path: root, label: "code" }],
    listProjects: () => [],
    assertAllowedPath: (path: string) => path,
    createProject: (input: ProjectInput) => { created.push(input); return { ...input, createdAt: "now" } as Project; },
  } as unknown as CatalogPort;
  const discovery = { freePort: async () => 4100 } as unknown as DiscoveryPort;
  const imports = {
    scaffold: (input: unknown) => ({ ...(input as object), project: { components: [] } }),
    compose: () => "services: {}\n",
    plan: async (input: unknown) => { imported.push(input); return { url: "http://127.0.0.1:4100", project: { id: "shop", name: "Shop", root, components: [{ id: "app" }] } }; },
    prepare: async (plan: ImportPlan) => { prepared.push(plan); return { id: "shop" } as Project; },
  } as unknown as ImportPort;
  const operations = { submit: () => ({ state: "queued" }), execute: async () => ({ state: "succeeded" }) } as unknown as OperationsPort;
  const services: SharedServicesPort = {
    ensure: async (id, version) => ({ container: version === "17" ? `infra-${id}-17` : `infra-${id}`, port: 5432, hostPort: 15432, ...(version === "17" ? { admin: "devhub" } : {}) }),
    containerEnv: async () => "secret",
  };
  const run: Executor = async (argv) => {
    commands.push(argv);
    if (argv[0] === "which") return { code: argv[1] === missingTool ? 1 : 0, stdout: "", stderr: "" };
    if (argv[0] === "php") return { code: missingTool && argv[2]!.includes(missingTool) ? 1 : 0, stdout: "", stderr: "" };
    return argv.includes("install") ? { code: installCode, stdout: "", stderr: "registry down" } : { code: 0, stdout: "0.0.0.0:15432\n", stderr: "" };
  };
  return { root, created, commands, imported, prepared, creator: new Creator({ catalog, discovery, imports, operations, services, run, infraDir: "/infra" }) };
}
const input = (extra: Partial<CreateInput> = {}): CreateInput => ({ stack: "node", name: "Shop", rootId: "root-1", mode: "docker", options: {}, services: [], git: false, ...extra });

test("the plan fills in catalog defaults and Drizzle brings Postgres", async () => {
  const { root, creator } = fixture();
  const plan = await creator.plan(input({ options: { orm: "drizzle" } }));
  expect(plan.path).toBe(join(root, "shop"));
  expect(plan.input.options).toEqual({ framework: "hono", runtime: "bun", pattern: "modules", orm: "drizzle" });
  expect(plan.input.services).toEqual(["postgres"]);
  expect(plan.database).toBe("dh_shop");
});

test("the plan refuses what the catalog does not offer and an existing folder", async () => {
  const { root, creator } = fixture();
  await expect(creator.plan(input({ stack: "cobol" }))).rejects.toThrow("Unknown stack");
  await expect(creator.plan(input({ options: { runtime: "deno" } }))).rejects.toThrow("Invalid value");
  await expect(creator.plan(input({ options: { color: "red" } }))).rejects.toThrow("Unknown option");
  await expect(creator.plan(input({ services: ["oracle"] }))).rejects.toThrow("Unknown service");
  await expect(creator.plan(input({ rootId: "elsewhere" }))).rejects.toBeInstanceOf(DevHubError);
  mkdirSync(join(root, "shop"));
  await expect(creator.plan(input())).rejects.toThrow("already exists");
});

test("Docker mode hands the new project to the import engine with the chosen toolchain", async () => {
  const { root, imported, creator } = fixture();
  await creator.apply(await creator.plan(input({ options: { runtime: "node" } })), false);
  expect(imported).toEqual([{ path: join(root, "shop"), name: "Shop", id: "shop", toolchain: "npm", fresh: true }]);
  expect(JSON.parse(readFileSync(join(root, "shop/package.json"), "utf8")).dependencies["@hono/node-server"]).toBeDefined();
});

test("native mode writes a private env with host ports and keeps the password out of argv", async () => {
  const { root, created, commands, creator } = fixture();
  await creator.apply(await creator.plan(input({ mode: "native", services: ["postgres"] })), true);
  const env = readFileSync(join(root, "shop/.env"), "utf8");
  expect(env).toContain("@127.0.0.1:15432/dh_shop");
  const password = /DEVHUB_DB_PASSWORD=(\w+)/.exec(env)![1]!;
  expect(commands.flat().join(" ")).not.toContain(password);
  expect(commands.some((argv) => argv.join(" ") === "bun install")).toBe(true);
  expect(created[0]!.components[0]).toMatchObject({ kind: "native", argv: ["bun", "run", "--hot", "src/index.ts"], envFiles: [".env"], health: { url: "http://127.0.0.1:4100/health" } });
});

test("a failed creation removes its folder so a retry starts clean", async () => {
  const { root, creator } = fixture({ installCode: 1 });
  const plan = await creator.plan(input({ mode: "native" }));
  await expect(creator.apply(plan, true)).rejects.toThrow("bun install failed: registry down");
  expect(existsSync(join(root, "shop"))).toBe(false);
  await creator.plan(input({ mode: "native" }));
});

test("the two code structures generate their own layout, and .env stays out of Git", () => {
  const base = { name: "shop", runtime: "bun", orm: "none", services: [] };
  const modules = nodeFiles({ ...base, pattern: "modules" });
  for (const file of ["src/modules/health/domain/health.ts", "src/modules/notes/domain/note-repository.ts", "src/modules/notes/application/create-note.ts", "src/modules/notes/infrastructure/http/note-routes.ts", "src/shared/domain/errors.ts", "src/shared/infrastructure/http/error-handler.ts"]) expect(modules).toHaveProperty([file]);
  expect(modules["src/modules/notes/domain/note.ts"]).not.toContain("hono");
  expect(JSON.parse(modules["biome.json"]!).files.includes).toEqual(["**", "!**/.agents", "!**/.claude", "!**/drizzle"]);
  const standard = nodeFiles({ ...base, pattern: "standard" });
  for (const file of ["src/routes/health.ts", "src/routes/notes.ts", "src/schemas/notes.ts", "src/services/notes.ts", "src/middleware/error-handler.ts"]) expect(standard).toHaveProperty([file]);
  expect(standard[".gitignore"]).toContain(".env");
  const postgres = { ...base, orm: "drizzle", services: ["postgres"] };
  const drizzleModules = nodeFiles({ ...postgres, pattern: "modules" }), drizzleStandard = nodeFiles({ ...postgres, pattern: "standard" });
  expect(drizzleModules["src/index.ts"]).toContain("notes: drizzleNoteRepository(db)");
  expect(drizzleModules["drizzle.config.ts"]).toContain("./src/modules/*/infrastructure/persistence/schema.ts");
  expect(drizzleStandard["src/index.ts"]).toContain("notes: drizzleNoteStore(db)");
  expect(modules["src/index.ts"]).toContain("notes: memoryNoteRepository()");
});

test("Docker mode gives a Python project to the import engine as a known toolchain", async () => {
  const { root, prepared, creator } = fixture();
  const plan = await creator.plan(input({ stack: "python", services: ["redis"] }));
  expect(plan.dev).toBe("uv run uvicorn app.main:app --host 0.0.0.0 --port 3000 --reload --no-access-log");
  await creator.apply(plan, false);
  expect(prepared[0]).toMatchObject({ root: join(root, "shop"), toolchain: "uv", install: "uv sync", services: ["redis"] });
  expect(readFileSync(join(root, "shop/pyproject.toml"), "utf8")).toContain("redis==");
});

test("a native PHP project listens on its own port and gets its framework settings", async () => {
  const { root, created, commands, creator } = fixture();
  await creator.apply(await creator.plan(input({ stack: "php", mode: "native" })), true);
  expect(readFileSync(join(root, "shop/.env.local"), "utf8")).toMatch(/APP_SECRET=\w+/);
  expect(commands.some((argv) => argv.join(" ") === "composer install")).toBe(true);
  expect(created[0]!.components[0]).toMatchObject({ argv: ["php", "-S", "127.0.0.1:4100", "-t", "public", "public/index.php"], health: { url: "http://127.0.0.1:4100/health" } });
});

test("each Python and PHP layout has its own entry point", () => {
  expect(pythonFiles({ name: "shop", pattern: "modules", orm: "none", services: [] })).toHaveProperty(["app/modules/health/infrastructure/http/routes.py"]);
  expect(pythonFiles({ name: "shop", pattern: "standard", orm: "none", services: [] })).toHaveProperty(["app/routes/health.py"]);
  expect(phpFiles({ name: "shop", framework: "symfony", services: [] })).toHaveProperty(["src/Kernel.php"]);
  expect(phpFiles({ name: "shop", framework: "laravel", services: ["postgres"] })).toHaveProperty(["config/database.php"]);
});

test("native mode refuses a stack whose tools are missing, before anything is created", async () => {
  const { root, creator } = fixture({ missingTool: "uv" });
  await expect(creator.plan(input({ stack: "python", mode: "native" }))).rejects.toThrow("uv is not installed");
  expect(existsSync(join(root, "shop"))).toBe(false);
  await creator.plan(input({ stack: "python" }));
});

test("the plan offers each service in its catalog versions and defaults to the shared one", async () => {
  const { creator } = fixture();
  const plan = await creator.plan(input({ services: ["postgres", "redis"], versions: { postgres: "17" } }));
  expect(plan.input.versions).toEqual({ postgres: "17", redis: "7" });
  await expect(creator.plan(input({ services: ["postgres"], versions: { postgres: "9" } }))).rejects.toThrow("Unknown version of PostgreSQL: 9");
});

test("a native project reaches another Postgres version on its instance, and MySQL gets a private database", async () => {
  const { root, commands, creator } = fixture();
  await creator.apply(await creator.plan(input({ mode: "native", services: ["postgres", "mysql"], versions: { postgres: "17" } })), false);
  const env = readFileSync(join(root, "shop", ".env"), "utf8");
  expect(env).toMatch(/^DATABASE_URL=postgres:\/\/dh_shop:[a-f0-9]+@127\.0\.0\.1:15432\/dh_shop$/m);
  expect(env).toMatch(/^MYSQL_URL=mysql:\/\/dh_shop:[a-f0-9]+@127\.0\.0\.1:15432\/dh_shop$/m);
  expect(commands.find((argv) => argv.includes("provision"))?.slice(-2)).toEqual(["infra-postgres-17", "devhub"]);
  expect(commands.find((argv) => argv.some((item) => item.endsWith("provision-mysql-db.sh")))?.slice(2, 4)).toEqual(["infra-mysql", "dh_shop"]);
});

test("a Docker project joins the containers of its versions", async () => {
  const { creator, prepared } = fixture();
  await creator.apply(await creator.plan(input({ services: ["postgres", "rabbitmq"], versions: { postgres: "17" } })), false);
  const plan = prepared[0]!;
  expect(plan.infra).toEqual(["infra-postgres-17", "infra-rabbitmq"]);
  expect(plan.databaseHost).toBe("infra-postgres-17");
  expect(plan.databaseAdmin).toBe("devhub");
  expect(plan.linkedEnv?.RABBITMQ_URL).toBe("amqp://secret:secret@infra-rabbitmq:5432/%2F");
  expect(plan.project.components[0]?.compose?.managed?.infra).toEqual(["infra-postgres-17", "infra-rabbitmq"]);
});

test("two long project names keep separate MySQL databases within the name limit", async () => {
  const names = [];
  for (const name of ["acme-platform-billing-service-api", "acme-platform-billing-service-worker"]) {
    const { commands, creator } = fixture();
    await creator.apply(await creator.plan(input({ name, mode: "native", services: ["mysql"] })), false);
    names.push(commands.find((argv) => argv.some((item) => item.endsWith("provision-mysql-db.sh")))![3]!);
  }
  expect(names[0]).not.toBe(names[1]);
  for (const name of names) expect(name.length).toBeLessThanOrEqual(32);
});

test("the chosen release lines reach the image and the dependencies, and only where they apply", async () => {
  const { root, creator } = fixture();
  const plan = await creator.plan(input({ stack: "php", options: { phpVersion: "8.4", symfonyVersion: "8.1" } }));
  expect(plan.docker!.dockerfile).toContain("FROM dunglas/frankenphp:1.13-php8.4-trixie");
  await creator.apply(plan, false);
  expect(readFileSync(join(root, "shop/Dockerfile"), "utf8")).toBe(plan.docker!.dockerfile);
  expect(JSON.parse(readFileSync(join(root, "shop/composer.json"), "utf8")).require["symfony/runtime"]).toStartWith("8.1.");
  expect((await creator.plan(input({ name: "other", stack: "php", mode: "native", options: { framework: "laravel" } }))).input.options).toEqual({ framework: "laravel", pattern: "standard", laravelOrm: "none" });
  await expect(creator.plan(input({ name: "other", stack: "php", options: { phpVersion: "5.6" } }))).rejects.toThrow("Invalid value");
});

test("Docker fields become plain image lines, and anything else is refused", async () => {
  const { creator } = fixture();
  const custom = await creator.plan(input({ stack: "php", docker: { image: "dunglas/frankenphp:1.13-php8.5-bookworm", packages: ["imagemagick"], extensions: ["intl"] } }));
  expect(custom.docker!.dockerfile).toContain("FROM dunglas/frankenphp:1.13-php8.5-bookworm");
  expect(custom.docker!.dockerfile).toContain("--no-install-recommends imagemagick");
  expect(custom.docker!.dockerfile).toContain("install-php-extensions pdo_pgsql intl");
  await expect(creator.plan(input({ stack: "php", docker: { image: "php:8.5-cli" } }))).rejects.toThrow("run on FrankenPHP");
  await expect(creator.plan(input({ stack: "php", docker: { image: "dunglas/frankenphp:1.13-php8.5-alpine" } }))).rejects.toThrow("run on FrankenPHP");
  await expect(creator.plan(input({ stack: "php", docker: { packages: ["git && curl evil"] } }))).rejects.toThrow("Invalid system package");
  await expect(creator.plan(input({ stack: "php", docker: { image: "php\nRUN id" } }))).rejects.toThrow("Invalid image");
  await expect(creator.plan(input({ stack: "python", docker: { extensions: ["intl"] } }))).rejects.toThrow("PHP projects only");
  await expect(creator.plan(input({ docker: { dockerfile: "RUN id" } }))).rejects.toThrow("FROM line");
  expect((await creator.plan(input({ docker: { dockerfile: "FROM alpine\n" } }))).docker!.dockerfile).toBe("FROM alpine\n");
});

test("a draft previews the files of a folder that is taken or not approved, and a real plan still refuses it", async () => {
  const { root, creator } = fixture();
  mkdirSync(join(root, "my-project"));
  const taken = input({ name: "my-project" });
  expect((await creator.plan(taken, true)).path).toBe(join(root, "my-project"));
  await expect(creator.plan(taken)).rejects.toThrow("already exists");
  const elsewhere = input({ name: "my-project", rootId: "none" });
  const plan = await creator.plan(elsewhere, true);
  expect(plan.path).toBe("~/my-project");
  expect(plan.files).toContain("Dockerfile");
  await expect(creator.plan(elsewhere)).rejects.toBeInstanceOf(DevHubError);
});

test("the layout of AGENTS.md is a bullet list in every stack", async () => {
  const { creator } = fixture();
  const layout = async (extra: Partial<CreateInput>) => (await creator.plan(input(extra))).contents["AGENTS.md"]!.split("## Layout\n\n")[1]!.split("\n\n## Rules")[0]!.split("\n");
  const cases: Partial<CreateInput>[] = [{}, { options: { pattern: "standard", orm: "drizzle" } }, { stack: "python" }, { stack: "python", options: { pattern: "standard" } }, { stack: "php" }, { stack: "php", options: { framework: "laravel" } }];
  for (const extra of cases) {
    const lines = await layout(extra);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.startsWith("- "))).toBe(true);
  }
});

test("edited agent instructions replace the generated files in the plan and on disk", async () => {
  const { root, creator } = fixture();
  const plan = await creator.plan(input({ instructions: { "AGENTS.md": "# Mine\n" } }));
  expect(plan.contents["AGENTS.md"]).toBe("# Mine\n");
  expect(plan.generatedInstructions["AGENTS.md"]).toContain("devhub project start shop");
  await creator.apply(plan, false);
  expect(readFileSync(join(root, "shop", "AGENTS.md"), "utf8")).toBe("# Mine\n");
});

test("AGENTS.md carries the rules of the framework, the runtime, the mode and the services", async () => {
  const { creator } = fixture();
  const agents = async (values: Partial<CreateInput>) => (await creator.plan(input(values))).contents["AGENTS.md"]!;
  const docker = await agents({ stack: "node", name: "bunapp", mode: "docker", options: { runtime: "bun", orm: "drizzle" }, services: ["postgres", "redis"] });
  expect(docker).toContain("docker compose -p devhub-bunapp exec app <command>");
  expect(docker).toContain("`bun run db:generate`, then `bun run db:migrate`: never `drizzle-kit push`");
  expect(docker).toContain("keep every key under `REDIS_PREFIX`");
  expect(docker).not.toContain("erasable TypeScript");
  const native = await agents({ stack: "node", name: "npmapp", mode: "native", options: { runtime: "node" } });
  expect(native).toContain("erasable TypeScript");
  expect(native).not.toContain("docker compose");
  expect(native).not.toContain("drizzle");
  expect(await agents({ stack: "python", name: "api" })).toContain("`uv add`");
  expect(await agents({ stack: "php", name: "sf", options: { framework: "symfony" } })).toContain("There is no Flex");
  expect(await agents({ stack: "php", name: "lv", options: { framework: "laravel" } })).toContain("no `/api` prefix");
});

test("the add-feature skill follows the stack, the code structure and the mode", async () => {
  const { creator } = fixture();
  const skill = async (values: Partial<CreateInput>) => (await creator.plan(input(values))).contents[".claude/skills/add-feature/SKILL.md"]!;
  expect(await skill({ options: { pattern: "modules" } })).toContain("`src/modules/notes`");
  expect(await skill({ options: { pattern: "standard", runtime: "node", orm: "drizzle" }, services: ["postgres"] })).toContain("`npm run db:generate`");
  expect(await skill({ stack: "python", name: "api", options: { pattern: "standard" } })).toContain("`app/routes/notes.py`");
  expect(await skill({ stack: "python", name: "api", options: { orm: "sqlalchemy" } })).toContain("alembic revision --autogenerate");
  expect(await skill({ stack: "php", name: "sf", options: { framework: "symfony" } })).toContain("`src/Controller/NoteController.php`");
  expect(await skill({ stack: "php", name: "lv", options: { framework: "laravel" } })).toContain("`app/Http/Controllers/NoteController.php`");
  expect(await skill({ mode: "docker" })).toContain("in the `app` container");
  expect(await skill({ mode: "native" })).not.toContain("in the `app` container");
});

test("PHP in Docker runs on FrankenPHP, and the native mode keeps the PHP server", async () => {
  const { creator } = fixture();
  const symfony = await creator.plan(input({ stack: "php" }));
  expect(symfony.dev).toBe("frankenphp run --config Caddyfile");
  expect(symfony.contents.Caddyfile).toContain("http://:{$PORT}");
  expect(symfony.contents["config/packages/monolog.php"]).toContain("'channels' => ['!event', '!request', '!doctrine']");
  const services = symfony.contents["config/services.php"]!;
  expect(services.indexOf("instanceof(HealthCheck::class)")).toBeLessThan(services.indexOf("$services->load("));
  expect(JSON.parse(symfony.contents["composer.json"]!).conflict["symfony/http-kernel"]).toBe(">=8");
  expect(symfony.docker!.dockerfile).toContain("setcap -r /usr/local/bin/frankenphp");
  expect(symfony.docker!.dockerfile).toContain("/app /home/devhub /config /data");
  const laravel = await creator.plan(input({ stack: "php", options: { framework: "laravel" } }));
  expect(laravel.dev).toBe("php artisan octane:frankenphp --host=0.0.0.0 --port=3000 --watch --log-level=WARN");
  expect(laravel.docker!.dockerfile).toContain("install-php-extensions pdo_pgsql pcntl");
  expect(JSON.parse(laravel.contents["composer.json"]!).require).toHaveProperty(["laravel/octane"]);
  const native = await creator.plan(input({ stack: "php", mode: "native", options: { framework: "laravel" } }));
  expect(native.dev).toStartWith("php -S ");
  expect(JSON.parse(native.contents["composer.json"]!).require).not.toHaveProperty(["laravel/octane"]);
  expect((await creator.plan(input({ stack: "php", mode: "native" }))).contents).not.toHaveProperty(["Caddyfile"]);
});

test("a native PHP project needs its extensions on this machine", async () => {
  const { creator } = fixture({ missingTool: "pdo_sqlite" });
  await expect(creator.plan(input({ stack: "php", mode: "native" }))).rejects.toThrow("pdo_sqlite is missing");
  await creator.plan(input({ stack: "php" }));
  await creator.plan(input({ stack: "php", mode: "native", options: { symfonyOrm: "doctrine" } }));
});

test("a copied feature finds what the agent is told to copy", async () => {
  const { creator } = fixture();
  const plan = (options: Record<string, string>) => creator.plan(input({ stack: "php", mode: "native", options }));
  const modules = await plan({ pattern: "modules", symfonyOrm: "doctrine" });
  expect(modules.contents["config/packages/doctrine.php"]).toContain("/src/Modules'");
  expect((await plan({})).contents[".claude/skills/add-feature/SKILL.md"]).toContain("`$path`");
  const laravel = await plan({ framework: "laravel", laravelOrm: "eloquent" });
  expect(laravel.contents[".claude/skills/add-feature/SKILL.md"]).toContain("`app/Models/NoteRecord.php`");
  expect(JSON.parse(laravel.contents["composer.json"]!).scripts["post-autoload-dump"]).toContain("package:discover");
});

test("each framework gets its official env files and variable names", async () => {
  const { root, creator, created } = fixture();
  const symfony = await creator.plan(input({ stack: "php", name: "sf", mode: "native", services: ["postgres", "mailpit"] }));
  expect(symfony.contents).not.toHaveProperty([".env.example"]);
  expect(symfony.contents[".gitignore"]).toContain("/.env.local");
  expect(symfony.contents[".gitignore"]!.split("\n")).not.toContain("/.env");
  await creator.apply(symfony, false);
  const local = readFileSync(join(root, "sf/.env.local"), "utf8");
  expect(local).toContain("MAILER_DSN=smtp://127.0.0.1:15432");
  expect(local).toMatch(/^APP_SECRET=[0-9a-f]{32}$/m);
  expect(created[0]!.components[0]!.envFiles).toEqual([".env.local"]);

  const laravel = await creator.plan(input({ stack: "php", name: "lv", mode: "native", options: { framework: "laravel" }, services: ["postgres", "redis", "mailpit"] }));
  expect(laravel.contents[".env.example"]).toContain("MAIL_FROM_NAME=");
  expect(laravel.contents).not.toHaveProperty([".env"]);
  await creator.apply(laravel, false);
  const env = readFileSync(join(root, "lv/.env"), "utf8");
  expect(env).toMatch(/^APP_KEY=base64:/m);
  expect(env).toContain("DB_CONNECTION=pgsql");
  expect(env).toMatch(/^DB_URL=postgres:\/\//m);
  expect(env).toContain("REDIS_HOST=127.0.0.1");
  expect(env).toContain("MAIL_MAILER=smtp");
  expect(env).not.toContain("DATABASE_URL");

  await creator.apply(await creator.plan(input({ stack: "php", name: "dk", options: { framework: "laravel" } })), false);
  expect(readFileSync(join(root, "dk/.env"), "utf8")).toMatch(/^APP_KEY=base64:/m);
});

test("the preview hides generated secrets", async () => {
  const { creator } = fixture();
  const plan = await creator.plan(input({ stack: "php", services: ["postgres"] }));
  expect(plan.docker!.env.APP_SECRET).toBe("<generated>");
  expect((await creator.plan(input({ stack: "php", options: { framework: "laravel" } }))).docker!.env.APP_KEY).toBe("<generated>");
  expect(plan.docker!.env.DATABASE_URL).toBe("<generated>");
});

test("every stack ships agent instructions, and the plan shows what will be written", async () => {
  const { root, creator } = fixture();
  for (const stack of ["node", "python", "php"]) {
    const plan = await creator.plan(input({ stack, name: stack }));
    expect(plan.contents["CLAUDE.md"]).toBeUndefined();
    expect(plan.contents["AGENTS.md"]).toContain(`devhub project start ${stack}`);
    expect(plan.contents[".agents/skills/project-checks/SKILL.md"]).toBe(plan.contents[".claude/skills/project-checks/SKILL.md"]!);
    expect(plan.contents[".agents/skills/add-feature/SKILL.md"]).toBe(plan.contents[".claude/skills/add-feature/SKILL.md"]!);
    expect(plan.contents[".claude/skills/add-feature/SKILL.md"]).toContain("name: add-feature");
    expect(plan.contents["AGENTS.md"]).toContain("use the `add-feature` skill");
    expect(Object.keys(plan.contents).sort()).toEqual(plan.files);
    expect(plan.contents[".gitignore"]).toContain(".claude/settings.local.json");
    if (stack === "php") expect(plan.contents[".env"]).toContain("\nAPP_SECRET=\n");
    else expect(plan.contents).not.toHaveProperty([".env"]);
  }
  await creator.apply(await creator.plan(input({ stack: "python" })), false);
  expect(readFileSync(join(root, "shop/.claude/settings.json"), "utf8")).toContain("Bash(docker compose -p devhub-shop exec app uv run pytest:*)");
});
