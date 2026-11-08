import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { DevHubError, type CatalogPort, type Component, type DiscoveryPort, type Executor, type ExecResult, type Operation, type OperationsPort, type Project, type SharedServicesPort, type Worktree, type WorktreePlan, type WorktreeResult, type WorktreesPort } from "../contracts";
import { gitRun } from "../git";
import { assertProjectAvailable, databaseName, FIRST_PORT } from "../imports";
import { managedEntry } from "../runtime/mounts";
import { projectNetwork } from "../services";
import { proxyHost, syncProxy } from "../proxy";


type Options = { catalog: CatalogPort; discovery: DiscoveryPort; operations: OperationsPort; services: SharedServicesPort; run: Executor; stateDir: string; infraDir: string };

const NAMESPACE = "worktrees";
/** A variant nobody started, stopped or ran a command in for this long is stopped. */
export const IDLE_MS = 24 * 3600_000;
const DB = /^[a-z_][a-z0-9_]{0,62}$/;
const fail = (message: string, code = "invalid", status = 400): never => { throw new DevHubError(message, code, status); };
const envLines = (text: string) => text.split("\n").filter((line) => line.includes("=")).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)] as const; });
/** Only a Postgres URL names the database: a MySQL one can carry the same name. */
const postgresHost = (env: string, database: string) => new RegExp(`=postgres(?:ql)?://[^@\\s]+@([a-z0-9_.-]+):\\d+/${database}\\b`).exec(env)?.[1];

/** Only a project DevHub runs in Docker has the state a variant is copied from. */
function managedComponent(project: Project): Component {
  const component = project.components[0];
  if (project.components.length !== 1 || !component?.compose?.managed) fail("Worktrees support projects DevHub runs in Docker (created with devhub new or devhub import)", "unsupported_project", 409);
  return component!;
}

export class Worktrees implements WorktreesPort {
  constructor(private readonly options: Options) {}

  list(): Worktree[] { return this.options.catalog.listRecords<Worktree>(NAMESPACE); }
  get(id: string): Worktree | undefined { return this.options.catalog.getRecord<Worktree>(NAMESPACE, id); }
  private dir(id: string) { return join(this.options.stateDir, "imports", id); }

  async plan(projectId: string, branch: string, expireHours?: number): Promise<WorktreePlan> {
    const { catalog, discovery, run } = this.options;
    const parent = catalog.getProject(projectId);
    if (this.get(parent.id)) fail("A worktree cannot have worktrees of its own; use its parent project");
    const component = managedComponent(parent);
    // A leading dash would read as a Git option; check-ref-format rejects the rest.
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || (await gitRun(run, ["-C", parent.root, "check-ref-format", "--branch", branch])).code !== 0) fail("Invalid branch name");
    if (expireHours !== undefined && !(Number.isInteger(expireHours) && expireHours > 0 && expireHours <= 24 * 90)) fail("--expire takes a number of hours between 1 and 2160");
    const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fail("The branch name gives an empty folder name");
    const id = `${parent.id}--${slug}`.slice(0, 56).replace(/-+$/, "");
    const path = join(dirname(parent.root), `${basename(parent.root)}.worktrees`, slug);
    catalog.assertAllowedPath(path, false);
    if (existsSync(path)) fail(`${path} already exists`, "conflict", 409);
    assertProjectAvailable(catalog, id, path);
    const listed = await gitRun(run, ["-C", parent.root, "branch", "--list", branch]);
    if (listed.code !== 0) fail("The project folder is not a Git repository", "not_git", 409);
    const env = readFileSync(join(this.dir(parent.id), "app.env"), "utf8");
    if (/^(?:MYSQL_URL|MARIADB_URL)=|=(?:mysql|mariadb):\/\//m.test(env) || component.compose!.managed!.infra.some((item) => /^infra-(?:mysql|mariadb)/.test(item))) fail("Worktrees copy Postgres databases only; this project uses MySQL or MariaDB", "unsupported_project", 409);
    const database = postgresHost(env, databaseName(parent.id)) ? databaseName(id) : undefined;
    return {
      id, parent: parent.id, branch, slug, path, url: `http://127.0.0.1:${await discovery.freePort(FIRST_PORT)}`, host: proxyHost(`${slug}.${parent.id}`), newBranch: listed.stdout.trim() === "",
      ...(database ? { database } : {}), ...(expireHours ? { expiresAt: new Date(Date.now() + expireHours * 3600_000).toISOString() } : {}),
    };
  }

