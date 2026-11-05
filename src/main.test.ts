import { expect, test } from "bun:test";
import { join } from "node:path";
import { listen, LISTEN_HOST, stateDirectory, parseServeOptions, composeServices, type ManagerModules, superviseDev } from "./main";
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
  expect(parseServeOptions(["--dev", "--port", "8041"])).toEqual({ port: 8041, devOrigin: "http://localhost:5175" });
});

test("composition injects only the guarded executor into privileged modules", async () => {
  const runners: import("./contracts").Executor[] = [];
  class Catalog { assertAllowedPath(path: string) { return path; } }
  class Tool { constructor(options: {run: import("./contracts").Executor}) { runners.push(options.run); } }
  class Operations {}
  const modules = { Catalog, Runtime: Tool, Discovery: Tool, Operations, Maintenance: Tool, Imports: Tool, Creator: Tool, Versions: Tool } as unknown as ManagerModules;
  let calls = 0;
  composeServices(modules, async () => { calls++; return {code:0,stdout:"",stderr:""}; }, "/fixture/state", "/fixture/infra");
  expect(runners).toHaveLength(6);
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
  expect(dev).toContain("http://localhost:8040/api/v1");
  expect(dev).toContain("http://localhost:5175  served by Vite: run `bun run web:dev` in /opt/devhub");
  expect(serveBanner({ port: 8040, panelBuilt: true, checkout: "/opt/devhub", color: false })).toContain("Panel   http://localhost:8040/");
  expect(serveBanner({ port: 8040, panelBuilt: false, checkout: "/opt/devhub", color: false })).toContain("not built  run `bun run web:build` in /opt/devhub");
  expect(serveBanner({ port: 8040, panelBuilt: true, checkout: "/opt/devhub", color: true })).toContain("\u001b[");
});

test("development mode starts the Vite panel once and reuses a running one", async () => {
  const { startDevPanel, serveBanner } = await import("./main");
  const calls: { argv: string[]; cwd: string; apiPort?: string }[] = [];
  let killed = 0;
  const spawn = (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => { calls.push({ argv, cwd: options.cwd, apiPort: options.env.DEVHUB_API_PORT }); return { exited: new Promise<number>(() => {}), kill: () => { killed += 1; } }; };
  const started = await startDevPanel("http://127.0.0.1:5175", "/opt/devhub", 8041, { probe: async () => false, spawn });
  expect(started.state).toBe("started");
  expect(calls).toEqual([{ argv: [process.execPath, "run", "web:dev", "--port", "5175"], cwd: "/opt/devhub", apiPort: "8041" }]);
  started.stop();
  expect(killed).toBe(1);
  const reused = await startDevPanel("http://127.0.0.1:5175", "/opt/devhub", 8041, { probe: async () => true, spawn });
  expect(reused.state).toBe("reused");
  expect(calls).toHaveLength(1);
  expect(serveBanner({ port: 8040, devOrigin: "http://127.0.0.1:5175", devPanel: "started", panelBuilt: false, checkout: "/opt/devhub", color: false })).toContain("http://localhost:5175  served by Vite, started with the controller");
});

test("a stop signal ends the running command group before the CLI exits", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(join(tmpdir(), "devhub-signal-")), pidFile = join(base, "member.pid"), members: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    mkdirSync(join(base, "bin"));
    writeFileSync(join(base, "bin", "docker"), `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}.tmp\nmv ${pidFile}.tmp ${pidFile}\nwait\n`, { mode: 0o700 });
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      rmSync(pidFile, { force: true });
      const cli = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "main.ts"), "maintenance", "inventory"], { cwd: base, env: { ...process.env, PATH: `${join(base, "bin")}:${process.env.PATH}`, XDG_STATE_HOME: join(base, "state") }, stdout: "ignore", stderr: "ignore" });
      while (!existsSync(pidFile)) await Bun.sleep(10);
      const member = Number(readFileSync(pidFile, "utf8")); members.push(member);
      cli.kill(signal);
      const exited = await cli.exited;
      expect(alive(member)).toBe(false);
      expect(exited).toBe(code);
      expect(cli.signalCode).toBeNull();
    }
  } finally {
    for (const member of members) if (alive(member)) process.kill(member, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
}, 20_000);

test("serve exits with the stop signal's code without the Vite panel", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(join(tmpdir(), "devhub-serve-"));
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = free.port!; free.stop(true);
  try {
    const serve = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "main.ts"), "serve", "--port", String(port)], { cwd: base, env: { ...process.env, XDG_STATE_HOME: join(base, "state") }, stdout: "pipe", stderr: "ignore" });
    await serve.stdout.getReader().read();
    serve.kill("SIGTERM");
    expect(await serve.exited).toBe(143);
    expect(serve.signalCode).toBeNull();
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 20_000);

test("development mode runs a watched API next to Vite and stops both", async () => {
  const calls: string[][] = [], stopped: string[] = [];
  let finish!: (code: number) => void, stop!: () => void, env: Record<string, string | undefined> = {};
  const running = superviseDev("http://localhost:5175", 8040, "/checkout", {
    startPanel: async () => ({ state: "started", stop: () => stopped.push("vite") }),
    spawn: (argv, options) => { calls.push(argv); env = options.env; return { exited: new Promise<number>((done) => { finish = done; }), kill: () => { stopped.push("api"); finish(0); } }; },
    onSignal: (handler) => { stop = handler; },
  });
  await Bun.sleep(0);
  expect(calls[0]!.slice(1)).toEqual(["--watch", "/checkout/src/main.ts", "serve", "--port", "8040", "--dev-origin", "http://localhost:5175"]);
  expect(env.DEVHUB_WATCHED_API).toBe("started");
  stop();
  expect(await running).toBe(0);
  expect(stopped).toContain("api");
  expect(stopped).toContain("vite");
});
