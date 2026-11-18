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

test("a resume reads each source from its newest stored entry; a first read takes the tail", async () => {
  const records = new LogCatalog();
  const store = { getProject: records.getProject.bind(records), updateRecord: records.updateRecord.bind(records), getRecord: records.getRecord.bind(records) } as unknown as CatalogPort;
  const asked: Array<string | undefined> = [];
  const source = { ...runtime, logs: async (_project: Project, _component: unknown, _limit: number, since?: string) => { asked.push(since); return [{ seq: 1, time: "2026-10-29T01:00:05.000Z", projectId: "logs", componentId: "api", stream: "stdout", message: "five", sourceId: "s5" }]; } } as unknown as RuntimePort;
  const logs = new OperationsLogs(store, source);
  const first = await logs.read("logs");
  await logs.read("logs", { cursor: first.at(-1)!.seq });
  expect(asked).toEqual([undefined, "2026-10-29T01:00:05.000Z"]);
});

test("from a cursor, a read returns the oldest unread entries first, so a backlog is never skipped", async () => {
  const records = new LogCatalog();
  const store = { getProject: records.getProject.bind(records), updateRecord: records.updateRecord.bind(records), getRecord: records.getRecord.bind(records) } as unknown as CatalogPort;
  const backlog: LogEntry[] = Array.from({ length: 150 }, (_, n) => ({ seq: n + 1, time: new Date(Date.UTC(2026, 9, 29, 1) + n * 1000).toISOString(), projectId: "logs", componentId: "api", stream: "stdout", message: `line ${n + 1}`, sourceId: `s${n + 1}` }));
  const busy = { ...runtime, logs: async () => structuredClone(backlog) } as unknown as RuntimePort;
  const logs = new OperationsLogs(store, busy);
  // A first read is the tail; a read from a cursor resumes right after it, oldest first.
  expect((await logs.read("logs", { cursor: 0, limit: 100 })).map((entry) => entry.message)).toEqual(backlog.slice(50).map((entry) => entry.message));
  const first = await logs.read("logs", { cursor: 1, limit: 100 });
  expect(first.map((entry) => entry.message)).toEqual(backlog.slice(1, 101).map((entry) => entry.message));
  const next = await logs.read("logs", { cursor: first.at(-1)!.seq, limit: 100 });
  expect(next.map((entry) => entry.message)).toEqual(backlog.slice(101).map((entry) => entry.message));
});
