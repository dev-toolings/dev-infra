// Real-module composition: Catalog, Discovery, Runtime, Operations, Maintenance and the API wired by
// composeServices, with only the Executor (and Runtime's fetch) replaced by a scripted local fake.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeServices, type ManagerModules } from "./main";
import { Catalog } from "./catalog/index";
import { Discovery } from "./discovery/index";
import { Runtime } from "./runtime/index";
import { Operations } from "./operations/index";
import { createApp } from "./api/index";
import type { AppServices, ExecResult, MaintenancePort } from "./contracts";

const base = mkdtempSync(join(tmpdir(), "devhub-integration-"));
const root = join(base, "projects"), shop = join(root, "shop"), backend = join(shop, "backend"), frontend = join(shop, "frontend");
const state = join(base, "state"), userRuntime = join(base, "user-runtime");
const containerId = "a".repeat(64);
const calls: string[][] = [];
let started = false;
let services: AppServices;
const previous = { runtime: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS };

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const composeLabels = () => ({
  "com.docker.compose.project": "shop", "com.docker.compose.service": "php",
  "com.docker.compose.project.working_dir": backend, "com.docker.compose.project.config_files": join(backend, "compose.yml"),
});
async function fakeExecutor(argv: string[]): Promise<ExecResult> {
  calls.push(argv);
  const line = argv.join(" ");
  if (line === "docker context inspect --format json") return ok(JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]));
  if (line.startsWith("docker ps -a")) return ok(JSON.stringify({ ID: containerId, Names: "shop-php-1", Image: "php:8.3-fpm", State: started ? "running" : "exited", Labels: "" }));
  if (argv[0] === "docker" && argv[1] === "inspect") return ok(JSON.stringify([{ Id: containerId, Image: `sha256:${"b".repeat(64)}`, State: { Status: started ? "running" : "exited" }, Config: { Image: "php:8.3-fpm", Labels: composeLabels() } }]));
  if (argv[0] === "docker" && argv[1] === "stats") return ok(JSON.stringify({ ID: containerId, MemUsage: "10MiB / 1GiB", CPUPerc: "0.5%" }));
  if (line === "ss -H -ltn") return ok("LISTEN 0 4096 127.0.0.1:5173 0.0.0.0:*\n");
  if (argv[0] === "docker" && argv[1] === "compose") {
    if (argv.includes("ps")) return ok(JSON.stringify([{ ID: containerId, State: started ? "running" : "exited", Labels: composeLabels() }]));
    if (argv.includes("config")) return ok(JSON.stringify({ services: { php: {} } }));
    if (argv.includes("up")) { started = true; return ok(); }
    if (argv.includes("stop")) { started = false; return ok(); }
  }
  if (argv[0] === "docker" && argv[1] === "logs") return ok("2026-10-29T10:00:00.000000000Z backend ready token=hunter2secret\n");
  if (argv[0] === "systemctl" && argv.includes("show")) {
    const unitPath = join(state, "units", argv[3]!);
    return argv.some((arg) => arg.includes("ActiveState")) ? ok("ActiveState=active\nSubState=running\n") : ok(started ? `LoadState=loaded\nFragmentPath=${unitPath}\nDropInPaths=\n` : "LoadState=not-found\nFragmentPath=\nDropInPaths=\n");
  }
  if (argv[0] === "systemctl") return ok();
  if (argv[0] === "journalctl") return ok(`${JSON.stringify({ __CURSOR: "s=1", __REALTIME_TIMESTAMP: "1793300000000000", MESSAGE: "vite ready" })}\n`);
  return { code: 127, stdout: "", stderr: `unexpected ${argv[0]}` };
}

class PendingMaintenance implements MaintenancePort {
  constructor(_options: unknown) {}
  async scan(): Promise<never> { throw new Error("not exercised"); }
  listScans() { return []; }
  getScan(): never { throw new Error("not exercised"); }
  async preview(): Promise<never> { throw new Error("not exercised"); }
  async apply(): Promise<never> { throw new Error("not exercised"); }
  async validate(): Promise<never> { throw new Error("not exercised"); }
  async activate(): Promise<never> { throw new Error("not exercised"); }
  listChanges() { return []; }
}