  async add(plan: WorktreePlan): Promise<WorktreeResult> {
    const { catalog, operations, run, stateDir } = this.options;
    const parent = catalog.getProject(plan.parent);
    const component = managedComponent(parent);
    mkdirSync(dirname(plan.path), { recursive: true });
    const added = await gitRun(run, ["-C", parent.root, "worktree", "add", ...(plan.newBranch ? ["-b", plan.branch, plan.path] : [plan.path, plan.branch])]);
    if (added.code !== 0) fail(`git worktree add failed: ${added.stderr.trim().slice(0, 300)}`, "git_failed", 409);
    const now = new Date().toISOString();
    const worktree: Worktree = { id: plan.id, parent: parent.id, branch: plan.branch, slug: plan.slug, path: plan.path, createdAt: now, activeAt: now, ...(plan.expiresAt ? { expiresAt: plan.expiresAt } : {}) };
    // Recorded first: whatever fails below, `worktree remove` finds what to clean.
    catalog.putRecord(NAMESPACE, plan.id, worktree);

    // Registered before the slow copy: the port is then owned, and a parallel add picks another one.
    // Checked again here: another program may have bound it since the preview.
    let url = `http://127.0.0.1:${await this.options.discovery.freePort(Number(new URL(plan.url).port))}`, project: Project | undefined;
    for (let attempt = 0; !project; attempt++) {
      try {
        project = catalog.createProject({
          id: plan.id, name: `${parent.name} (${plan.branch})`, root: plan.path,
          components: [{ ...component, cwd: plan.path, url, compose: { ...component.compose!, projectName: `devhub-${plan.id}` } }],
        });
      } catch (error) {
        if (attempt >= 5 || !(error instanceof DevHubError && error.code === "port_conflict")) throw error;
        url = `http://127.0.0.1:${await this.options.discovery.freePort(Number(new URL(url).port) + 1)}`;
      }
    }

    const from = this.dir(parent.id), to = this.dir(plan.id);
    mkdirSync(join(to, "build"), { recursive: true, mode: 0o700 });
    for (const file of ["build/Dockerfile", "build/entry.sh"]) if (existsSync(join(from, file))) copyFileSync(join(from, file), join(to, file));
    const port = new URL(url).port;
    const model = parse(readFileSync(join(from, "compose.yml"), "utf8"));
    const app = model.services.app;
    if (app.build.context === parent.root) app.build.context = plan.path; else app.build.context = join(to, "build");
    app.env_file = [join(to, "app.env")];
    app.ports = app.ports.map((mapping: string) => `127.0.0.1:${port}:${mapping.split(":").at(-1)}`);
    app.volumes = app.volumes.map((mount: string) => mount.startsWith(`${parent.root}:`) ? `${plan.path}${mount.slice(parent.root.length)}` : mount.replace(managedEntry(stateDir, parent.id), managedEntry(stateDir, plan.id)));
    model.networks.default.name = projectNetwork(plan.id, component.compose!.managed!.infra);
    writeFileSync(join(to, "compose.yml"), stringify(model), { mode: 0o600 });
    // Docker would otherwise create the dependencies mount point as root, and a host install would fail.
    for (const mount of app.volumes as string[]) if (/^[A-Za-z0-9_]+:\/app\//.test(mount)) mkdirSync(join(plan.path, mount.split(":")[1]!.slice("/app/".length)), { recursive: true });

    const parentEnv = readFileSync(join(from, "app.env"), "utf8"), parentDb = databaseName(parent.id), password = randomBytes(24).toString("hex");
    const oldPassword = plan.database ? new Map(envLines(parentEnv)).get("DEVHUB_DB_PASSWORD") ?? fail("The project env file has no DEVHUB_DB_PASSWORD") : "";
    const env = envLines(parentEnv).map(([key, value]) => {
      if (plan.database && key === "DEVHUB_DB_PASSWORD") return `${key}=${password}`;
      if (plan.database && /^postgres(?:ql)?:\/\//.test(value) && value.includes(`/${parentDb}`)) value = value.replaceAll(oldPassword, password).replace(new RegExp(`\\b${parentDb}\\b`, "g"), plan.database);
      if (key === "REDIS_PREFIX" && value === `${parent.id}:`) value = `${plan.id}:`;
      if (key === "MEILISEARCH_INDEX_PREFIX" && value === `${parent.id}_`) value = `${plan.id}_`;
      // APP_URL, DEFAULT_URI: links and redirects must point to the worktree, not its parent.
      if (component.url) value = value.replaceAll(component.url, url);
      return `${key}=${value}`;
    }).join("\n") + "\n";
    const host = plan.database ? postgresHost(env, plan.database) ?? fail("No Postgres address found in the project env file") : undefined;
    const source = host ? { host, admin: await this.options.services.containerEnv(host, "POSTGRES_USER"), from: parentDb } : undefined;
    writeFileSync(join(to, "app.env"), env, { mode: 0o600 });
    if (plan.database && source) await this.copyDatabase(source, plan.database, join(to, "app.env"));

    const operation = await operations.execute(plan.id, "start");
    await this.syncProxy();
    return { worktree, project, operation, url, host: plan.host };
  }

  /** The copy carries no owner: every object belongs to the private role of the variant. */
  private async copyDatabase(source: { host: string; admin: string; from: string }, target: string, envFile: string): Promise<void> {
    const { run, infraDir } = this.options;
    if (![source.from, target, source.admin].every((name) => DB.test(name))) fail("Unexpected database name");
    const provisioned = await run(["bash", resolve(infraDir, "bin/devhub"), "db", "provision", target, envFile, source.host, source.admin], { cwd: infraDir, timeoutMs: 60_000, maxOutputBytes: 64_000 });
    if (provisioned.code !== 0) fail(`Database provisioning failed; check that ${source.host} runs with devhub up`, "provisioning_failed", 409);
    const copied = await run(["docker", "exec", source.host, "sh", "-c", // Through a file, not a pipe: sh has no pipefail, and a failed dump would restore nothing and pass.
      'f=$(mktemp) || exit 1; pg_dump -U "$1" --no-owner --no-acl -f "$f" "$2" && psql -q -v ON_ERROR_STOP=1 -U "$3" -d "$3" -f "$f"; rc=$?; rm -f "$f"; exit $rc', "sh", source.admin, source.from, target], { timeoutMs: 600_000, maxOutputBytes: 256_000 });
    if (copied.code !== 0) fail(`Copying ${source.from} into ${target} failed: ${copied.stderr.trim().slice(0, 300)}`, "provisioning_failed", 409);
  }

  /** Refuses uncommitted work unless forced. The branch stays: its commits are kept. */
  async remove(id: string, force = false): Promise<{ removed: string; keptVolume?: string }> {
    const { catalog, operations, run } = this.options;
    const worktree = this.get(id) ?? fail("No worktree with this ID", "not_found", 404);
    const parent = catalog.getProject(worktree.parent);
    if (existsSync(worktree.path) && !force) {
      const status = await gitRun(run, ["-C", worktree.path, "status", "--porcelain"]);
      if (status.code !== 0 || status.stdout.trim()) fail("The worktree has uncommitted changes; commit them or use --force", "dirty_worktree", 409);
    }
    const project = catalog.listProjects().find((item) => item.id === id);
    const env = existsSync(join(this.dir(id), "app.env")) ? readFileSync(join(this.dir(id), "app.env"), "utf8") : "";
    // An add that failed before writing the Compose file has nothing running.
    if (project && existsSync(join(this.dir(id), "compose.yml"))) {
      await operations.execute(id, "stop");
      const down = await run(["docker", "compose", "-p", `devhub-${id}`, `--project-directory=${worktree.path}`, `--file=${join(this.dir(id), "compose.yml")}`, "down"], { timeoutMs: 120_000, maxOutputBytes: 256_000 });
      if (down.code !== 0) fail("Removing the containers failed", "runtime_stop", 502);
      // Docker has a few dozen bridge networks: one left per worktree would soon stop every start.
      const infra = project.components[0]?.compose?.managed?.infra ?? [];
      const network = projectNetwork(id, infra);
      if ((await run(["docker", "network", "inspect", network], { timeoutMs: 30_000, maxOutputBytes: 1_000_000 })).code === 0) {
        for (const service of infra) await run(["docker", "network", "disconnect", network, service], { timeoutMs: 30_000, maxOutputBytes: 64_000 });
        if ((await run(["docker", "network", "rm", network], { timeoutMs: 30_000, maxOutputBytes: 64_000 })).code !== 0) fail(`Removing the network ${network} failed`, "runtime_stop", 502);
      }
    }
    const database = databaseName(id);
    const host = postgresHost(env, database);
    if (host && DB.test(database)) {
      const admin = await this.options.services.containerEnv(host, "POSTGRES_USER");
      const dropped = await run(["docker", "exec", host, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", admin, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, "-c", `DROP ROLE IF EXISTS "${database}"`], { timeoutMs: 60_000, maxOutputBytes: 64_000 });
      if (dropped.code !== 0) fail(`Dropping ${database} failed`, "provisioning_failed", 409);
    }
    if (project) catalog.removeProject(id);
    if (existsSync(worktree.path)) {
      const removed = await gitRun(run, ["-C", parent.root, "worktree", "remove", ...(force ? ["--force"] : []), worktree.path]);
      if (removed.code !== 0) fail(`git worktree remove failed: ${removed.stderr.trim().slice(0, 300)}`, "git_failed", 409);
    } else await gitRun(run, ["-C", parent.root, "worktree", "prune"]);
    const volume = existsSync(join(this.dir(id), "compose.yml")) ? Object.keys(parse(readFileSync(join(this.dir(id), "compose.yml"), "utf8")).volumes ?? {})[0] : undefined;
    rmSync(this.dir(id), { recursive: true, force: true });
    catalog.deleteRecord(NAMESPACE, id);
    await this.syncProxy();
    // DevHub never deletes a named volume: the dependencies of the variant stay until removed by hand.
    return { removed: id, ...(volume ? { keptVolume: `devhub-${id}_${volume}` } : {}) };
  }

  /** Caddy names every project; it is optional, so a stopped proxy is not an error. */
  syncProxy() { return syncProxy(this.options.run, this.options.infraDir, this.options.catalog.listProjects(), this.list()); }

  /** Runs in the app container of the project, never on this machine. */
  async exec(projectId: string, command: string, timeoutMs = 120_000): Promise<ExecResult> {
    const { catalog, run } = this.options;
    const project = catalog.getProject(projectId);
    const component = managedComponent(project);
    if (!command.trim() || command.length > 8_000) fail("Give a command of at most 8000 characters");
    if (this.get(projectId)) catalog.updateRecord<Worktree>(NAMESPACE, projectId, (current) => ({ ...current!, activeAt: new Date().toISOString() }));
    return run(["docker", "compose", "-p", component.compose!.projectName, `--project-directory=${component.cwd}`, `--file=${join(this.dir(projectId), "compose.yml")}`, "exec", "-T", "app", "sh", "-c", command], { timeoutMs, maxOutputBytes: 1_000_000 });
  }

  /** Stops the variants idle for a day and removes the expired ones without uncommitted work. */
  async sweep(now = Date.now()): Promise<{ stopped: string[]; removed: string[] }> {
    const { operations } = this.options;
    const stopped: string[] = [], removed: string[] = [];
    for (const worktree of this.list()) {
      if (worktree.expiresAt && Date.parse(worktree.expiresAt) <= now) {
        try { await this.remove(worktree.id); removed.push(worktree.id); } catch { /* uncommitted work: kept, and still stopped below when idle */ }
        if (removed.includes(worktree.id)) continue;
      }
      let history: Operation[];
      try { history = operations.listOperations(worktree.id); } catch { continue; }
      const last = history.reduce<Operation | undefined>((latest, item) => !latest || item.updatedAt > latest.updatedAt ? item : latest, undefined);
      if (!last || last.action === "stop" || last.state === "queued" || last.state === "running") continue;
      const active = Math.max(Date.parse(worktree.activeAt), Date.parse(last.updatedAt));
      if (now - active < IDLE_MS) continue;
      await operations.execute(worktree.id, "stop");
      stopped.push(worktree.id);
    }
    return { stopped, removed };
  }
}
