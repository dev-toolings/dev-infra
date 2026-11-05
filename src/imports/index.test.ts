import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DevHubError, type CatalogPort, type DiscoveryPort, type Executor, type OperationsPort, type Project, type ProjectInput } from "../contracts";
import { Imports } from "./index";
import { projectNetwork } from "../services";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(files: Record<string, string>, stacks = ["node", "hono"], composeFiles: string[] = [], projects: Array<Pick<Project, "id" | "root">> = []) {
  const base = mkdtempSync(join(tmpdir(), "devhub-import-")); dirs.push(base);
  const root = join(base, "shop"), stateDir = join(base, "state");
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const created: ProjectInput[] = [], commands: string[][] = [];
  const catalog = {
    assertAllowedPath: (path: string) => path,
    getProject: () => { throw new DevHubError("missing", "not_found", 404); },
    listProjects: () => projects,
    createProject: (input: ProjectInput) => { created.push(input); return { ...input, createdAt: "now" } as Project; },
  } as unknown as CatalogPort;
  const discovery = { inspect: async () => ({ stacks, composeFiles }), freePort: async () => 4100 } as unknown as DiscoveryPort;
  const operations = { execute: async () => ({ state: "succeeded" }) } as unknown as OperationsPort;
  const run: Executor = async (argv) => { commands.push(argv); return { code: 0, stdout: "", stderr: "" }; };
  return { root, stateDir, created, commands, imports: new Imports({ catalog, discovery, operations, run, stateDir, infraDir: "/infra" }) };
}
const hono = (extra: object = {}) => JSON.stringify({ scripts: { dev: "bun run --hot src/index.ts" }, dependencies: { hono: "^4", ...extra } });

test("the plan reads a hardcoded port and lists the variables only the operator can fill in", async () => {
  const { root, imports } = fixture({ "package.json": hono(), "src/index.js": "serve({ port: 8787 })", ".env.example": "DATABASE_URL=\nAPP_TITLE=Shop\nAPI_KEY=\n" });
  const plan = await imports.plan({ path: root });
  expect(plan.containerPort).toBe(8787);
  expect(plan.database).toBe("dh_shop");
  expect(plan.infra).toEqual(["infra-postgres"]);
  expect(plan.env.APP_TITLE).toBe("Shop");
  expect(plan.missing).toEqual(["API_KEY"]);
});

test("the project lockfile selects the toolchain and is never rewritten", async () => {
  const npm = fixture({ "package.json": hono(), "package-lock.json": "{}" });
  expect(await npm.imports.plan({ path: npm.root })).toMatchObject({ image: expect.stringContaining("node:"), install: "npm ci", dev: "npm run dev" });
  const bun = fixture({ "package.json": hono(), "bun.lock": "{}" });
  expect((await bun.imports.plan({ path: bun.root })).install).toBe("bun install --frozen-lockfile");
  const pnpm = fixture({ "package.json": hono(), "pnpm-lock.yaml": "" });
  await expect(pnpm.imports.plan({ path: pnpm.root })).rejects.toThrow("pnpm-lock.yaml");
});

test("only Hono projects without their own Compose file are accepted", async () => {
  const other = fixture({ "package.json": hono() }, ["node"]);
  await expect(other.imports.plan({ path: other.root })).rejects.toThrow("Hono");
  const compose = fixture({ "package.json": hono() }, ["node", "hono"], ["compose.yml"]);
  await expect(compose.imports.plan({ path: compose.root })).rejects.toThrow("project add");
});

test("a lockfile over the read limit still selects its toolchain", async () => {
  const { root, imports } = fixture({ "package.json": hono(), "package-lock.json": "x".repeat(300 * 1024) });
  expect((await imports.plan({ path: root })).install).toBe("npm ci");
});

test("the plan ignores a client port and refuses servers that ignore PORT", async () => {
  const client = fixture({ "package.json": hono(), "src/index.ts": "db({ port: 5432 });\nconst port = 8787;" });
  expect((await client.imports.plan({ path: client.root })).containerPort).toBe(8787);
  const worker = fixture({ "package.json": JSON.stringify({ scripts: { dev: "wrangler dev" }, dependencies: { hono: "^4" } }) });
  await expect(worker.imports.plan({ path: worker.root })).rejects.toThrow("wrangler");
});

