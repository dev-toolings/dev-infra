import { expect, test } from "bun:test";
import type { CatalogPort, LogEntry, Project, RuntimePort } from "../contracts";
import { OperationsLogs } from "./logs";

const project: Project = { id: "logs", name: "Logs", root: "/tmp/logs", createdAt: "2026-10-29T00:00:00.000Z", components: [
  { id: "api", name: "API", kind: "native", cwd: "/tmp/logs", dependsOn: [] },
] };
class LogCatalog {
  data = new Map<string, unknown>();
  getProject(id: string): Project { if (id !== project.id) throw new Error("missing"); return structuredClone(project); }
  updateRecord<T>(_namespace: string, id: string, fn: (value: T | undefined) => T): T { const next = fn(this.data.get(id) as T | undefined); this.data.set(id, structuredClone(next)); return structuredClone(next); }
  getRecord<T>(_namespace: string, id: string): T | undefined { const result = this.data.get(id); return result === undefined ? undefined : structuredClone(result) as T; }
}
const catalog = new LogCatalog() as unknown as CatalogPort;
let lines: LogEntry[] = [{ seq: 88, time: "2026-10-29T01:02:03.000Z", projectId: "spoof", componentId: "spoof", stream: "stdout", message: "password=secret", sourceId: "runtime-id" }];
const runtime = { async check() { return { componentId: "api", state: "running", ready: true }; }, async start() {}, async stop() {}, async logs() { return structuredClone(lines); }, async inventory() { return []; } } as unknown as RuntimePort;

test("merges bounded logs with stable cursor, source deduplication, and redaction", async () => {
  const logs = new OperationsLogs(catalog, runtime);
  const first = await logs.read("logs");
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ projectId: "logs", componentId: "api", seq: 1, message: "password=[redacted]" });
  expect(first[0]!.sourceId).toMatch(/^[a-f0-9]{64}$/);
  const second = await logs.read("logs", { cursor: 1 });
  expect(second).toEqual([]);
  const stored = catalog.getRecord<{ seq: number }>("logs", "logs");
  expect(stored?.seq).toBe(1);
});
