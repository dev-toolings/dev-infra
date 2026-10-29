import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DevHubError, type Action, type CatalogPort, type ExecResult, type Operation, type OperationClaim, type Project, type ProjectInput, type Root } from "../contracts";
import { Discovery } from "./index";

const dirs: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "devhub-discovery-")); dirs.push(root); return root; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class MemoryCatalog implements CatalogPort {
  roots: Root[] = [];
  projects = new Map<string, Project>();
  records = new Map<string, unknown>();
  failCreate = false;
  listRoots() { return this.roots; }
  addRoot(path: string, label = "") { const root = { id: "root", path: resolve(path), label }; this.roots.push(root); return root; }
  removeRoot(id: string) { this.roots = this.roots.filter((root) => root.id !== id); }
  assertAllowedPath(path: string, mustExist = true) {
    const resolved = resolve(path);
    if (!this.roots.some((root) => resolved === root.path || resolved.startsWith(`${root.path}/`))) throw new DevHubError("Path is outside approved roots", "path_denied", 403);
    if (mustExist && !existsSync(path)) throw new DevHubError("Path does not exist", "path_denied", 404);
    return resolved;
  }
  listProjects() { return [...this.projects.values()]; }
  getProject(id: string) { const project = this.projects.get(id); if (!project) throw new DevHubError("Project not found", "not_found", 404); return project; }
  createProject(input: ProjectInput) { if (this.failCreate) throw new DevHubError("Injected catalog collision", "conflict", 409); if (this.projects.has(input.id)) throw new DevHubError("Project collision", "conflict", 409); const project = { ...structuredClone(input), createdAt: new Date().toISOString() }; this.projects.set(input.id, project); return project; }
  saveProject(input: ProjectInput) { return this.createProject(input); }
  removeProject(id: string) { this.projects.delete(id); }
  claimOperation(_projectId: string, _action: Action, _componentIds: string[]): OperationClaim { throw new Error("unused"); }
  updateOperation(_id: string, _patch: Partial<Pick<Operation, "state" | "error">>): Operation { throw new Error("unused"); }
  getOperation(_id: string): Operation { throw new Error("unused"); }
  listOperations(_projectId?: string): Operation[] { return []; }
  recoverOperations() {}
  putRecord<T>(namespace: string, id: string, value: T) { this.records.set(`${namespace}:${id}`, structuredClone(value)); }
  updateRecord<T>(namespace: string, id: string, update: (current: T | undefined) => T) { const key = `${namespace}:${id}`; const value = update(this.records.get(key) as T | undefined); this.records.set(key, structuredClone(value)); return value; }
  getRecord<T>(namespace: string, id: string) { const value = this.records.get(`${namespace}:${id}`); return value === undefined ? undefined : structuredClone(value) as T; }
  listRecords<T>(namespace: string) { return [...this.records].filter(([key]) => key.startsWith(`${namespace}:`)).map(([, value]) => structuredClone(value) as T); }
  close() {}
}

function response(stdout = "", code = 0): ExecResult { return { code, stdout, stderr: "" }; }
function viteFixture(root: string) {
  const project = join(root, "shop"); mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }));
  return project;
}

test("preview is side effect free and apply registers a Vite component with strict port", async () => {
  const root = fixture(); const path = viteFixture(root); const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const run = async (argv: string[]) => { expect(argv).toEqual(["ss", "-H", "-ltn"]); return response(""); };
  const discovery = new Discovery({ catalog, run });
  const plan = await discovery.preview({ path, name: "Shop", preset: "native" });
  expect(plan.files).toEqual([]);
  expect(catalog.listProjects()).toHaveLength(0);
  expect(readFileSync(join(path, "package.json"), "utf8")).toContain("vite");
  expect(plan.project.components[0]?.argv).toEqual(["bun", "run", "dev", "--", "--port", "5173", "--strictPort"]);
  const project = await discovery.apply(plan.id);
  expect(project.id).toBe("shop");
  expect(project.components[0]?.url).toBe("http://127.0.0.1:5173");
});

test("apply rechecks listener conflicts before registration", async () => {
  const root = fixture(); const path = viteFixture(root); const catalog = new MemoryCatalog(); catalog.addRoot(root);
  let occupied = false;
  const discovery = new Discovery({ catalog, run: async () => response(occupied ? "LISTEN 0 128 127.0.0.1:5173 0.0.0.0:*\n" : "") });
  const plan = await discovery.preview({ path, name: "Shop", preset: "native" }); occupied = true;
  await expect(discovery.apply(plan.id)).rejects.toMatchObject({ code: "port_conflict" });
  expect(catalog.listProjects()).toHaveLength(0);
});

test("scan skips symlinks and dot/dependency subtrees and rejects paths outside approved roots", async () => {
  const root = fixture(); const path = viteFixture(root); const elsewhere = fixture();
  mkdirSync(join(root, "shop", "node_modules")); writeFileSync(join(root, "shop", "node_modules", "package.json"), "{}");
  symlinkSync(elsewhere, join(root, "linked"));
  const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const discovery = new Discovery({ catalog, run: async () => response("") });
  const found = await discovery.scan(root);
  expect(found.map((item) => item.path)).toContain(path);
  expect(found.some((item) => item.path.includes("linked"))).toBe(false);
  await expect(discovery.inspect(elsewhere)).rejects.toMatchObject({ code: "path_denied" });
});

