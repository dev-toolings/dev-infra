import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as readline from "node:readline/promises";
import type { AppServices, Component, Project, ProjectInput, SetupInput } from "../contracts";
import { runCli } from "./index";

const component: Component = { id: "web", name: "Web", kind: "native", cwd: "/tmp/project", argv: ["bun", "run", "dev", "ARGV_SENTINEL"], envFiles: ["/tmp/project/.env"], dependsOn: [] };
const project: Project = { id: "shop", name: "Shop", root: "/tmp/project", components: [component], createdAt: "2026-01-01T00:00:00.000Z" };
let output = "";
let errors = "";
const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
afterEach(() => { output = ""; errors = ""; });

function capture(): void {
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errors += String(chunk); return true; }) as typeof process.stderr.write;
}

function fixture() {
  const roots = new Map<string, { id: string; path: string; label: string }>();
  const projects = new Map<string, Project>([[project.id, structuredClone(project)]]);
  const plan = { id: "plan-1", project: { id: "new", name: "New", root: "/tmp/new", components: [component] }, files: [], warnings: [], createdAt: "2026-01-01T00:00:00.000Z" };
  const environment = { id: `ef-${"a".repeat(32)}`, project: "shop", feature: "checkout", observed: "error", operation: { state: "failed", step: "test", error: { code: "test_failed", message: "test did not pass" } } };
  let operationState: "succeeded" | "failed" = "succeeded";
  let scanState: "succeeded" | "failed" = "succeeded";
  const services = {
    catalog: {
      listRoots: () => [...roots.values()],
      addRoot: (path: string, label = path) => { const root = { id: `root-${roots.size + 1}`, path, label }; roots.set(root.id, root); return root; },
      removeRoot: (id: string) => { roots.delete(id); },
      assertAllowedPath: (path: string) => path,
      listProjects: () => [...projects.values()],
      getProject: (id: string) => { const value = projects.get(id); if (!value) throw new Error("Project not found"); return value; },
      createProject: (input: ProjectInput) => { const value = { ...input, createdAt: plan.createdAt }; projects.set(value.id, value); return value; },
      removeProject: (id: string) => { projects.delete(id); },
    },
    discovery: {
      presets: () => [{ id: "native", name: "Native", description: "Local process" }],
      preview: async (input: SetupInput) => ({ ...plan, project: { ...plan.project, id: input.id ?? plan.project.id, name: input.name, root: input.path } }),
      apply: async () => { const value = { ...plan.project, createdAt: plan.createdAt }; projects.set(value.id, value); return value; },
      scan: async () => [], inspect: async () => { throw new Error("unused"); },
    },
    operations: {
      execute: async (id: string, action: string, componentIds: string[]) => ({ id: "op-1", projectId: id, action, componentIds, state: operationState, createdAt: plan.createdAt, updatedAt: plan.createdAt }),
      status: async (id: string) => ({ projectId: id, components: [{ componentId: "web", state: "running", ready: true }] }),
      logs: async () => [{ seq: 1, time: plan.createdAt, projectId: "shop", componentId: "web", stream: "stdout" as const, message: "ready" }],
      inventory: async () => [], submit: () => { throw new Error("unused"); }, getOperation: () => { throw new Error("unused"); }, listOperations: () => [],
    },
    worktrees: { list: () => [], get: () => undefined },
    environments: {
      list: () => [environment], recipes: () => [{ id: "checkout" }], create: async () => environment, status: async () => environment,
      start: async () => environment, stop: async () => environment, destroy: async () => environment, logs: async () => [],
      exec: async () => ({ code: 3, stdout: "", stderr: "command failed" }), test: async () => environment, preview: async () => ({ url: "http://127.0.0.1:4180" }),
      reconcile: async () => [environment], doctor: async () => ({ provider: "docker-compose" }), installTimer: async () => ({ installed: true }),
    },
    maintenance: {
      scan: async (imageId: string) => ({ id: "scan-1", imageId, state: scanState, scannedAt: plan.createdAt, scanner: "fixture", findings: [] }),
      listScans: () => [], getScan: (id: string) => ({ id, imageId: "sha256:local", state: "succeeded" as const, scannedAt: plan.createdAt, scanner: "fixture", findings: [] }), preview: async () => ({ id: "change-1", projectId: "shop", componentId: "web", file: "Dockerfile", sourceHash: "h", original: "FROM old", proposed: "FROM new", replacement: "new", state: "preview" as const, createdAt: plan.createdAt }),
      apply: async () => ({ id: "change-1", projectId: "shop", componentId: "web", file: "Dockerfile", sourceHash: "h", original: "FROM old", proposed: "FROM new", replacement: "new", state: "applied" as const, createdAt: plan.createdAt }),
      validate: async () => ({ id: "change-1", projectId: "shop", componentId: "web", file: "Dockerfile", sourceHash: "h", original: "FROM old", proposed: "FROM new", replacement: "new", state: "validated" as const, createdAt: plan.createdAt }),
      activate: async () => ({ id: "change-1", projectId: "shop", componentId: "web", file: "Dockerfile", sourceHash: "h", original: "FROM old", proposed: "FROM new", replacement: "new", state: "activated" as const, createdAt: plan.createdAt }), listChanges: () => [],
    },
  } as unknown as AppServices;
  return { services, environment, setOperationState: (value: "succeeded" | "failed") => { operationState = value; }, setScanState: (value: "succeeded" | "failed") => { scanState = value; } };
}

