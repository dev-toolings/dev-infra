import { expect, test } from "bun:test";
import type { Action, CatalogPort, Component, LogEntry, Operation, Project, ProjectInput, Root, RuntimePort } from "../contracts";
import { Operations } from "./index";

const project: Project = {
  id: "sample", name: "Sample", root: "/tmp/sample", createdAt: "2026-10-29T00:00:00.000Z",
  components: [
    { id: "web", name: "Web", kind: "native", cwd: "/tmp/sample/web", dependsOn: ["api"] },
    { id: "api", name: "API", kind: "native", cwd: "/tmp/sample/api", dependsOn: [] },
    { id: "other", name: "Other", kind: "native", cwd: "/tmp/sample/other", dependsOn: [] },
  ],
};

class MemoryCatalog implements CatalogPort {
  projects = [structuredClone(project)];
  operations = new Map<string, Operation>();
  keys = new Map<string, string>();
  records = new Map<string, unknown>();
  patches: Array<Partial<Pick<Operation, "state" | "error">>> = [];
  failureToken?: string;
  sequence = 0;
  listRoots(): Root[] { return []; }
  addRoot(path: string): Root { return { id: "r", path, label: path }; }
  removeRoot(): void {}
  assertAllowedPath(path: string): string { return path; }
  listProjects(): Project[] { return structuredClone(this.projects); }
  getProject(id: string): Project { const found = this.projects.find((item) => item.id === id); if (!found) throw new Error("missing"); return structuredClone(found); }
  createProject(input: ProjectInput): Project { const item = { ...structuredClone(input), createdAt: new Date().toISOString() }; this.projects.push(item); return structuredClone(item); }
  saveProject(input: ProjectInput): Project { return this.createProject(input); }
  removeProject(id: string): void { this.projects = this.projects.filter((item) => item.id !== id); }
  claimOperation(projectId: string, action: Action, componentIds: string[], idempotencyKey?: string) {
    const fingerprint = JSON.stringify([projectId, action, componentIds]);
    if (idempotencyKey && this.keys.has(idempotencyKey)) {
      const existing = this.operations.get(this.keys.get(idempotencyKey)!)!;
      if (existing.projectId !== projectId || existing.action !== action || JSON.stringify(existing.componentIds) !== JSON.stringify(componentIds)) throw new Error("conflict");
      return { operation: structuredClone(existing), acquired: false };
    }
    const op: Operation = { id: `op-${++this.sequence}`, projectId, action, componentIds: [...componentIds], state: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), idempotencyKey };
    this.operations.set(op.id, op);
    if (idempotencyKey) this.keys.set(idempotencyKey, op.id);
    void fingerprint;
    return { operation: structuredClone(op), acquired: true };
  }
  updateOperation(id: string, patch: Partial<Pick<Operation, "state" | "error">>): Operation {
    if (this.failureToken) throw new Error(this.failureToken);
    this.patches.push(structuredClone(patch));
    const op = this.operations.get(id); if (!op) throw new Error("missing");
    Object.assign(op, patch, { updatedAt: new Date().toISOString() }); return structuredClone(op);
  }
  getOperation(id: string): Operation { const op = this.operations.get(id); if (!op) throw new Error("missing"); return structuredClone(op); }
  listOperations(projectId?: string): Operation[] { return [...this.operations.values()].filter((op) => !projectId || op.projectId === projectId).map((op) => structuredClone(op)); }
  recoverOperations(): void {}
  putRecord<T>(namespace: string, id: string, value: T): void { this.records.set(`${namespace}:${id}`, structuredClone(value)); }
  updateRecord<T>(namespace: string, id: string, update: (current: T | undefined) => T): T {
    const key = `${namespace}:${id}`; const next = update(this.getRecord<T>(namespace, id)); this.records.set(key, structuredClone(next)); return structuredClone(next);
  }
  getRecord<T>(namespace: string, id: string): T | undefined { const value = this.records.get(`${namespace}:${id}`); return value === undefined ? undefined : structuredClone(value) as T; }
  listRecords<T>(namespace: string): T[] { return [...this.records.entries()].filter(([key]) => key.startsWith(`${namespace}:`)).map(([, value]) => structuredClone(value) as T); }
  close(): void {}
}

function runtime(calls: string[], failStart?: string): RuntimePort {
  return {
    async check(_project, component) { calls.push(`check:${component.id}`); return { componentId: component.id, state: "running", ready: true }; },
    async start(_project, component) { calls.push(`start:${component.id}`); if (component.id === failStart) throw new Error("start failed password=leak"); },
    async stop(_project, component) { calls.push(`stop:${component.id}`); },
    async logs(): Promise<LogEntry[]> { return []; },
    async inventory() { return []; },
  };
}

