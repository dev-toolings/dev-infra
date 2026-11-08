import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stringify } from "yaml";
import versions from "../../data/versions.json";
import { DevHubError, type CatalogPort, type DiscoveryPort, type Executor, type ImportInput, type ImportPlan, type ImportPort, type ImportResult, type OperationsPort, type Project, type ProjectInput, type ScaffoldInput, type Toolchain } from "../contracts";
import { projectNetwork } from "../services";
import { managedEntry } from "../runtime/mounts";

type Options = { catalog: CatalogPort; discovery: DiscoveryPort; operations: OperationsPort; run: Executor; stateDir: string; infraDir: string };
type Manifest = { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };

const FILE_LIMIT = 256 * 1024;
export const FIRST_PORT = 4100;
export const DEFAULT_CONTAINER_PORT = 3000;
/** A `port` literal in the app source can also be a client setting for one of these services. */
const INFRA_PORTS = [1025, 3306, 5432, 5672, 6379, 7700];
export const databaseName = (id: string) => `dh_${id.replace(/-/g, "_")}`;
const ENTRY_FILES = ["src/index.ts", "src/index.tsx", "src/index.js", "src/server.ts", "src/server.js", "src/app.ts", "index.ts", "index.js", "server.ts", "server.js"];
/** Commands come only from this table: nothing read from the project reaches the generated shell script. */
const fetchProbe = (binary: string) => (port: number) => [binary, "-e", `fetch('http://127.0.0.1:${port}/').then(()=>process.exit(0),()=>process.exit(1))`];
const NODE_LAYOUT = { before: [], setup: [], dev: [], built: [], manifest: "package.json", deps: "node_modules", writable: [] };
const TOOLCHAINS = {
  bun: { ...NODE_LAYOUT, image: versions.images.bun, probe: fetchProbe("bun"), prod: ["COPY package.json bun.lock ./", "RUN bun install --frozen-lockfile --production"], run: "bun run", locked: "bun install --frozen-lockfile", unlocked: "bun install --no-save", fresh: "bun install" },
  npm: { ...NODE_LAYOUT, image: versions.lines.node["24"], probe: fetchProbe("node"), prod: ["COPY package.json package-lock.json ./", "RUN npm ci --omit=dev"], run: "npm run", locked: "npm ci", unlocked: "npm install --no-package-lock", fresh: "npm install" },
  uv: {
    before: [], dev: [], built: [], manifest: "pyproject.toml", deps: ".venv", writable: [],
    prod: ["COPY pyproject.toml uv.lock ./", "RUN uv sync --frozen --no-dev --no-install-project"],
    // The cache and the environment sit on different filesystems, where uv cannot hardlink.
    setup: ["ENV UV_LINK_MODE=copy"],
    lock: "uv.lock",
    probe: (port: number) => ["python", "-c", `import urllib.error as e, urllib.request as r\ntry: r.urlopen('http://127.0.0.1:${port}/', timeout=2)\nexcept e.HTTPError: pass`],
  },
  composer: {
    // Caddy keeps its state in these two folders of the FrankenPHP image.
    manifest: "composer.json", deps: "vendor", writable: ["/config", "/data"],
    // `COPY --from` takes no variable, so the versioned image needs a stage of its own.
    before: [`ARG COMPOSER_VERSION=${versions.images.composer.split(":")[1]}`, "FROM composer:${COMPOSER_VERSION} AS composer"],
    setup: [
      "COPY --from=composer /usr/bin/composer /usr/local/bin/composer",
      "RUN apt-get update && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/*",
      // The image gives the binary a capability to bind port 80. Under `cap_drop: ALL` the kernel then refuses to run it.
      "RUN setcap -r /usr/local/bin/frankenphp",
    ],
    dev: ['RUN cp "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini"'],
    prod: [
      'RUN cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"',
      // Run as root without this, Composer disables its plugins, and symfony/runtime writes its autoloader through one.
      "ENV COMPOSER_ALLOW_SUPERUSER=1",
      "COPY composer.json composer.lock ./",
      "RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction",
    ],
    built: ["RUN composer dump-autoload --optimize --no-dev --no-scripts"],
    lock: "composer.lock",
    probe: (port: number) => ["php", "-r", `exit(@file_get_contents('http://127.0.0.1:${port}/', false, stream_context_create(['http' => ['ignore_errors' => true]])) === false ? 1 : 0);`],
  },
} as const;
/** What a framework adds to the prod stage. An imported project has none: its build context holds no code. */
export type ProdStage = { env: Record<string, string>; setup: string[]; command: string[] };
/** The images whose tag DevHub knows how to split. Any other stays whole in `BASE_IMAGE`. */
const IMAGE_TEMPLATES = [
  "dunglas/frankenphp:${FRANKENPHP_VERSION}-php${PHP_VERSION}-${DEBIAN_RELEASE}",
  "ghcr.io/astral-sh/uv:python${PYTHON_VERSION}-${DEBIAN_RELEASE}-slim",
  "node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim",
  "oven/bun:${BUN_VERSION}-slim",
];
/** FROM only reads a variable declared above it. */
function imageArgs(image: string): { args: string[]; from: string } {
  for (const template of IMAGE_TEMPLATES) {
    const found = new RegExp(`^${template.replace(/[./]/g, "\\$&").replace(/\$\{\w+\}/g, "([^-:@]+)")}$`).exec(image);
    if (found) return { args: [...template.matchAll(/\$\{(\w+)\}/g)].map((name, index) => `ARG ${name[1]}=${found[index + 1]}`), from: template };
  }
  return { args: [`ARG BASE_IMAGE=${image}`], from: "${BASE_IMAGE}" };
}
/** The image only. What confines the container stays in the Compose file, out of reach of an edited Dockerfile. */
export function renderDockerfile(tool: Toolchain, image: string, packages: string[] = [], extensions: string[] = [], prod?: ProdStage): string {
  const chain = TOOLCHAINS[tool];
  const { args, from } = imageArgs(image);
  return [
    "# Versions: change them here or in the DevHub panel, then rebuild.",
    ...args,
    ...chain.before,
    "",
    "# base: what dev, preprod and prod share, so all three run on the same system.",
    `FROM ${from} AS base`,
    ...chain.setup,
    `ARG SYSTEM_PACKAGES="${packages.join(" ")}"`,
    'RUN if [ -n "$SYSTEM_PACKAGES" ]; then apt-get update && apt-get install -y --no-install-recommends $SYSTEM_PACKAGES && rm -rf /var/lib/apt/lists/*; fi',
    ...(tool === "composer" ? [`ARG PHP_EXTENSIONS="${[...new Set(["pdo_pgsql", ...extensions])].join(" ")}"`, "RUN install-php-extensions $PHP_EXTENSIONS"] : []),
    "WORKDIR /app",
    "",
    "# dev: DevHub mounts the project on /app, then installs and starts it as your user.",
    "FROM base AS dev",
    ...chain.dev,
    "ARG DEVHUB_UID=1000",
    "ARG DEVHUB_GID=1000",
    // A named volume starts with the ownership of its image directory, which keeps the app non-root without any capability.
    `RUN mkdir -p /app/${chain.deps} /home/devhub && chown -R $DEVHUB_UID:$DEVHUB_GID ${["/app", "/home/devhub", ...chain.writable].join(" ")}`,
    "",
    ...(prod ? [
      "# prod: the same base with the code inside. Preprod runs this image too: only the variables differ.",
      "# Build it with: docker build --target prod .",
      "FROM base AS prod",
      ...Object.entries(prod.env).map(([key, value]) => `ENV ${key}=${value}`),
      ...chain.prod,
      "COPY . .",
      ...chain.built,
      ...prod.setup,
      `RUN chown -R 1000:1000 ${["/app", ...chain.writable].join(" ")}`,
      "USER 1000:1000",
      `EXPOSE ${DEFAULT_CONTAINER_PORT}`,
      `CMD ${JSON.stringify(prod.command)}`,
      "",
    ] : []),
  ].join("\n");
}
const serviceEnv = (id: string, redis: boolean, mail: boolean) => ({
  ...(redis ? { REDIS_URL: "redis://infra-redis:6379", REDIS_PREFIX: `${id}:` } : {}),
  ...(mail ? { SMTP_HOST: "infra-mailpit", SMTP_PORT: "1025" } : {}),
});
const managedProject = (root: string, name: string, id: string, url: string, infra: string[]): ProjectInput => ({
  id, name, root, components: [{ id: "app", name: "App", kind: "compose", cwd: root, url, dependsOn: [], compose: { files: ["compose.yml"], projectName: `devhub-${id}`, profiles: [], services: ["app"], managed: { infra } } }],
});

