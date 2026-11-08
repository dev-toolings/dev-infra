import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { DevHubError, type CatalogPort, type DiscoveryPort, type Executor, type Operation, type OperationsPort, type Project, type ProjectInput, type SharedServicesPort } from "../contracts";
import { execCommand } from "../runtime/executor";
import { managedEntry } from "../runtime/mounts";
import { proxySites, renderSites } from "../proxy";
import { Worktrees } from "./index";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

function fixture(operationsLog: Operation[] = [], extraEnv = "") {
  const base = mkdtempSync(join(tmpdir(), "devhub-worktree-")); dirs.push(base);
  const root = join(base, "shop"), stateDir = join(base, "state"), infraDir = join(base, "infra");
  mkdirSync(root, { recursive: true }); mkdirSync(join(infraDir, "data/caddy/sites"), { recursive: true });
  git(root, "init", "-q", "-b", "main"); writeFileSync(join(root, "README.md"), "shop\n"); git(root, "add", "."); git(root, "commit", "-q", "-m", "init");
  const dir = join(stateDir, "imports", "shop");
  mkdirSync(join(dir, "build"), { recursive: true });
  writeFileSync(join(dir, "build/entry.sh"), "#!/bin/sh\nexec bun run dev\n");
  writeFileSync(join(dir, "app.env"), "PORT=3000\nREDIS_PREFIX=shop:\nDEVHUB_DB_PASSWORD=" + "a".repeat(48) + "\nDATABASE_URL=postgres://dh_shop:" + "a".repeat(48) + "@infra-postgres:5432/dh_shop\nAPP_URL=http://127.0.0.1:4100\nMEILISEARCH_INDEX_PREFIX=shop_\n" + extraEnv);
  writeFileSync(join(dir, "compose.yml"), stringify({
    services: { app: { build: { context: root }, env_file: [join(dir, "app.env")], ports: ["127.0.0.1:4100:3000"], volumes: [`${root}:/app`, "node_modules:/app/node_modules", `${managedEntry(stateDir, "shop")}:/devhub/entry.sh:ro`] } },
    volumes: { node_modules: {} }, networks: { default: { name: "devhub-shop-1234", external: true } },
  }));
  const parent: Project = { id: "shop", name: "Shop", root, createdAt: "now", components: [{ id: "app", name: "App", kind: "compose", cwd: root, url: "http://127.0.0.1:4100", dependsOn: [], compose: { files: ["compose.yml"], projectName: "devhub-shop", profiles: [], services: ["app"], managed: { infra: ["infra-postgres"] } } }] };
  const projects = new Map<string, Project>([["shop", parent]]), records = new Map<string, unknown>(), commands: string[][] = [], executed: string[] = [], conflicts = { left: 0 };
  const catalog = {
    assertAllowedPath: (path: string) => path,
    getProject: (id: string) => projects.get(id) ?? (() => { throw new DevHubError("missing", "not_found", 404); })(),
    listProjects: () => [...projects.values()],
    createProject: (input: ProjectInput) => { if (conflicts.left-- > 0) throw new DevHubError("Project URL port 4101 is already owned", "port_conflict", 409); const project = { ...input, createdAt: "now" }; projects.set(input.id, project); return project; },
    removeProject: (id: string) => { projects.delete(id); },
    putRecord: (_ns: string, id: string, value: unknown) => { records.set(id, value); },
    getRecord: (_ns: string, id: string) => records.get(id),
    updateRecord: (_ns: string, id: string, update: (current: unknown) => unknown) => { records.set(id, update(records.get(id))); return records.get(id); },
    listRecords: () => [...records.values()],
    deleteRecord: (_ns: string, id: string) => { records.delete(id); },
  } as unknown as CatalogPort;
  const discovery = { freePort: async (start: number) => Math.max(start, 4101) } as unknown as DiscoveryPort;
  const operations = {
    execute: async (id: string, action: string) => { executed.push(`${action} ${id}`); return { state: "succeeded" } as Operation; },
    listOperations: () => operationsLog,
  } as unknown as OperationsPort;
  const services = { containerEnv: async () => "test" } as unknown as SharedServicesPort;
  const run: Executor = async (argv, options) => { if (argv[0] === "git") return execCommand(argv, options); commands.push(argv); return { code: 0, stdout: "", stderr: "" }; };
  return { root, stateDir, infraDir, projects, records, commands, executed, conflicts, worktrees: new Worktrees({ catalog, discovery, operations, services, run, stateDir, infraDir }) };
}