test("monorepo preview groups a Compose PHP backend and native Vite frontend", async () => {
  const root = fixture();
  const backend = join(root, "backend"); const frontend = join(root, "frontend");
  mkdirSync(backend); mkdirSync(frontend);
  writeFileSync(join(root, ".git"), "gitdir: ../shared.git/worktrees/devhub-fixture\n");
  writeFileSync(join(backend, "composer.json"), JSON.stringify({ require: { "symfony/framework-bundle": "^7" } }));
  writeFileSync(join(backend, "compose.yml"), "services:\n  php:\n    image: php:8.3\n");
  writeFileSync(join(frontend, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }));
  const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const discovery = new Discovery({ catalog, run: async (argv) => {
    if (argv[0] === "docker" && argv[1] === "context") return response(JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]));
    if (argv[0] === "docker" && argv[1] === "ps") return response("");
    if (argv[0] === "ss") return response("");
    throw new Error(`Unexpected inspection command: ${argv.join(" ")}`);
  } });
  const detection = await discovery.inspect(root);
  expect(detection.git).toBe("worktree");
  expect(detection.stacks).toContain("symfony");
  expect(detection.stacks).toContain("vite");
  const plan = await discovery.preview({ path: root, name: "Monorepo", preset: "symfony-docker", composeProjectName: "monorepo" });
  expect(plan.project.components.map((component) => [component.kind, component.cwd])).toEqual([["compose", backend], ["native", frontend]]);
});

test("existing target collisions and stale manifests are refused", async () => {
  const root = fixture(); const path = viteFixture(root); const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const discovery = new Discovery({ catalog, run: async () => response("") });
  const plan = await discovery.preview({ path, name: "Shop", preset: "native" });
  writeFileSync(join(path, "package.json"), "{}\n");
  await expect(discovery.apply(plan.id)).rejects.toMatchObject({ code: "stale_plan" });
  expect(catalog.listProjects()).toHaveLength(0);
});

test("Compose inspection rejects remote Docker contexts before listing containers", async () => {
  const root = fixture(); const path = join(root, "backend"); mkdirSync(path);
  writeFileSync(join(path, "compose.yml"), "services:\n  api:\n    image: example/api\n");
  const catalog = new MemoryCatalog(); catalog.addRoot(root); const calls: string[][] = [];
  const discovery = new Discovery({ catalog, run: async (argv) => { calls.push(argv); return response(JSON.stringify([{ Endpoints: { docker: { Host: "ssh://host" } } }])); } });
  await expect(discovery.inspect(path)).rejects.toMatchObject({ code: "unsafe_docker_context" });
  expect(calls).toEqual([["docker", "context", "inspect", "--format", "json"]]);
});

test("project .env Compose controls are rejected without exposing values", async () => {
  const root = fixture(); const path = join(root, "backend"); mkdirSync(path);
  writeFileSync(join(path, "compose.yml"), "services:\n  api:\n    image: example/api\n");
  writeFileSync(join(path, ".env"), "SECRET=value-that-must-not-leak\nCOMPOSE_FILE=private-compose.yml\n");
  const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const discovery = new Discovery({ catalog, run: async () => response("") });
  await expect(discovery.inspect(path)).rejects.toThrow("unsupported Compose control");
  const serialized = JSON.stringify(catalog.listRecords("discovery-plans"));
  expect(serialized).not.toContain("value-that-must-not-leak");
});

test("Vite listener scan must succeed and does not guess when unavailable", async () => {
  const root = fixture(); const path = viteFixture(root); const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const discovery = new Discovery({ catalog, run: async () => response("", 1) });
  await expect(discovery.preview({ path, name: "Shop", preset: "native" })).rejects.toMatchObject({ code: "inspection_unavailable" });
});

test("partial file creation rolls back only files created by this apply after catalog failure", async () => {
  const root = fixture(); const path = viteFixture(root); const catalog = new MemoryCatalog(); catalog.addRoot(root); catalog.failCreate = true;
  const discovery = new Discovery({ catalog, run: async () => response("") });
  const plan = await discovery.preview({ path, name: "Shop", preset: "native" });
  const key = `discovery-plans:${plan.id}`;
  const stored = catalog.records.get(key) as { plan: typeof plan; snapshots: Array<{ path: string; hash: string }> };
  stored.plan.files.push({ path: ".devhub/first.conf", content: "created by plan\n" });
  stored.snapshots.push({ path: join(path, ".devhub", "first.conf"), hash: "absent" });
  catalog.records.set(key, stored);
  await expect(discovery.apply(plan.id)).rejects.toThrow("Injected catalog collision");
  expect(existsSync(join(path, ".devhub"))).toBe(false);
  expect(catalog.listProjects()).toHaveLength(0);
});

test("an existing planned file is refused without modifying it", async () => {
  const root = fixture(); const path = viteFixture(root); const catalog = new MemoryCatalog(); catalog.addRoot(root);
  const discovery = new Discovery({ catalog, run: async () => response("") });
  const plan = await discovery.preview({ path, name: "Shop", preset: "native" });
  const key = `discovery-plans:${plan.id}`;
  const stored = catalog.records.get(key) as { plan: typeof plan; snapshots: Array<{ path: string; hash: string }> };
  stored.plan.files.push({ path: ".devhub/owned.conf", content: "new content\n" });
  stored.snapshots.push({ path: join(path, ".devhub", "owned.conf"), hash: "absent" });
  catalog.records.set(key, stored);
  mkdirSync(join(path, ".devhub")); writeFileSync(join(path, ".devhub", "owned.conf"), "keep me\n");
  await expect(discovery.apply(plan.id)).rejects.toMatchObject({ code: "file_conflict" });
  expect(readFileSync(join(path, ".devhub", "owned.conf"), "utf8")).toBe("keep me\n");
});