beforeAll(() => {
  for (const dir of [backend, frontend, join(shop, ".git")]) mkdirSync(dir, { recursive: true });
  mkdirSync(userRuntime, { mode: 0o700 }); chmodSync(userRuntime, 0o700);
  process.env.XDG_RUNTIME_DIR = userRuntime; delete process.env.DBUS_SESSION_BUS_ADDRESS;
  writeFileSync(join(backend, "composer.json"), JSON.stringify({ require: { "symfony/framework-bundle": "^7.0" } }));
  writeFileSync(join(backend, "compose.yml"), "services:\n  php:\n    image: php:8.3-fpm\n");
  writeFileSync(join(backend, ".env"), "APP_SECRET=do-not-leak\nCOMPOSE_PROJECT_NAME=shop\n");
  writeFileSync(join(frontend, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^7.0.0" } }));
  const modules = { Catalog, Discovery, Runtime, Operations, Maintenance: PendingMaintenance } as unknown as ManagerModules;
  services = composeServices(modules, fakeExecutor, state, resolve(import.meta.dir, ".."));
  services.catalog.addRoot(root, "Projects");
});
afterAll(() => {
  services?.catalog.close();
  if (previous.runtime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous.runtime;
  if (previous.bus !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = previous.bus;
  rmSync(base, { recursive: true, force: true });
});

test("registers an existing Symfony backend and Vite frontend in place, then runs them", async () => {
  const detections = await services.discovery.scan(root, 2);
  expect(detections.map((item) => item.path)).toContain(shop);

  const plan = await services.discovery.preview({ path: shop, name: "Shop", preset: "symfony-docker" });
  const compose = plan.project.components.find((component) => component.kind === "compose")!;
  const vite = plan.project.components.find((component) => component.kind === "native")!;
  expect(compose.compose).toMatchObject({ projectName: "shop", services: ["php"], files: ["compose.yml"] });
  expect(vite.url).toBe("http://127.0.0.1:5174");
  expect(plan.files).toEqual([]);
  expect(JSON.stringify(plan)).not.toContain("do-not-leak");

  const project = await services.discovery.apply(plan.id);
  expect(services.catalog.getProject(project.id).root).toBe(shop);

  const operation = await services.operations.execute(project.id, "start");
  expect(operation.state).toBe("succeeded");
  expect(calls.some((argv) => argv.join(" ").includes("up -d --no-deps php"))).toBe(true);
  expect(calls.some((argv) => argv[0] === "systemctl" && argv.includes("start"))).toBe(true);
  expect(calls.some((argv) => ["down", "rm", "prune", "-v"].some((word) => argv[0] === "docker" && argv.includes(word)))).toBe(false);

  const status = await services.operations.status(project.id);
  expect(status.components.every((component) => component.state === "running")).toBe(true);

  const logs = await services.operations.logs(project.id);
  expect(logs.map((entry) => entry.message).join("\n")).toContain("vite ready");
  expect(logs.map((entry) => entry.message).join("\n")).not.toContain("hunter2secret");

  const inventory = await services.operations.inventory();
  expect(inventory[0]).toMatchObject({ id: containerId, projectId: project.id, componentId: compose.id, imageId: `sha256:${"b".repeat(64)}` });
});

test("the API refuses unauthenticated mutations and serves the same project after pairing", async () => {
  const code = "integration-pairing-code-" + "z".repeat(40);
  const app = createApp(services, { stateDir: state, pairingCode: code, origins: ["http://127.0.0.1:8040"], hostnames: ["127.0.0.1:8040"] });
  const headers = { host: "127.0.0.1:8040", origin: "http://127.0.0.1:8040", "content-type": "application/json" };
  const before = calls.length;
  for (const [path, body] of [["/api/v1/projects/shop/operations", { action: "stop" }], ["/api/v1/projects", { planId: "x" }], ["/api/v1/scans", { imageId: containerId }]] as const) {
    const response = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(401);
  }
  expect((await app.request("/api/v1/projects/shop", { method: "DELETE", headers })).status).toBe(401);
  expect(calls.length).toBe(before);

  const pair = await app.request("/api/v1/pair", { method: "POST", headers, body: JSON.stringify({ code }) });
  const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;
  const projects = await (await app.request("/api/v1/projects", { headers: { ...headers, cookie } })).json() as { data: Array<{ id: string; components: Array<Record<string, unknown>> }> };
  expect(projects.data[0]!.id).toBe("shop");
  expect(JSON.stringify(projects)).not.toContain("argv");

  const submitted = await app.request("/api/v1/projects/shop/operations", { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ action: "stop" }) });
  expect(submitted.status).toBe(202);
  const { data } = await submitted.json() as { data: { id: string } };
  let opState = "queued";
  for (let attempt = 0; attempt < 100 && (opState === "queued" || opState === "running"); attempt++) {
    await Bun.sleep(10);
    opState = ((await (await app.request(`/api/v1/operations/${data.id}`, { headers: { ...headers, cookie } })).json()) as { data: { state: string } }).data.state;
  }
  expect(opState).toBe("succeeded");
  expect(calls.some((argv) => argv.join(" ").includes("stop php"))).toBe(true);
});