test("a worktree gets its own folder, port, env, database copy and Compose project", async () => {
  const { root, stateDir, infraDir, projects, commands, executed, worktrees } = fixture();
  const plan = await worktrees.plan("shop", "fix/auth");
  expect(plan).toMatchObject({ id: "shop--fix-auth", path: `${root}.worktrees/fix-auth`, url: "http://127.0.0.1:4101", host: "fix-auth.shop.localhost", newBranch: true, database: "dh_shop__fix_auth" });
  const result = await worktrees.add(plan);
  expect(result.operation.state).toBe("succeeded");
  expect(git(plan.path, "branch", "--show-current").stdout.toString().trim()).toBe("fix/auth");

  const dir = join(stateDir, "imports", plan.id);
  const app = parse(readFileSync(join(dir, "compose.yml"), "utf8"));
  expect(app.services.app.ports).toEqual(["127.0.0.1:4101:3000"]);
  expect(app.services.app.build.context).toBe(plan.path);
  expect(app.services.app.env_file).toEqual([join(dir, "app.env")]);
  expect(app.services.app.volumes).toEqual([`${plan.path}:/app`, "node_modules:/app/node_modules", `${managedEntry(stateDir, plan.id)}:/devhub/entry.sh:ro`]);
  expect(app.networks.default.name).toStartWith("devhub-shop--fix-auth-");

  const env = readFileSync(join(dir, "app.env"), "utf8");
  expect(env).toContain("REDIS_PREFIX=shop--fix-auth:");
  expect(env).toContain("@infra-postgres:5432/dh_shop__fix_auth\n");
  expect(env).not.toContain("a".repeat(48));
  expect(env).toContain("APP_URL=http://127.0.0.1:4101\n");
  expect(env).toContain("MEILISEARCH_INDEX_PREFIX=shop--fix-auth_\n");
  expect(existsSync(join(plan.path, "node_modules"))).toBe(true);
  expect(commands.find((argv) => argv.includes("provision"))).toEqual(expect.arrayContaining(["dh_shop__fix_auth", "infra-postgres", "test"]));
  expect(commands.find((argv) => argv.includes("sh"))).toEqual(expect.arrayContaining(["docker", "exec", "infra-postgres", "test", "dh_shop", "dh_shop__fix_auth"]));

  expect(projects.get(plan.id)).toMatchObject({ root: plan.path, components: [{ cwd: plan.path, url: plan.url, compose: { projectName: "devhub-shop--fix-auth" } }] });
  expect(executed).toEqual(["start shop--fix-auth"]);
  expect(readFileSync(join(infraDir, "data/caddy/sites/devhub.caddy"), "utf8")).toContain("http://fix-auth.shop.localhost {");
  await expect(worktrees.plan(plan.id, "other")).rejects.toThrow("cannot have worktrees");
});

test("only a project DevHub runs in Docker can get a worktree, on a valid branch", async () => {
  const { projects, worktrees } = fixture();
  await expect(worktrees.plan("shop", "-x")).rejects.toThrow("Invalid branch name");
  await expect(worktrees.plan("shop", "a..b")).rejects.toThrow("Invalid branch name");
  projects.get("shop")!.components[0]!.compose!.managed = undefined;
  await expect(worktrees.plan("shop", "fix")).rejects.toThrow("Docker");
});

test("removing refuses uncommitted work, then cleans everything but the branch and the dependencies volume", async () => {
  const { root, records, projects, commands, worktrees } = fixture();
  const plan = await worktrees.plan("shop", "fix");
  await worktrees.add(plan);
  writeFileSync(join(plan.path, "draft.txt"), "wip\n");
  await expect(worktrees.remove(plan.id)).rejects.toThrow("uncommitted");
  expect(await worktrees.remove(plan.id, true)).toEqual({ removed: plan.id, keptVolume: "devhub-shop--fix_node_modules" });
  expect(commands.some((argv) => argv.includes("down") && !argv.includes("-v") && !argv.includes("--volumes"))).toBe(true);
  expect(commands.some((argv) => argv.includes('DROP DATABASE IF EXISTS "dh_shop__fix" WITH (FORCE)'))).toBe(true);
  expect(existsSync(plan.path)).toBe(false);
  expect(records.has(plan.id) || projects.has(plan.id)).toBe(false);
  expect(git(root, "branch", "--list", "fix").stdout.toString()).toContain("fix");
});

