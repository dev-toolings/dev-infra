import { DevHubError, type CatalogPort, type Component, type LogEntry, type LogOptions, type Project, type RuntimePort } from "../contracts";
import { resolveSelection } from "./graph";
import { redactText } from "./logger";

const NAMESPACE = "logs";
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ENTRIES = 1000;
const MAX_KEYS = 1000;
const MAX_FETCH = 1000;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
interface StoredLog extends LogEntry { key: string }
interface LogRecord {
  version: 1;
  projectCreatedAt: string;
  seq: number;
  generation: number;
  appliedGeneration: number;
  entries: StoredLog[];
  keys: string[];
  latestKeys: string[];
}
function invalid(): never { throw new DevHubError("Invalid log request", "invalid", 400); }
function hash(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}
function validTime(value: string): boolean {
  return value.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}
function recordValid(record: unknown): record is LogRecord {
  if (!record || typeof record !== "object") return false;
  const value = record as LogRecord;
  if (!(value.version === 1 && typeof value.projectCreatedAt === "string"
    && Number.isSafeInteger(value.seq) && value.seq >= 0
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(value.appliedGeneration) && value.appliedGeneration >= 0
    && value.appliedGeneration <= value.generation
    && Array.isArray(value.entries) && value.entries.length <= MAX_ENTRIES
    && Array.isArray(value.keys) && value.keys.length <= MAX_KEYS
    && Array.isArray(value.latestKeys) && value.latestKeys.length <= MAX_KEYS)) return false;
  if (value.keys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
    || new Set(value.keys).size !== value.keys.length
    || value.latestKeys.some((key) => !value.keys.includes(key))) return false;
  let lastSeq = 0;
  for (const entry of value.entries) {
    if (!entry || !Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq || entry.seq > value.seq
      || typeof entry.time !== "string" || !validTime(entry.time)
      || typeof entry.projectId !== "string" || typeof entry.componentId !== "string"
      || (entry.stream !== "stdout" && entry.stream !== "stderr")
      || typeof entry.message !== "string" || redactText(entry.message) !== entry.message
      || typeof entry.sourceId !== "string" || !/^[a-f0-9]{64}$/.test(entry.sourceId)
      || typeof entry.key !== "string" || !/^[a-f0-9]{64}$/.test(entry.key)
      || !value.keys.includes(entry.key)) return false;
    lastSeq = entry.seq;
  }
  return true;
}
function bytes(record: LogRecord): number { return new TextEncoder().encode(JSON.stringify(record)).byteLength; }

export class OperationsLogs {
  constructor(private readonly catalog: CatalogPort, private readonly runtime: RuntimePort) {}