test("the plan refuses what registration would refuse after provisioning", async () => {
  const reserved = fixture({ "package.json": hono() });
  await expect(reserved.imports.plan({ path: reserved.root, id: "infra" })).rejects.toThrow("cannot be infra");
  const taken = fixture({ "package.json": hono() }, ["node", "hono"], [], [{ id: "my_shop", root: "/elsewhere" }]);
  await expect(taken.imports.plan({ path: taken.root, id: "my-shop" })).rejects.toThrow("share the database");
  const same = fixture({ "package.json": hono() });
  const again = fixture({ "package.json": hono() }, ["node", "hono"], [], [{ id: "other", root: same.root }]);
  await expect(again.imports.plan({ path: same.root })).rejects.toThrow("already registered as other");
});

test("apply generates a confined stack outside the project and keeps its secrets on re-import", async () => {
  const { root, stateDir, created, commands, imports } = fixture({ "package.json": hono({ postgres: "^3" }), "bun.lock": "{}" });
  await imports.apply(await imports.plan({ path: root }));
  const dir = join(stateDir, "imports", "shop");
  const stack = parse(readFileSync(join(dir, "compose.yml"), "utf8"));
  expect(stack.services.app).toMatchObject({ cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], ports: ["127.0.0.1:4100:3000"] });
  expect(stack.services.app.volumes).toEqual([`${root}:/app`, "node_modules:/app/node_modules", `${join(dir, "build/entry.sh")}:/devhub/entry.sh:ro`]);
  expect(stack.services.app.user).toMatch(/^\d+:\d+$/);
  expect(readFileSync(join(dir, "build/Dockerfile"), "utf8")).toContain("FROM oven/bun");
  expect(stack.networks.default).toEqual({ name: projectNetwork("shop", ["infra-postgres"]), external: true });
  expect(created[0]!.components[0]!.compose!.managed).toEqual({ infra: ["infra-postgres"] });
  expect(statSync(join(dir, "app.env")).mode & 0o777).toBe(0o600);
  const password = (text: string) => /DEVHUB_DB_PASSWORD=(\w+)/.exec(text)![1];
  const first = password(readFileSync(join(dir, "app.env"), "utf8"));
  await imports.apply(await imports.plan({ path: root }));
  expect(password(readFileSync(join(dir, "app.env"), "utf8"))).toBe(first);
  expect(commands[1]!.slice(-3)).toEqual(["provision", "dh_shop", join(dir, "app.env")]);
  expect(commands.flat().join(" ")).not.toContain(first!);
});

test("services linked at creation replace what an earlier project left in the env file", async () => {
  const { root, stateDir, imports } = fixture({ "package.json": hono(), "bun.lock": "{}" });
  const plan = await imports.plan({ path: root });
  await imports.prepare({ ...plan, env: { ...plan.env, KEPT: "operator" }, linkedEnv: { MYSQL_URL: "mysql://old" } });
  await imports.prepare({ ...plan, linkedEnv: { MYSQL_URL: "mysql://new" } });
  const env = readFileSync(join(stateDir, "imports", "shop", "app.env"), "utf8");
  expect(env).toContain("MYSQL_URL=mysql://new");
  expect(env).toContain("KEPT=operator");
});

test("a project with its own Dockerfile builds from its root and stays confined by the Compose file", async () => {
  const { root, stateDir, imports } = fixture({ "package.json": hono(), "bun.lock": "{}" });
  const plan = await imports.plan({ path: root });
  await imports.prepare({ ...plan, ownDockerfile: true });
  const dir = join(stateDir, "imports", "shop");
  const { app } = parse(readFileSync(join(dir, "compose.yml"), "utf8")).services;
  expect(app.build.context).toBe(root);
  expect(app).toMatchObject({ cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], entrypoint: ["sh", "/devhub/entry.sh"] });
  expect(existsSync(join(dir, "build/Dockerfile"))).toBe(false);
});