const options = { stateDir: "/tmp/state", infraDir: "/tmp/devhub", run: async () => ({ code: 0, stdout: "", stderr: "" }) };

describe("runCli", () => {
  afterEach(() => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  });

  it("handles root add, list, and remove", async () => {
    capture(); const { services } = fixture();
    expect(await runCli(["root", "add", "/tmp/work", "--label", "work"], services, options)).toBe(0);
    expect(await runCli(["root", "list", "--json"], services, options)).toBe(0);
    expect(output).toContain("/tmp/work");
    expect(await runCli(["root", "remove", "root-1"], services, options)).toBe(0);
    expect(await runCli(["root", "list", "--json"], services, options)).toBe(0);
    expect(output.trimEnd().endsWith("[]")).toBe(true);
  });

  it("previews project add without applying and applies only with --apply", async () => {
    capture(); const { services } = fixture();
    expect(await runCli(["project", "add", "--path", "/tmp/new", "--name", "New", "--preset", "native", "--json"], services, options)).toBe(0);
    expect(output).toContain('"preview": true');
    expect(output).not.toContain("ARGV_SENTINEL");
    output = "";
    expect(await runCli(["project", "add", "--path", "/tmp/new", "--name", "New", "--preset", "native", "--apply", "--json"], services, options)).toBe(0);
    expect(output).toContain('"id": "new"');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("returns operation, status, logs, and maintenance results with honest exit codes", async () => {
    capture(); const { services, setOperationState, setScanState } = fixture();
    expect(await runCli(["project", "start", "shop", "--json"], services, options)).toBe(0);
    expect(await runCli(["project", "stop", "shop", "--json"], services, options)).toBe(0);
    expect(await runCli(["project", "restart", "shop", "--json"], services, options)).toBe(0);
    expect(await runCli(["project", "check", "shop", "--json"], services, options)).toBe(0);
    expect(await runCli(["project", "status", "shop", "--json"], services, options)).toBe(0);
    expect(await runCli(["project", "logs", "shop", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "inventory", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "scan", "sha256:local", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "scans", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "scans", "scan-1", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "changes", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "preview", "--project", "shop", "--component", "web", "--file", "Dockerfile", "--replacement", "new", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "apply", "change-1", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "validate", "change-1", "--json"], services, options)).toBe(0);
    expect(await runCli(["maintenance", "activate", "change-1", "--json"], services, options)).toBe(0);
    expect(output).not.toContain("original");
    setOperationState("failed");
    expect(await runCli(["project", "start", "shop"], services, options)).toBe(1);
    setScanState("failed");
    expect(await runCli(["maintenance", "scan", "sha256:bad"], services, options)).toBe(1);
  });

  it("returns versioned environment data and preserves failed create identity", async () => {
    capture(); const { services, environment } = fixture();
    expect(await runCli(["env", "create", "shop", "checkout", "--json"], services, options)).toBe(1);
    const response = JSON.parse(output);
    expect(response).toMatchObject({ version: 1, data: { id: environment.id, operation: { state: "failed", error: { code: "test_failed" } } } });
    output = "";
    expect(await runCli(["env", "exec", environment.id, "api", "--json", "--", "false"], services, options)).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ version: 1, data: { code: 3, stderr: "command failed" } });
  });

  it("returns a human-readable error and nonzero for invalid commands", async () => {
    capture(); const { services } = fixture();
    expect(await runCli(["root", "missing"], services, options)).toBe(1);
    expect(errors).toContain("CLI usage error");
  });

  it("omits component argv and environment file values from JSON output", async () => {
    capture(); const { services } = fixture();
    expect(await runCli(["project", "show", "shop", "--json"], services, options)).toBe(0);
    expect(output).not.toContain("argv");
    expect(output).not.toContain("ARGV_SENTINEL");
    expect(output).not.toContain("envFiles");
  });

  it("keeps every entry, level and character of machine-readable output", async () => {
    capture(); const { services } = fixture();
    const long = "word ".repeat(2000).trim();
    let nested: unknown = "leaf";
    for (let level = 0; level < 8; level += 1) nested = { child: nested };
    const longKey = "k".repeat(100);
    const projects = Array.from({ length: 100 }, (_, index) => ({ ...project, id: `p${index}`, name: index === 99 ? long : `P${index}` }));
    services.catalog.listProjects = () => projects;
    expect(await runCli(["project", "list", "--json"], services, options)).toBe(0);
    const listed = JSON.parse(output) as Array<{ id: string; name: string }>;
    expect(listed.map((item) => item.id)).toEqual(projects.map((item) => item.id));
    expect(listed[99]!.name).toBe(long);
    output = "";
    services.discovery.presets = () => [{ nested, [longKey]: 1 }] as unknown as ReturnType<AppServices["discovery"]["presets"]>;
    expect(await runCli(["presets", "--json"], services, options)).toBe(0);
    expect(JSON.parse(output)).toEqual([{ nested, [longKey]: 1 }]);
    expect(output).not.toContain("[truncated]");
    expect(output).not.toContain("[max-depth]");
  });

  it("still redacts secrets past the log budgets in machine-readable output", async () => {
    capture(); const { services } = fixture();
    const entry = { seq: 1, time: "2026-01-01T00:00:00.000Z", projectId: "shop", componentId: "web", stream: "stdout" as const };
    const secrets = "password=hunter2 https://alice:pw@example.test/p?token=query-secret Authorization: Bearer abc123 dev@example.test";
    const message = `${"word ".repeat(2000)}${secrets} mode=dev`;
    const entries = [...Array.from({ length: 99 }, (_, index) => ({ ...entry, seq: index + 1, message: "ready" })), { ...entry, seq: 100, message }];
    services.operations.logs = async () => entries as Awaited<ReturnType<AppServices["operations"]["logs"]>>;
    expect(await runCli(["project", "logs", "shop", "--json"], services, options)).toBe(0);
    const logged = JSON.parse(output) as Array<{ message: string }>;
    expect(logged).toHaveLength(100);
    for (const secret of ["hunter2", "alice:pw", "query-secret", "abc123", "dev@example.test"]) expect(output).not.toContain(secret);
    expect(logged[99]!.message.endsWith("mode=dev")).toBe(true);
    output = "";
    let nested: unknown = { apiKey: "deep-secret" };
    for (let level = 0; level < 8; level += 1) nested = { child: nested };
    services.discovery.presets = () => [...Array.from({ length: 80 }, (_, id) => ({ id })), nested] as unknown as ReturnType<AppServices["discovery"]["presets"]>;
    expect(await runCli(["presets", "--json"], services, options)).toBe(0);
    expect(output).toContain('"apiKey": "[redacted]"');
    expect(output).not.toContain("deep-secret");
  });

  it("prints the grouped project preview without --apply and the summary with it", async () => {
    capture(); const { services } = fixture();
    services.discovery.scan = async () => [{ name: "New", path: "/tmp/new", components: [component] }] as Awaited<ReturnType<AppServices["discovery"]["scan"]>>;
    const prompt = spyOn(readline, "createInterface").mockReturnValue({ question: async () => "1", close: () => {} } as unknown as readline.Interface);
    const tty = [process.stdin.isTTY, process.stdout.isTTY];
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    try {
      const args = ["project", "add", "--path", "/tmp/new", "--name", "New", "--id", "new", "--group", "--json"];
      const code = await runCli(args, services, options);
      expect(errors).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ preview: true, project: { id: "new", components: [{ id: "web" }] } });
      expect(output).not.toContain("ARGV_SENTINEL");
      expect(services.catalog.listProjects().map((item) => item.id)).not.toContain("new");
      output = "";
      expect(await runCli([...args, "--apply"], services, options)).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ id: "new", createdAt: "2026-01-01T00:00:00.000Z", components: [{ id: "web" }] });
      expect(output).not.toContain("ARGV_SENTINEL");
    } finally {
      prompt.mockRestore();
      process.stdin.isTTY = tty[0]!; process.stdout.isTTY = tty[1]!;
    }
  });
});
