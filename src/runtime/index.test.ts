import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, Executor, Project } from "../contracts";
import { Runtime } from "./index";

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devhub-runtime-")); dirs.push(root);
  const stateDir = join(root, "state"), app = join(root, "app"); mkdirSync(stateDir); mkdirSync(app);
  writeFileSync(join(app, "compose.yml"), "services:\n  web:\n    image: nginx\n");
  const component: Component = { id: "web", name: "Web", kind: "compose", cwd: app, compose: { files: ["compose.yml"], projectName: "sample", profiles: ["local"], services: ["web"] }, dependsOn: [] };
  const project: Project = { id: "sample", name: "Sample", root, components: [component], createdAt: "2026-01-01T00:00:00.000Z" };
  const context = JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]);
  const ps = JSON.stringify([{ ID: "0123456789abcdef", State: "running", Labels: { "com.docker.compose.project": "sample", "com.docker.compose.service": "web", "com.docker.compose.project.working_dir": app, "com.docker.compose.project.config_files": join(app, "compose.yml") } }]);
  const calls: Array<{ argv: string[]; options?: Parameters<Executor>[1] }> = [];
  const run: Executor = async (argv, options) => {
    calls.push({ argv, options });
    if (argv[1] === "context") return { code: 0, stdout: context, stderr: "" };
    if (argv.includes("ps")) return { code: 0, stdout: ps, stderr: "" };
    if (argv.includes("config")) return { code: 0, stdout: JSON.stringify({ services: { web: {} } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new Runtime({ run, stateDir, assertAllowedPath: (path) => path });
  return { root, app, project, component, calls, runtime, run };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Runtime Compose adapter", () => {
  test("starts selected services with the fixed bounded argv sequence", async () => {
    const f = fixture(); await f.runtime.start(f.project, f.component);
    const base = ["docker", "compose", "-p", "sample", `--project-directory=${f.app}`, `--file=${join(f.app, "compose.yml")}`, "--profile=local"];
    expect(f.calls.map((call) => call.argv)).toEqual([
      ["docker", "context", "inspect", "--format", "json"],
      [...base, "ps", "-a", "--format", "json"],
      [...base, "config", "--format", "json", "--no-env-resolution", "web"],
      [...base, "up", "-d", "--no-deps", "web"],
    ]);
    expect(f.calls[0]?.options).toEqual({ timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024 });
    expect(f.calls[3]?.options).toEqual({ timeoutMs: 900_000, maxOutputBytes: 8 * 1024 * 1024 });
  });
  test("stops only the explicit selected services", async () => {
    const f = fixture(); await f.runtime.stop(f.project, f.component);
    expect(f.calls.at(-1)?.argv.slice(-2)).toEqual(["stop", "web"]);
    expect(f.calls.at(-1)?.options).toEqual({ timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
  });
  test("reads bounded logs from selected owned containers", async () => {
    const f = fixture();
    f.run = async (argv, options) => {
      if (argv[1] === "context") return { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]), stderr: "" };
      if (argv.includes("ps")) return { code: 0, stdout: JSON.stringify([{ ID: "0123456789abcdef", State: "running", Labels: { "com.docker.compose.project": "sample", "com.docker.compose.service": "web", "com.docker.compose.project.working_dir": f.app, "com.docker.compose.project.config_files": join(f.app, "compose.yml") } }]), stderr: "" };
      if (argv[1] === "logs") { expect(argv).toEqual(["docker", "logs", "--timestamps", "--tail", "25", "0123456789abcdef"]); expect(options).toEqual({ timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024 }); return { code: 0, stdout: "2026-01-01T00:00:00Z hello\n", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    };
    const runtime = new Runtime({ run: f.run, stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
    const logs = await runtime.logs(f.project, f.component, 25);
    expect(logs).toMatchObject([{ projectId: "sample", componentId: "web", message: "hello" }]);
    expect(logs[0]?.sourceId?.startsWith("2026-01-01T00:00:00Z:")).toBe(true);
  });
  test("associates owned containers and leaves unmatched containers observed only", async () => {
    const f = fixture();
    const records = [
      { ID: "0123456789abcdef", Names: "/owned", Image: "nginx:latest", State: "running", Labels: { "com.docker.compose.project": "sample", "com.docker.compose.service": "web", "com.docker.compose.project.working_dir": f.app, "com.docker.compose.project.config_files": join(f.app, "compose.yml") } },
      { ID: "abcdef0123456789", Names: "/other", Image: "redis:latest", State: "exited", Labels: {} },
    ];
    const runtime = new Runtime({ run: async (argv) => {
      if (argv[1] === "context") return { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]), stderr: "" };
      if (argv[1] === "ps") return { code: 0, stdout: records.map((record) => JSON.stringify(record)).join("\n"), stderr: "" };
      if (argv[1] === "inspect") { expect(argv.slice(2)).toEqual(["0123456789abcdef", "abcdef0123456789"]); return { code: 0, stdout: JSON.stringify([{ Id: "0123456789abcdef", Image: "sha256:" + "a".repeat(64), State: { Status: "running" }, Config: { Image: "nginx:latest" } }, { Id: "abcdef0123456789", Image: "sha256:" + "b".repeat(64), State: { Status: "exited" }, Config: { Image: "redis:latest", Labels: { "com.docker.compose.project": "infra-db", "com.docker.compose.project.working_dir": "/outside/roots" } } }]), stderr: "" }; }
      return { code: 0, stdout: JSON.stringify({ ID: "0123456789abcdef", MemUsage: "2MiB / 1GiB", CPUPerc: "1.2%" }), stderr: "" };
    }, stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
    const inventory = await runtime.inventory([f.project]);
    expect(inventory[0]).toMatchObject({ id: "0123456789abcdef", projectId: "sample", componentId: "web", memoryBytes: 2 * 1024 * 1024, cpuPercent: 1.2 });
    expect(inventory[0]?.imageId).toBe("sha256:" + "a".repeat(64));
    expect(inventory[1]).toMatchObject({ id: "abcdef0123456789", name: "other", composeProject: "infra-db" });
    expect(inventory[1]?.projectId).toBeUndefined(); expect(inventory[1]?.componentId).toBeUndefined();
  });
  test("does not stop containers whose ownership labels do not match", async () => {
    const f = fixture();
    f.run = async (argv) => {
      if (argv[1] === "context") return { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]), stderr: "" };
      if (argv.includes("ps")) return { code: 0, stdout: JSON.stringify([{ ID: "0123456789abcdef", State: "running", Labels: { "com.docker.compose.project": "devhub", "com.docker.compose.service": "web" } }]), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const runtime = new Runtime({ run: f.run, stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
    await expect(runtime.stop(f.project, f.component)).rejects.toThrow("unmatched container");
    expect(f.calls.some(({ argv }) => argv.includes("stop"))).toBe(false);
  });
  test("rejects remote Docker contexts before Compose mutation", async () => {
    const f = fixture();
    const runtime = new Runtime({ run: async (argv) => argv[1] === "context" ? { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: "ssh://remote" } } }]), stderr: "" } : { code: 0, stdout: "", stderr: "" }, stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
    await expect(runtime.start(f.project, f.component)).rejects.toThrow("local Unix socket");
    expect(f.calls).toHaveLength(0);
  });
  test("rejects forbidden Compose controls before any Executor call", async () => {
    const f = fixture(); writeFileSync(join(f.app, ".env"), "# COMPOSE_FILE is only a comment\nAPP_PORT=8080\nCOMPOSE_REMOVE_ORPHANS=1\n");
    const runtime = new Runtime({ run: async () => { throw new Error("must not run"); }, stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
    await expect(runtime.start(f.project, f.component)).rejects.toThrow("COMPOSE_REMOVE_ORPHANS");
  });
  test("refuses recursive remote includes before making any Docker call", async () => {
    const f = fixture();
    writeFileSync(join(f.app, "compose.yml"), "include:\n  - path: nested.yml\nservices:\n  web:\n    image: nginx\n");
    writeFileSync(join(f.app, "nested.yml"), "include:\n  - https://example.invalid/compose.yml\n");
    await expect(f.runtime.start(f.project, f.component)).rejects.toThrow("Remote or unresolved Compose include");
    expect(f.calls).toHaveLength(0);
  });
});

test("unit escaping protects quotes, percent, and backslash, and rejects newline values", async () => {
  const f = fixture();
  const previousRuntime = process.env.XDG_RUNTIME_DIR, previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const userRuntime = join(f.root, "user-runtime"); mkdirSync(userRuntime, { mode: 0o700 }); chmodSync(userRuntime, 0o700);
  process.env.XDG_RUNTIME_DIR = userRuntime; delete process.env.DBUS_SESSION_BUS_ADDRESS;
  try {
    const native: Component = { id: "native", name: '100% "app"', kind: "native", cwd: f.app, argv: ["example", "a\\b", 'say "hi"', "100%"], dependsOn: [] };
    const calls: string[][] = [];
    const runtime = new Runtime({ run: async (argv) => { calls.push(argv); return { code: 0, stdout: argv.includes("show") ? "LoadState=not-found\nFragmentPath=\nDropInPaths=\n" : "", stderr: "" }; }, resolveExecutable: () => "/usr/bin/example", stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
    await runtime.start({ ...f.project, components: [native] }, native);
    const unitPath = join(f.root, "state", "units", `devhub-${(await import("node:crypto")).createHash("sha256").update("sample\0native").digest("hex").slice(0, 20)}.service`);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain('Description=100%% "app"');
    expect(unit).toContain('ExecStart="/usr/bin/example" "a\\\\b" "say \\"hi\\"" "100%%"');
    expect(calls.some((argv) => argv[0] === "systemctl" && argv.includes("--user"))).toBe(true);
    const bad: Component = { ...native, argv: ["example", "bad\narg"] };
    const rejecting = new Runtime({ run: async () => ({ code: 0, stdout: "", stderr: "" }), resolveExecutable: () => "/usr/bin/example", stateDir: join(f.root, "state2"), assertAllowedPath: (path) => path });
    await expect(rejecting.start({ ...f.project, components: [bad] }, bad)).rejects.toThrow("Newlines and NUL");
  } finally {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previousRuntime;
    if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
  }
});

test("comma-joined Compose labels keep multi-file config paths intact", async () => {
  const f = fixture();
  writeFileSync(join(f.app, "compose.override.yml"), "services:\n  web:\n    environment:\n      A: b\n");
  const component: Component = { ...f.component, compose: { ...f.component.compose!, files: ["compose.yml", "compose.override.yml"] } };
  const files = `${join(f.app, "compose.yml")},${join(f.app, "compose.override.yml")}`;
  const runtime = new Runtime({ run: async (argv) => {
    if (argv[1] === "context") return { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]), stderr: "" };
    if (argv.includes("ps")) return { code: 0, stdout: JSON.stringify({ ID: "0123456789abcdef", State: "running", Labels: `com.docker.compose.project=sample,com.docker.compose.project.config_files=${files},com.docker.compose.project.working_dir=${f.app},com.docker.compose.service=web` }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }, stateDir: join(f.root, "state"), assertAllowedPath: (path) => path });
  expect(await runtime.check({ ...f.project, components: [component] }, component)).toMatchObject({ state: "running", ready: true });
});