const fail = (message: string, code = "invalid", status = 400): never => { throw new DevHubError(message, code, status); };

function readBounded(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    return info.isFile() && info.size <= FILE_LIMIT ? readFileSync(path, "utf8") : undefined;
  } catch { return undefined; }
}
function envValues(text: string | undefined): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (text ?? "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  return values;
}
function hasFile(root: string, name: string): boolean {
  try { return lstatSync(join(root, name)).isFile(); } catch { return false; }
}

function toolchain(root: string): { name: "bun" | "npm"; lockfile?: string } {
  for (const lockfile of ["pnpm-lock.yaml", "yarn.lock"]) if (hasFile(root, lockfile)) fail(`${lockfile} is not supported by import yet; bun and npm projects are`, "unsupported_stack", 409);
  if (hasFile(root, "package-lock.json")) return { name: "npm", lockfile: "package-lock.json" };
  const lockfile = ["bun.lock", "bun.lockb"].find((name) => hasFile(root, name));
  return lockfile ? { name: "bun", lockfile } : { name: "bun" };
}
/** The container has its own port space, so a port hardcoded in the source only changes the mapping. */
function containerPort(root: string): number {
  for (const file of ENTRY_FILES) {
    const found = [...(readBounded(join(root, file)) ?? "").matchAll(/\bport\s*[:=]\s*(\d{2,5})\b/gi)].map((match) => Number(match[1]));
    const port = found.find((value) => !INFRA_PORTS.includes(value));
    if (port) return port;
  }
  return DEFAULT_CONTAINER_PORT;
}

