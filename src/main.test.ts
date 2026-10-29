import { expect, test } from "bun:test";
import { join } from "node:path";
import { listen, LISTEN_HOST, stateDirectory, parseServeOptions, composeServices, type ManagerModules } from "./main";
test("controller explicitly binds loopback and rejects invalid ports", () => {
  let binding: { hostname: string; port: number } | undefined;
  listen(() => new Response("ok"), 8040, (options) => { binding = options; return {}; });
  expect(binding).toMatchObject({ hostname: "127.0.0.1", port: 8040 });
  expect(LISTEN_HOST).toBe("127.0.0.1");
  expect(() => listen(() => new Response(), 80, () => ({}))).toThrow();
});

test("relative XDG state roots are ignored", () => {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "relative-state";
  try { expect(stateDirectory()).toBe(`${require("node:os").homedir()}/.local/state/devhub`); }
  finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; }
});

test("Vite origin access is opt-in and rejects non-loopback origins", () => {
  expect(parseServeOptions([])).toEqual({ port: 8040, devOrigin: undefined });
  expect(parseServeOptions(["--dev-origin", "http://127.0.0.1:5175"])).toEqual({ port: 8040, devOrigin: "http://127.0.0.1:5175" });
  expect(() => parseServeOptions(["--dev-origin", "http://example.com:5175"])).toThrow();
});

test("composition injects only the guarded executor into privileged modules", async () => {
  const runners: import("./contracts").Executor[] = [];
  class Catalog { assertAllowedPath(path: string) { return path; } }
  class Tool { constructor(options: {run: import("./contracts").Executor}) { runners.push(options.run); } }
  class Operations {}
  const modules = { Catalog, Runtime: Tool, Discovery: Tool, Operations, Maintenance: Tool } as unknown as ManagerModules;
  let calls = 0;
  composeServices(modules, async () => { calls++; return {code:0,stdout:"",stderr:""}; }, "/fixture/state", "/fixture/infra");
  expect(runners).toHaveLength(3);
  for (const run of runners) {
    await expect(run(["git", "status"])).rejects.toThrow("gitRun");
    await expect(run(["docker", "compose", "down", "-v"])).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("panel assets stay inside the built directory and API paths go to the app", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { staticAsset, controllerFetch } = await import("./main");
  const base = mkdtempSync(join(tmpdir(), "devhub-static-"));
  try {
    const dist = join(base, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<main>panel</main>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(base, "secret.txt"), "private");
    symlinkSync(join(base, "secret.txt"), join(dist, "assets", "leak.js"));
    expect(await staticAsset(dist, "/")!.text()).toContain("panel");
    expect(await staticAsset(dist, "/projects/demo")!.text()).toContain("panel");
    expect(staticAsset(dist, "/assets/app.js")!.headers.get("content-type")).toBe("text/javascript");
    expect(staticAsset(dist, "/../secret.txt")!.status).toBe(404);
    expect(staticAsset(dist, "/%2e%2e/secret.txt")!.status).toBe(404);
    expect(staticAsset(dist, "/assets/leak.js")!.status).toBe(404);
    expect(staticAsset(join(base, "missing"), "/")).toBeUndefined();
    const fetch = controllerFetch({ fetch: () => new Response("api") }, join(base, "missing"));
    expect(await (await fetch(new Request("http://127.0.0.1:8040/api/v1/session"))).text()).toBe("api");
    expect((await fetch(new Request("http://127.0.0.1:8040/"))).status).toBe(503);
    expect((await fetch(new Request("http://127.0.0.1:8040/", { method: "POST" }))).status).toBe(405);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("help and usage errors return before touching state", async () => {
  const previous = process.env.XDG_STATE_HOME;
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(join(tmpdir(), "devhub-help-"));
  process.env.XDG_STATE_HOME = base;
  const write = process.stdout.write, error = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const { main } = await import("./main");
    expect(await main(["help"])).toBe(0);
    expect(await main(["nonsense"])).toBe(2);
    expect(existsSync(join(base, "devhub"))).toBe(false);
  } finally {
    process.stdout.write = write; process.stderr.write = error;
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test("serve banner names where the panel is in each mode", async () => {
  const { serveBanner } = await import("./main");
  const dev = serveBanner({ port: 8040, devOrigin: "http://127.0.0.1:5175", panelBuilt: false, checkout: "/opt/devhub", color: false });
  expect(dev).toContain("development mode");
  expect(dev).toContain("http://127.0.0.1:8040/api/v1");
  expect(dev).toContain("http://127.0.0.1:5175  served by Vite: run `bun run web:dev` in /opt/devhub");
  expect(serveBanner({ port: 8040, panelBuilt: true, checkout: "/opt/devhub", color: false })).toContain("Panel   http://127.0.0.1:8040/");
  expect(serveBanner({ port: 8040, panelBuilt: false, checkout: "/opt/devhub", color: false })).toContain("not built  run `bun run web:build` in /opt/devhub");
  expect(serveBanner({ port: 8040, panelBuilt: true, checkout: "/opt/devhub", color: true })).toContain("\u001b[");
});