test("starts dependency closure topologically and checks readiness", async () => {
  const calls: string[] = [];
  const ops = new Operations({ catalog: new MemoryCatalog(), runtime: runtime(calls) });
  const result = await ops.execute("sample", "start", ["web"]);
  expect(result.state).toBe("succeeded");
  expect(calls.slice(0, 4)).toEqual(["start:api", "check:api", "start:web", "check:web"]);
});

test("partial startup failure keeps started components running and never stops them", async () => {
  const calls: string[] = [];
  const ops = new Operations({ catalog: new MemoryCatalog(), runtime: runtime(calls, "web") });
  const result = await ops.execute("sample", "start", ["web"]);
  expect(result.state).toBe("failed");
  expect(result.error).toContain("[redacted]");
  expect(calls).toEqual(["start:api", "check:api", "start:web"]);
});

test("same idempotency key and payload does not relaunch runtime actions", async () => {
  const calls: string[] = [];
  const catalog = new MemoryCatalog();
  const ops = new Operations({ catalog, runtime: runtime(calls) });
  const first = await ops.execute("sample", "start", ["web"], "repeat");
  const second = await ops.execute("sample", "start", ["web"], "repeat");
  expect(second.id).toBe(first.id);
  expect(calls.filter((call) => call.startsWith("start:"))).toEqual(["start:api", "start:web"]);
});

test("stop uses reverse topological order for the selected set", async () => {
  const calls: string[] = [];
  const ops = new Operations({ catalog: new MemoryCatalog(), runtime: runtime(calls) });
  const result = await ops.execute("sample", "stop", ["web", "other"]);
  expect(result.state).toBe("succeeded");
  expect(calls).toEqual(["stop:web", "stop:other"]);
});

test("readiness deadline fails the operation and prevents dependent starts", async () => {
  const calls: string[] = [];
  const runtimePort = runtime(calls);
  runtimePort.check = async (_project, component) => {
    calls.push(`check:${component.id}`);
    return { componentId: component.id, state: "running", ready: false };
  };
  const ops = new Operations({ catalog: new MemoryCatalog(), runtime: runtimePort, readinessTimeoutMs: 8, pollMs: 1 });
  const result = await ops.execute("sample", "start", ["web"]);
  expect(result.state).toBe("failed");
  expect(calls.filter((call) => call.startsWith("start:"))).toEqual(["start:api"]);
  expect(calls).not.toContain("start:web");
});

test("storage failure rejects with a fixed message and fixed cause", async () => {
  const token = "arbitrary-private-token-91";
  const catalog = new MemoryCatalog();
  catalog.failureToken = token;
  const messages: string[] = [];
  const logger = { debug() {}, info() {}, warn(_fields: Record<string, unknown>, message = "") { messages.push(message); }, error(_fields: Record<string, unknown>, message = "") { messages.push(message); } };
  const ops = new Operations({ catalog, runtime: runtime([]), logger });
  let caught: unknown;
  try { await ops.execute("sample", "start", ["web"]); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ message: "DEVHUB_OPERATION_STORAGE_FAILED", cause: "DEVHUB_OPERATION_STORAGE_FAILED" });
  expect(JSON.stringify(messages)).not.toContain(token);
  expect(JSON.stringify(messages)).toContain("DEVHUB_OPERATION_STORAGE_FAILED");
  expect(JSON.stringify([...catalog.operations.values()])).not.toContain(token);
});

test("snapshot mismatch rejects and exposes only the fixed diagnostic", async () => {
  const token = "arbitrary-snapshot-secret-72";
  const catalog = new MemoryCatalog();
  catalog.projects[0]!.components[0]!.argv = [token];
  const messages: string[] = [];
  const logger = { debug() {}, info() {}, warn(_fields: Record<string, unknown>, message = "") { messages.push(message); }, error(_fields: Record<string, unknown>, message = "") { messages.push(message); } };
  const runtime: RuntimePort = {
    async check() { return { componentId: "web", state: "running", ready: true }; },
    async start() { catalog.projects[0]!.components[0]!.argv = ["changed"]; },
    async stop() {}, async logs() { return []; }, async inventory() { return []; },
  };
  const ops = new Operations({ catalog, runtime, logger });
  let caught: unknown;
  try { await ops.execute("sample", "start", ["web"]); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ message: "DEVHUB_PROJECT_CHANGED", cause: "DEVHUB_PROJECT_CHANGED" });
  const op = [...catalog.operations.values()][0]!;
  expect(ops.getOperation(op.id).error).toBe("DEVHUB_PROJECT_CHANGED");
  expect(JSON.stringify(catalog.patches)).not.toContain(token);
  expect(JSON.stringify(messages)).not.toContain(token);
  expect(JSON.stringify(caught)).not.toContain(token);
});