/** `new` is reserved: /projects/new is the creation page. */
export function assertProjectAvailable(catalog: CatalogPort, id: string, root: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,55}$/.test(id) || id === "infra" || id === "new") fail("Project ID must use lowercase letters, numbers, underscores and hyphens, and cannot be infra or new");
  for (const project of catalog.listProjects()) {
    if (project.id === id) fail("Project ID is already registered", "conflict", 409);
    if (project.root === root) fail(`This folder is already registered as ${project.id}`, "conflict", 409);
    if (databaseName(project.id) === databaseName(id)) fail(`Project ${project.id} would share the database of this ID; choose another name`, "conflict", 409);
  }
}

export class Imports implements ImportPort {
  constructor(private readonly options: Options) {}

  async plan(input: ImportInput): Promise<ImportPlan> {
    const { catalog, discovery } = this.options;
    const root = catalog.assertAllowedPath(input.path, true);
    const detection = await discovery.inspect(root);
    if (detection.composeFiles.length) fail("This project has its own Compose file; register it with devhub project add", "manual_setup_required", 409);
    let manifest: Manifest | undefined;
    try { manifest = JSON.parse(readBounded(join(root, "package.json")) ?? "null") as Manifest | undefined; } catch { /* reported just below */ }
    if (!manifest || !detection.stacks.includes("hono")) return fail("Import supports Hono projects for now; no Hono dependency was found in package.json", "unsupported_stack", 409);
    const script = ["dev", "start"].find((name) => typeof manifest.scripts?.[name] === "string");
    if (!script) return fail("package.json needs a dev or start script", "manual_setup_required", 409);
    // These servers ignore PORT and HOST, so the container would never answer on the mapped port.
    if (/\b(?:wrangler|vite)\b/.test(String(manifest.scripts?.[script]))) return fail(`The ${script} script uses wrangler or vite, which import does not support yet`, "unsupported_stack", 409);

    const name = input.name?.trim() || basename(root);
    const id = input.id ?? name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 56);
    assertProjectAvailable(catalog, id, root);
    return this.build(root, name, id, manifest, script, input);
  }

  private async build(root: string, name: string, id: string, manifest: Manifest, script: string, input: ImportInput): Promise<ImportPlan> {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const uses = (...names: string[]) => names.some((item) => item in dependencies);
    const example = envValues(readBounded(join(root, ".env.example")));
    const databaseUrl = example.get("DATABASE_URL");
    const postgres = uses("pg", "postgres") || (databaseUrl !== undefined && !/^["']?(?:mysql|file|sqlite)/.test(databaseUrl));
    const redis = uses("redis", "ioredis") || example.has("REDIS_URL");
    const mail = uses("nodemailer") || example.has("SMTP_HOST");
    const { name: tool, lockfile } = input.toolchain ? { name: input.toolchain, lockfile: undefined } : toolchain(root);
    const chain = TOOLCHAINS[tool];
    const port = containerPort(root);
    const url = `http://127.0.0.1:${await this.options.discovery.freePort(FIRST_PORT)}`;
    const infra = [...(postgres ? ["infra-postgres"] : []), ...(redis ? ["infra-redis"] : []), ...(mail ? ["infra-mailpit"] : [])];
    const env = {
      ...Object.fromEntries([...example].filter(([, value]) => value !== "")),
      NODE_ENV: "development", HOST: "0.0.0.0", PORT: String(port),
      ...serviceEnv(id, redis, mail),
    };
    const database = postgres ? databaseName(id) : undefined;
    const missing = [...example].filter(([key, value]) => value === "" && !(key in env) && !(postgres && key === "DATABASE_URL")).map(([key]) => key);
    const warnings = uses("amqplib", "meilisearch") ? ["RabbitMQ and Meilisearch are not provisioned by import yet"] : [];
    return {
      project: managedProject(root, name, id, url, infra), toolchain: tool,
      image: chain.image, install: input.fresh ? chain.fresh : lockfile ? chain.locked : chain.unlocked, dev: `${chain.run} ${script}`, ...(lockfile ? { lockfile } : {}), url, containerPort: port, infra, ...(database ? { database } : {}), env, missing, warnings,
    };
  }

  scaffold({ root, name, id, toolchain: tool, image, url, install, dev, services, env }: ScaffoldInput): ImportPlan {
    const postgres = services.includes("postgres"), redis = services.includes("redis"), mail = services.includes("mailpit");
    const infra = [...(postgres ? ["infra-postgres"] : []), ...(redis ? ["infra-redis"] : []), ...(mail ? ["infra-mailpit"] : [])];
    return {
      project: managedProject(root, name, id, url, infra), toolchain: tool, image, ownDockerfile: true, install, dev, ...(tool === "uv" || tool === "composer" ? { lockfile: TOOLCHAINS[tool].lock } : {}), url, containerPort: DEFAULT_CONTAINER_PORT, infra,
      ...(postgres ? { database: databaseName(id) } : {}),
      env: { ...env, HOST: "0.0.0.0", PORT: String(DEFAULT_CONTAINER_PORT), ...serviceEnv(id, redis, mail) }, missing: [], warnings: [],
    };
  }

  async apply(plan: ImportPlan): Promise<ImportResult> {
    const project = await this.prepare(plan);
    const operation = await this.options.operations.execute(project.id, "start");
    return { project, operation, url: plan.url, missing: plan.missing };
  }

  /** Everything that confines the container is here, so no Dockerfile can loosen it. */
  compose(plan: ImportPlan): string {
    const { id, root } = plan.project;
    const dir = join(this.options.stateDir, "imports", id), build = join(dir, "build");
    const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
    const chain = TOOLCHAINS[plan.toolchain];
    const volume = chain.deps.replace(".", "");
    return stringify({
      services: { app: {
        build: { context: plan.ownDockerfile ? root : build, ...(plan.buildTarget ? { target: plan.buildTarget } : {}), args: { DEVHUB_UID: String(uid), DEVHUB_GID: String(gid) } },
        // An entrypoint, not a command: an ENTRYPOINT in a custom Dockerfile would otherwise swallow it.
        init: true, user: `${uid}:${gid}`, working_dir: "/app", entrypoint: ["sh", "/devhub/entry.sh"],
        env_file: [join(dir, "app.env")], environment: { HOME: "/home/devhub" },
        ports: [`127.0.0.1:${new URL(plan.url).port}:${plan.containerPort}`],
        volumes: [`${root}:/app`, `${volume}:/app/${chain.deps}`, `${managedEntry(this.options.stateDir, id)}:/devhub/entry.sh:ro`],
        cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
        // Any HTTP answer counts: an API without a / route is still up.
        healthcheck: { test: ["CMD", ...chain.probe(plan.containerPort)], interval: "3s", timeout: "3s", retries: 5, start_period: "300s" },
      } },
      volumes: { [volume]: {} },
      networks: { default: { name: projectNetwork(id, plan.infra), external: true } },
    });
  }

  /** Provisions and registers the project, without starting it. */
  async prepare(plan: ImportPlan): Promise<Project> {
    const { catalog, run, stateDir, infraDir } = this.options;
    const { id, root } = plan.project;
    const dir = join(stateDir, "imports", id), build = join(dir, "build"), envFile = join(dir, "app.env");
    mkdirSync(build, { recursive: true, mode: 0o700 });
    // Values already in the file win: a re-import keeps the role password and whatever the operator filled in.
    const previous = envValues(readBounded(envFile));
    const env: Record<string, string> = { ...plan.env, ...Object.fromEntries(previous), ...plan.linkedEnv };
    if (plan.database) {
      const password = previous.get("DEVHUB_DB_PASSWORD") ?? randomBytes(24).toString("hex");
      env.DEVHUB_DB_PASSWORD = password;
      env.DATABASE_URL = `postgres://${plan.database}:${password}@${plan.databaseHost ?? "infra-postgres"}:5432/${plan.database}`;
    }
    writeFileSync(envFile, `${Object.entries(plan.translateEnv?.(env) ?? env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
    if (plan.database) {
      const created = await run(["bash", resolve(infraDir, "bin/devhub"), "db", "provision", plan.database, envFile, ...(plan.databaseHost ? [plan.databaseHost, ...(plan.databaseAdmin ? [plan.databaseAdmin] : [])] : [])], { cwd: infraDir, timeoutMs: 60_000, maxOutputBytes: 64_000 });
      if (created.code !== 0) fail(`Database provisioning failed; check that ${plan.databaseHost ?? "infra-postgres"} runs with devhub up`, "provisioning_failed", 409);
    }
    const chain = TOOLCHAINS[plan.toolchain];
    // Docker would otherwise create this mount point as root, and a later host install would fail.
    mkdirSync(join(root, chain.deps), { recursive: true });
    if (!plan.ownDockerfile) writeFileSync(join(build, "Dockerfile"), renderDockerfile(plan.toolchain, plan.image));
    writeFileSync(managedEntry(stateDir, id), [
      "#!/bin/sh",
      "set -eu",
      `stamp=${chain.deps}/.devhub-install`,
      // The first install writes the lockfile of a new project, so it may not exist yet.
      // The dependencies outlive a rebuild in their volume: a new runtime version in the Dockerfile has to reinstall them.
      `hash=$(cat ${chain.manifest} ${plan.lockfile ?? ""} Dockerfile 2>/dev/null | sha256sum)`,
      'if [ "$(cat "$stamp" 2>/dev/null || true)" != "$hash" ]; then',
      `  ${plan.install}`,
      '  printf %s "$hash" > "$stamp"',
      "fi",
      `exec ${plan.dev}`,
      "",
    ].join("\n"));
    writeFileSync(join(dir, "compose.yml"), this.compose(plan), { mode: 0o600 });
    return catalog.createProject(plan.project);
  }
}