test("the sweep stops a worktree idle for a day, and only that one", async () => {
  const old = new Date(Date.now() - 25 * 3600_000).toISOString();
  const log = [{ action: "start", state: "succeeded", updatedAt: old } as Operation];
  const { records, executed, worktrees } = fixture(log);
  records.set("shop--a", { id: "shop--a", parent: "shop", activeAt: old });
  expect(await worktrees.sweep()).toEqual({ stopped: ["shop--a"], removed: [] });
  expect(executed).toEqual(["stop shop--a"]);
  records.set("shop--a", { id: "shop--a", parent: "shop", activeAt: new Date().toISOString() });
  expect((await worktrees.sweep()).stopped).toEqual([]);
  log[0] = { action: "stop", state: "succeeded", updatedAt: old } as Operation;
  records.set("shop--a", { id: "shop--a", parent: "shop", activeAt: old });
  expect((await worktrees.sweep()).stopped).toEqual([]);
});

test("exec runs in the app container of the project, never on the host", async () => {
  const { commands, worktrees } = fixture();
  await worktrees.exec("shop", "bun test");
  expect(commands.at(-1)).toEqual(expect.arrayContaining(["docker", "compose", "-p", "devhub-shop", "exec", "-T", "app", "sh", "-c", "bun test"]));
  await expect(worktrees.exec("shop", " ")).rejects.toThrow("command");
});

test("Caddy gets one loopback site per project with a local URL", () => {
  const project = (id: string, url?: string) => ({ id, components: [{ url }] }) as unknown as Project;
  const sites = proxySites([project("shop", "http://127.0.0.1:4100"), project("shop--fix", "http://127.0.0.1:4101"), project("db_tool"), project("remote", "http://10.0.0.2:80")], [{ id: "shop--fix", parent: "shop", slug: "fix" } as never]);
  expect(sites).toEqual([{ host: "shop.localhost", upstream: "127.0.0.1:4100" }, { host: "fix.shop.localhost", upstream: "127.0.0.1:4101" }]);
  expect(renderSites(sites)).toContain("http://shop.localhost {\n\tbind 127.0.0.1\n\treverse_proxy 127.0.0.1:4100\n}\n");
});

test("a port taken by a parallel add moves the worktree to the next free one", async () => {
  const { conflicts, worktrees } = fixture();
  const plan = await worktrees.plan("shop", "fix");
  conflicts.left = 1;
  expect((await worktrees.add(plan)).url).toBe("http://127.0.0.1:4102");
});

test("a MySQL or MariaDB project gets no worktree, since only Postgres is copied", async () => {
  const { worktrees } = fixture([], "MYSQL_URL=mysql://dh_shop:x@infra-mysql:3306/dh_shop\n");
  await expect(worktrees.plan("shop", "fix")).rejects.toThrow("Postgres databases only");
  const manual = fixture([], "DATABASE_URL=mysql://u:p@infra-mysql:3306/other\n");
  await expect(manual.worktrees.plan("shop", "fix")).rejects.toThrow("Postgres databases only");
});

test("removing frees the project network, and prunes Git when the folder is already gone", async () => {
  const { root, commands, worktrees } = fixture();
  const plan = await worktrees.plan("shop", "gone");
  await worktrees.add(plan);
  rmSync(plan.path, { recursive: true, force: true });
  await worktrees.remove(plan.id);
  const network = commands.find((argv) => argv[1] === "network" && argv[2] === "rm")!;
  expect(network[3]).toStartWith("devhub-shop--gone-");
  expect(commands).toContainEqual(["docker", "network", "disconnect", network[3]!, "infra-postgres"]);
  expect(git(root, "worktree", "list").stdout.toString()).not.toContain("gone");
});