  async read(projectId: string, options: LogOptions = {}): Promise<LogEntry[]> {
    // Project IDs follow SAFE_ID in src/catalog/index.ts, uppercase included.
    if (typeof projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(projectId)) invalid();
    const project = this.getProject(projectId);
    const components = [...project.components].sort((a, b) => a.id.localeCompare(b.id));
    if (components.length < 1 || components.length > 64) invalid();
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) invalid();
    if (options.componentId !== undefined && (!ID_PATTERN.test(options.componentId) || !components.some((item) => item.id === options.componentId))) invalid();
    const expectedCreatedAt = project.createdAt;
    const generation = this.reserve(projectId, expectedCreatedAt);
    const perComponent = Math.floor(MAX_FETCH / components.length);
    const incoming: Array<{ component: Component; entries: LogEntry[] }> = [];
    // Read sources concurrently; a component that cannot be read (never started, tool unavailable) contributes nothing.
    const sources = options.componentId === undefined ? components : components.filter((item) => item.id === options.componentId);
    const settled = await Promise.allSettled(sources.map((component) => this.runtime.logs(project, component, perComponent)));
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const entries = result.value;
      if (!Array.isArray(entries) || entries.length > perComponent) throw new DevHubError("Runtime returned malformed logs", "runtime_invalid", 502);
      incoming.push({ component: sources[index]!, entries });
    });
    const normalized = this.normalize(projectId, incoming);
    this.merge(projectId, expectedCreatedAt, generation, normalized);
    const record = this.load(projectId, expectedCreatedAt);
    return record.entries
      .filter((entry) => entry.seq > cursor)
      .filter((entry) => options.componentId === undefined || entry.componentId === options.componentId)
      .slice(-limit)
      .map(({ key: _key, ...entry }) => entry);
  }

  private getProject(projectId: string): Project {
    try {
      const project = this.catalog.getProject(projectId);
      if (!Array.isArray(project.components) || project.components.length < 1 || project.components.length > 64) invalid();
      resolveSelection(project.components);
      return structuredClone(project);
    } catch (error) {
      if (error instanceof DevHubError) throw error;
      throw new DevHubError("Project not found", "not_found", 404);
    }
  }

  private current(projectId: string, createdAt: string): void {
    try { if (this.catalog.getProject(projectId).createdAt !== createdAt) throw new Error(); }
    catch { throw new DevHubError("Project registration changed during log read", "stale_project", 409); }
  }

  private empty(createdAt: string, seq = 0): LogRecord {
    return { version: 1, projectCreatedAt: createdAt, seq, generation: 0, appliedGeneration: 0, entries: [], keys: [], latestKeys: [] };
  }

  private reserve(projectId: string, createdAt: string): number {
    let generation = 0;
    this.catalog.updateRecord<LogRecord>(NAMESPACE, projectId, (old) => {
      this.current(projectId, createdAt);
      if (old !== undefined && (!recordValid(old) || bytes(old) > MAX_RECORD_BYTES)) throw new DevHubError("Invalid stored log data", "storage_failed", 500);
      const current = old && old.projectCreatedAt === createdAt ? old : this.empty(createdAt, old?.seq ?? 0);
      generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new DevHubError("Log generation exhausted", "storage_failed", 500);
      const next = { ...current, generation };
      if (bytes(next) > MAX_RECORD_BYTES) throw new DevHubError("Stored log quota exceeded", "storage_failed", 500);
      return next;
    });
    return generation;
  }

  private normalize(projectId: string, batches: Array<{ component: Component; entries: LogEntry[] }>): Array<Omit<StoredLog, "seq"> & { seq?: number }> {
    const result: Array<Omit<StoredLog, "seq"> & { seq?: number }> = [];
    const occurrences = new Map<string, number>();
    for (const { component, entries } of batches) {
      if (!Array.isArray(entries)) throw new DevHubError("Runtime returned malformed logs", "runtime_invalid", 502);
      for (const raw of entries) {
        if (!raw || typeof raw.message !== "string" || (raw.stream !== "stdout" && raw.stream !== "stderr") || typeof raw.time !== "string" || !validTime(raw.time)) {
          throw new DevHubError("Runtime returned malformed logs", "runtime_invalid", 502);
        }
        const message = redactText(raw.message);
        const base = typeof raw.sourceId === "string" && raw.sourceId.length > 0
          ? hash(raw.sourceId)
          : hash(JSON.stringify([message, projectId, component.id, raw.time, raw.stream]));
        const occurrence = occurrences.get(base) ?? 0;
        occurrences.set(base, occurrence + 1);
        const sourceId = typeof raw.sourceId === "string" && raw.sourceId.length > 0 ? base : hash(`${base}:${occurrence}`);
        const key = hash(JSON.stringify([projectId, component.id, sourceId, raw.time, raw.stream, message]));
        result.push({ time: raw.time, projectId, componentId: component.id, stream: raw.stream, message, sourceId, key });
      }
    }
    result.sort((left, right) => left.time.localeCompare(right.time)
      || left.componentId.localeCompare(right.componentId)
      || left.sourceId!.localeCompare(right.sourceId!));
    return result;
  }

  private merge(projectId: string, createdAt: string, generation: number, incoming: Array<Omit<StoredLog, "seq"> & { seq?: number }>): void {
    this.catalog.updateRecord<LogRecord>(NAMESPACE, projectId, (old) => {
      this.current(projectId, createdAt);
      if (old !== undefined && (!recordValid(old) || bytes(old) > MAX_RECORD_BYTES)) throw new DevHubError("Invalid stored log data", "storage_failed", 500);
      let record = old && old.projectCreatedAt === createdAt ? old : this.empty(createdAt, old?.seq ?? 0);
      if (generation <= record.appliedGeneration) return record;
      const batchKeys = [...new Set(incoming.map((entry) => entry.key))];
      const known = new Set(record.keys);
      let seq = record.seq;
      const fresh: StoredLog[] = [];
      for (const entry of incoming) {
        if (known.has(entry.key)) continue;
        seq += 1;
        if (!Number.isSafeInteger(seq)) throw new DevHubError("Log sequence exhausted", "storage_failed", 500);
        known.add(entry.key);
        fresh.push({ ...entry, seq });
      }
      const entries = [...record.entries, ...fresh];
      let keys = [...record.keys, ...fresh.map((entry) => entry.key)];
      const protectedKeys = new Set(batchKeys);
      let next: LogRecord = { ...record, seq, appliedGeneration: generation, entries, keys, latestKeys: batchKeys };
      while ((entries.length > MAX_ENTRIES || keys.length > MAX_KEYS || bytes(next) > MAX_RECORD_BYTES) && entries.length) {
        const removable = entries.findIndex((entry) => !protectedKeys.has(entry.key));
        const index = removable < 0 ? 0 : removable;
        const [removed] = entries.splice(index, 1);
        if (removed && !protectedKeys.has(removed.key)) keys = keys.filter((key) => key !== removed.key);
        next = { ...record, seq, appliedGeneration: generation, entries: [...entries], keys: [...keys], latestKeys: batchKeys };
      }
      if (bytes(next) > MAX_RECORD_BYTES) throw new DevHubError("Latest log batch exceeds storage quota", "storage_failed", 500);
      if (next.latestKeys.length > MAX_KEYS || bytes(next) > MAX_RECORD_BYTES) throw new DevHubError("Latest log batch exceeds storage quota", "storage_failed", 500);
      return next;
    });
  }

  private load(projectId: string, createdAt: string): LogRecord {
    this.current(projectId, createdAt);
    const record = this.catalog.getRecord<LogRecord>(NAMESPACE, projectId);
    if (record === undefined) return this.empty(createdAt);
    if (!recordValid(record) || record.projectCreatedAt !== createdAt || bytes(record) > MAX_RECORD_BYTES) throw new DevHubError("Invalid stored log data", "storage_failed", 500);
    return record;
  }
}
