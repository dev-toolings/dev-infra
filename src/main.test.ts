import { expect, test } from "bun:test";
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
