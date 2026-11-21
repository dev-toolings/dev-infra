import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { DevHubError, type CatalogPort, type Component, type Executor, type Project } from "../contracts";
import { databaseName } from "../imports";
import { proxyHost } from "../proxy";
import { managedEntry } from "../runtime/mounts";
import { connectProjectNetwork, projectNetwork } from "../services";
import { featureProxyPort, previewHost } from "./docker";
import { LOCAL_DOCKER_HOST } from "../runtime/executor";
import type { Environment, Recipe } from "./types";

/** `run` must pin docker to the local Engine (environments/docker.ts hostExecutor): the feature containers live there. */
type Options = { catalog: CatalogPort; run: Executor; stateDir: string; infraDir: string };
type Entry = Environment & { recipe: Recipe };

const DB = /^[a-z_][a-z0-9_]{0,62}$/;
const fail = (message: string, code = "unsupported_project", status = 409): never => { throw new DevHubError(message, code, status); };
const envLines = (text: string) => text.split("\n").filter((line) => line.includes("=")).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)] as const; });
/** Only a Postgres URL names the database: a MySQL one can carry the same name. */
const postgresHost = (env: string, database: string) => new RegExp(`=postgres(?:ql)?://[^@\\s]+@([a-z0-9_.-]+):\\d+/${database}\\b`).exec(env)?.[1];
const imported = (stateDir: string, id: string) => join(stateDir, "imports", id);

/** Only a project DevHub runs in Docker has the state a feature is copied from. */
function managedComponent(project: Project): Component | undefined {
  const component = project.components[0];
  return project.components.length === 1 && component?.compose?.managed ? component : undefined;
}

/** A feature of a DevHub project answers on <feature>-<id>.<project>.localhost when the proxy profile runs. */
const projectDomain = (project: string) => proxyHost(project);
export const featureHost = (env: Pick<Environment, "id" | "slug">, project: string) => previewHost(env, projectDomain(project));

/** A project DevHub runs in Docker becomes a one-repository recipe on the shared isolation level. */
export function projectRecipe(project: Project, stateDir: string): Recipe {
  const component = managedComponent(project) ?? fail("Feature environments of a project need a recipe, or a project DevHub runs in Docker (created with devhub new or devhub import)");
  const dir = imported(stateDir, project.id);
  const env = readFileSync(join(dir, "app.env"), "utf8");
  if (/^(?:MYSQL_URL|MARIADB_URL)=|=(?:mysql|mariadb):\/\//m.test(env) || component.compose!.managed!.infra.some((item) => /^infra-(?:mysql|mariadb)/.test(item))) fail("Feature environments copy Postgres databases only; this project uses MySQL or MariaDB");
  const app = parse(readFileSync(join(dir, "compose.yml"), "utf8")).services.app;
  const port = Number(String(app.ports?.[0] ?? "").split(":").at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("The project app publishes no port");
  // A first start installs dependencies: wait as long as the app's own health check allows, plus a margin.
  const startPeriod = Number(/^(\d+)s$/.exec(String(app.healthcheck?.start_period ?? ""))?.[1] ?? 0);
  return {
    version: 1, repositories: { app: { path: project.root, ref: "HEAD" } },
    compose: { repository: "app", files: [], profiles: [], services: ["app"], vars: {}, secretFiles: {} },
    // The app container's own health check proves readiness: its home page may answer 404.
    routes: [{ path: "/", service: "app", port, healthPath: "/__devhub_health" }], steps: [],
    shared: { networks: [projectNetwork(project.id, component.compose!.managed!.infra)], volumes: [] },
    isolation: "shared", capabilities: {}, internet: [], resources: { cpus: 2, memoryMiB: 2048 }, idleMinutes: 1440, localFiles: [],
    previewDomain: projectDomain(project.id), generated: { project: project.id }, readySeconds: Math.max(90, startPeriod + 30),
  };
}

/** The copy carries no owner: every object belongs to the private role of the feature. */
export async function copyDatabase(run: Executor, infraDir: string, source: { host: string; admin: string; from: string }, target: string, envFile: string): Promise<void> {
  if (![source.from, target, source.admin].every((name) => DB.test(name))) fail("Unexpected database name", "invalid", 400);
  const provisioned = await run(["bash", resolve(infraDir, "bin/devhub"), "db", "provision", target, envFile, source.host, source.admin], { cwd: infraDir, timeoutMs: 60_000, maxOutputBytes: 64_000, env: { DOCKER_HOST: LOCAL_DOCKER_HOST } });
  if (provisioned.code !== 0) fail(`Database provisioning failed; check that ${source.host} runs with devhub up`, "provisioning_failed");
  const copied = await run(["docker", "exec", source.host, "sh", "-c", // Through a file, not a pipe: sh has no pipefail, and a failed dump would restore nothing and pass.
    'f=$(mktemp) || exit 1; pg_dump -U "$1" --no-owner --no-acl -f "$f" "$2" && psql -q -v ON_ERROR_STOP=1 -U "$3" -d "$3" -f "$f"; rc=$?; rm -f "$f"; exit $rc', "sh", source.admin, source.from, target], { timeoutMs: 600_000, maxOutputBytes: 256_000 });
  if (copied.code !== 0) fail(`Copying ${source.from} into ${target} failed: ${copied.stderr.trim().slice(0, 300)}`, "provisioning_failed");
}

async function postgresAdmin(run: Executor, host: string): Promise<string> {
  const result = await run(["docker", "exec", host, "printenv", "POSTGRES_USER"], { timeoutMs: 10_000, maxOutputBytes: 8_000 });
  return result.code === 0 && DB.test(result.stdout.trim()) ? result.stdout.trim() : fail(`${host} has no POSTGRES_USER; check that it runs with devhub up`, "provisioning_failed");
}

async function databaseExists(run: Executor, host: string, admin: string, database: string): Promise<boolean> {
  const found = await run(["docker", "exec", host, "psql", "-tA", "-v", "ON_ERROR_STOP=1", "-U", admin, "-d", "postgres", "-c", `SELECT 1 FROM pg_database WHERE datname = '${database}' UNION ALL SELECT 1 FROM pg_roles WHERE rolname = '${database}'`], { timeoutMs: 60_000, maxOutputBytes: 64_000 });
  if (found.code !== 0) fail(`Database provisioning failed; check that ${host} runs with devhub up`, "provisioning_failed");
  return found.stdout.trim() !== "";
}

export async function dropDatabase(run: Executor, host: string, admin: string, database: string): Promise<void> {
  if (!DB.test(database)) fail("Unexpected database name", "invalid", 400);
  const dropped = await run(["docker", "exec", host, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", admin, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, "-c", `DROP ROLE IF EXISTS "${database}"`], { timeoutMs: 60_000, maxOutputBytes: 64_000 });
  if (dropped.code !== 0) fail(`Dropping ${database} failed`, "provisioning_failed");
}

/** Where the feature database lives: the env file of the feature, or of its project when the feature never got one. */
function databaseHost(options: Options, entry: Entry, sourceDir: string): string | undefined {
  const own = join(sourceDir, "app.env");
  const env = readFileSync(existsSync(own) ? own : join(imported(options.stateDir, entry.recipe.generated!.project), "app.env"), "utf8");
  return postgresHost(env, existsSync(own) ? entry.database! : databaseName(entry.recipe.generated!.project));
}

/**
 * Writes the Compose file and env file of a feature from those of its project, once, then joins
 * the project network and copies the project database into a private one. A copy cut short is
 * dropped and made again: the database name belongs to this feature.
 */
export async function prepareProject(options: Options, entry: Entry, sourceDir: string, save: () => void): Promise<void> {
  const { catalog, run, stateDir, infraDir } = options;
  const parent = catalog.getProject(entry.recipe.generated!.project);
  const component = managedComponent(parent) ?? fail("The source project is no longer run by DevHub in Docker");
  const repo = entry.repos[0]!;
  const from = imported(stateDir, parent.id);
  if (!existsSync(join(sourceDir, "compose.yml"))) {
    const parentEnv = readFileSync(join(from, "app.env"), "utf8"), parentDb = databaseName(parent.id);
    entry.database = postgresHost(parentEnv, parentDb) ? databaseName(entry.id) : undefined;
    save();
    mkdirSync(join(sourceDir, "build"), { recursive: true, mode: 0o700 });
    for (const file of ["build/Dockerfile", "build/entry.sh"]) if (existsSync(join(from, file))) copyFileSync(join(from, file), join(sourceDir, file));
    const model = parse(readFileSync(join(from, "compose.yml"), "utf8"));
    const app = model.services.app;
    app.build.context = app.build.context === parent.root ? repo.path : join(sourceDir, "build");
    app.env_file = [join(sourceDir, "app.env")];
    delete app.ports;
    const script = managedEntry(stateDir, parent.id);
    app.volumes = app.volumes.map((mount: string) => mount.startsWith(`${parent.root}:`) ? `${repo.path}${mount.slice(parent.root.length)}` : mount.replace(script, join(sourceDir, "build", "entry.sh")));
    // Docker would otherwise create the dependencies mount point as root, and a host install would fail.
    for (const mount of app.volumes as string[]) if (/^[A-Za-z0-9_]+:\/app\//.test(mount)) mkdirSync(join(repo.path, mount.split(":")[1]!.slice("/app/".length)), { recursive: true });

    const password = randomBytes(24).toString("hex");
    const oldPassword = entry.database ? new Map(envLines(parentEnv)).get("DEVHUB_DB_PASSWORD") ?? fail("The project env file has no DEVHUB_DB_PASSWORD") : "";
    const port = featureProxyPort();
    const url = `http://${featureHost(entry, parent.id)}${port === 80 ? "" : `:${port}`}`;
    const env = envLines(parentEnv).map(([key, value]) => {
      if (entry.database && key === "DEVHUB_DB_PASSWORD") return `${key}=${password}`;
      if (entry.database && /^postgres(?:ql)?:\/\//.test(value) && value.includes(`/${parentDb}`)) value = value.replaceAll(oldPassword, password).replace(new RegExp(`\\b${parentDb}\\b`, "g"), entry.database);
      if (key === "REDIS_PREFIX" && value === `${parent.id}:`) value = `${entry.id}:`;
      if (key === "MEILISEARCH_INDEX_PREFIX" && value === `${parent.id}_`) value = `${entry.id}_`;
      // APP_URL, DEFAULT_URI: links and redirects must point to the feature, not its project.
      if (component.url) value = value.replaceAll(component.url, url);
      return `${key}=${value}`;
    }).join("\n") + "\n";
    writeFileSync(join(sourceDir, "app.env"), env, { mode: 0o600 });
    // Renamed into place last: its presence means the source is complete.
    writeFileSync(join(sourceDir, "compose.yml.tmp"), stringify(model), { mode: 0o600 });
    renameSync(join(sourceDir, "compose.yml.tmp"), join(sourceDir, "compose.yml"));
  }
  await connectProjectNetwork(run, parent.id, component.compose!.managed!.infra);
  if (!entry.database || entry.bootstrap["database-copy"] === "done") return;
  const host = databaseHost(options, entry, sourceDir) ?? fail("No Postgres address found in the feature env file");
  const admin = await postgresAdmin(run, host);
  if (entry.bootstrap["database-copy"]) await dropDatabase(run, host, admin, entry.database);
  else if (await databaseExists(run, host, admin, entry.database)) fail(`A database or role named ${entry.database} already exists; DevHub does not take it over`, "conflict");
  entry.bootstrap["database-copy"] = "running";
  save();
  try {
    await copyDatabase(run, infraDir, { host, admin, from: databaseName(parent.id) }, entry.database, join(sourceDir, "app.env"));
    entry.bootstrap["database-copy"] = "done";
  } catch (error) {
    entry.bootstrap["database-copy"] = "failed";
    throw error;
  } finally { save(); }
}

/**
 * Drops the private database of a feature; the project database is never touched. A name whose
 * copy never started belongs to nobody DevHub knows: an existing database there was refused.
 */
export async function purgeProjectDatabase(options: Options, entry: Entry, sourceDir: string): Promise<void> {
  if (!entry.database || !entry.bootstrap["database-copy"]) return;
  const host = databaseHost(options, entry, sourceDir) ?? fail("No Postgres address found for the feature database");
  await dropDatabase(options.run, host, await postgresAdmin(options.run, host), entry.database);
}
