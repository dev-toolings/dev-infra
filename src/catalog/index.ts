import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DevHubError, type Action, type CatalogPort, type Component, type Operation, type OperationClaim, type Project, type ProjectInput, type Root } from "../contracts";
import { ensureStateDir } from "../state";
import { redactText } from "../operations/logger";

const DB_VERSION = 1;
const BUSY_MS = 5000;
const MAX_COMPONENTS = 64;
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_RECORDS = 256;
const MAX_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_NAMESPACES = 32;
const MAX_PORTS = 1024;
const ACTIVE = new Set(["queued", "running"]);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SELECTOR = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_RECORD_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

type CatalogOptions = { stateDir: string; infraDir: string; dbPath?: string; reservedPorts?: number[] };
type Owner = { pid: number; start: string; boot: string; namespace: number; nonce: string };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function error(message: string, code = "invalid", status = 400): never { throw new DevHubError(message, code, status); }
function isBelow(path: string, parent: string): boolean { const rel = relative(parent, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
function canonicalVariants(path: string): string[] {
  const absolute = resolve(path);
  try { return [absolute, realpathSync(absolute)]; } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    const suffix: string[] = []; let cursor = absolute;
    while (!existsSync(cursor)) { const parent = dirname(cursor); if (parent === cursor) return [absolute]; suffix.unshift(basename(cursor)); cursor = parent; }
    return [...new Set([absolute, resolve(realpathSync(cursor), ...suffix)])];
  }
}
function overlaps(a: string, b: string): boolean { return canonicalVariants(a).some((left) => canonicalVariants(b).some((right) => isBelow(left, right) || isBelow(right, left))); }
function safeId(value: string, label: string): void { if (typeof value !== "string" || !SAFE_ID.test(value)) error(`Invalid ${label}`); }
function assertKeys(value: object, allowed: string[], label: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) error(`Unknown ${label} field`); }
function now(): string { return new Date().toISOString(); }
function jsonString(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): Json => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") error("Record must contain plain JSON values");
    if (seen.has(item)) error("Record cannot contain cycles");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length) error("Record arrays must be plain JSON arrays");
        const values: Json[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) error("Record arrays cannot contain holes");
          values.push(visit(item[i]));
        }
        if (Object.keys(item).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) error("Record arrays cannot have extra properties");
        return values;
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) error("Record must contain plain JSON objects");
      if (Object.getOwnPropertySymbols(item).length) error("Record objects cannot contain symbol keys");
      const result: Record<string, Json> = Object.create(null);
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) error("Record cannot contain accessors");
        result[key] = visit(descriptor.value);
      }
      return result;
    } finally { seen.delete(item); }
  };
  const encoded = JSON.stringify(visit(value));
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECORD) error("Record exceeds 4 MiB", "quota", 413);
  return encoded;
}
function parseJson<T>(value: string): T { return JSON.parse(value) as T; }
function clone<T>(value: T): T { return parseJson<T>(JSON.stringify(value)); }
function loopbackUrl(input: string, reserved: Set<number>): { url: string; port: number } {
  if (typeof input !== "string" || /[\u0000-\u0020\u007f\\]/.test(input)) error("Invalid loopback URL");
  let parsed: URL;
  try { parsed = new URL(input); } catch { return error("Invalid loopback URL"); }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(input)?.[1] ?? "";
  const rawAuthorityHost = authority.slice(authority.lastIndexOf("@") + 1);
  const rawHost = rawAuthorityHost.startsWith("[") ? /^\[([^\]]+)\]/.exec(rawAuthorityHost)?.[1] : rawAuthorityHost.split(":")[0];
  const parsedHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:") || !["127.0.0.1", "localhost", "::1"].includes(parsedHost) || rawHost !== parsedHost || authority.includes("@") || parsed.username || parsed.password || input.includes("#")) error("URL must use a literal loopback host without credentials or fragment");
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || reserved.has(port)) error("URL uses a reserved or invalid port", "port_conflict", 409);
  return { url: parsed.href, port };
}
function normalizedComposeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+/, ""); }
function processIdentity(): Owner {
  const pid = process.pid;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const tokens = stat.slice(end + 1).trim().split(/\s+/);
  const start = tokens[19];
  if (!end || !start || !/^\d+$/.test(start)) error("Cannot establish process identity", "owner_unavailable", 503);
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const namespace = statSync(`/proc/${pid}/ns/pid`).ino;
  if (!boot || !Number.isSafeInteger(namespace)) error("Cannot establish process identity", "owner_unavailable", 503);
  return { pid, start, boot, namespace, nonce: crypto.randomUUID() };
}
function alive(owner: Partial<Owner>, currentBoot: string): boolean | "unknown" {
  if (!Number.isInteger(owner.pid) || owner.pid! <= 0 || !owner.start || !/^\d+$/.test(owner.start) || !owner.boot || !Number.isSafeInteger(owner.namespace) || !owner.nonce) return "unknown";
  if (!currentBoot) return "unknown";
  if (owner.boot !== currentBoot) return false;
  let namespace: number;
  try { namespace = statSync(`/proc/${process.pid}/ns/pid`).ino; } catch { return "unknown"; }
  if (namespace !== owner.namespace) return "unknown";
  let stat: string;
  try { stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8"); } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? false : "unknown";
  }
  const end = stat.lastIndexOf(")");
  const start = stat.slice(end + 1).trim().split(/\s+/)[19];
  if (!start || !/^\d+$/.test(start)) return "unknown";
  return start !== owner.start ? false : true;
}

export class Catalog implements CatalogPort {
  private db: Database;
  private readonly stateDir: string;
  private readonly infraDir: string;
  private readonly dbPath: string;
  private readonly instanceOwner: Owner;
  private inCallback = false;
  private closed = false;

  constructor(options: CatalogOptions) {
    if (!options || !options.stateDir || !options.infraDir) error("stateDir and infraDir are required");
    this.stateDir = resolve(options.stateDir);
    this.infraDir = resolve(options.infraDir);
    const home = resolve(process.env.HOME || homedir());
    const protectedPaths = [this.infraDir, process.env.DEVHUB_DIR, join(home, ".local/share/devhub")].filter((item): item is string => Boolean(item));
    for (const item of protectedPaths) if (overlaps(this.stateDir, item)) error("State directory overlaps a protected DevHub path", "unsafe_path", 403);
    this.dbPath = options.dbPath === undefined ? join(this.stateDir, "catalog.sqlite") : this.validateDbPath(options.dbPath);
    ensureStateDir(this.stateDir, this.infraDir);
    this.checkDbFiles();
    this.waitForJournal();
    this.checkDbFiles();
    if (existsSync(this.dbPath)) this.probeSchema();
    this.db = new Database(this.dbPath, { create: true, strict: true });
    this.db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    this.db.exec("BEGIN IMMEDIATE");
    try { this.checkSchema(this.db); if (this.db.query("PRAGMA user_version").get() && this.userVersion(this.db) === 0) this.initializeSchema(); this.db.exec("COMMIT"); }
    catch (cause) { this.db.exec("ROLLBACK"); this.db.close(); throw cause; }
    const mode = this.db.query("PRAGMA journal_mode=WAL").get() as { journal_mode?: string };
    if (mode.journal_mode?.toLowerCase() !== "wal") { this.db.close(); error("SQLite WAL mode is required", "database", 500); }
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.checkDbFiles();
    this.instanceOwner = processIdentity();
    this.persistReservedPorts([8040, 5175, ...(options.reservedPorts ?? [])]);
    this.recoverOperations();
  }

  private validateDbPath(path: string): string {
    if (!isAbsolute(path) || dirname(resolve(path)) !== resolve(this.stateDir) || !/^[a-z0-9-]+\.sqlite$/.test(basename(path))) error("dbPath must be a safe SQLite basename directly in stateDir");
    return resolve(path);
  }
  private checkDbFiles(): void {
    for (const path of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`, `${this.dbPath}-journal`]) {
      let info; try { info = lstatSync(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
      if (info.isSymbolicLink() || !info.isFile()) error("SQLite database files must be regular non-symlink files", "unsafe_database", 403);
      if (info.uid !== process.getuid?.() || info.nlink !== 1) error("SQLite database files must be owned single-link files", "unsafe_database", 403);
      if ((info.mode & 0o777) !== 0o600) error("SQLite database files must have mode 0600", "unsafe_database", 403);
    }
  }
  private waitForJournal(): void {
    const path = `${this.dbPath}-journal`; const deadline = performance.now() + BUSY_MS;
    while (true) {
      let size = 0; try { size = lstatSync(path).size; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
      if (size === 0) return;
      if (performance.now() >= deadline) error("SQLite journal is nonempty; database recovery is busy or requires explicit recovery", "database_busy", 503);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  private userVersion(db: Database): number { return Number((db.query("PRAGMA user_version").get() as { user_version: number }).user_version); }
  private checkSchema(db: Database): void {
    const version = this.userVersion(db);
    const objects = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{type:string;name:string;tbl_name:string;sql:string}>;
    if (version === 0 && objects.length === 0) return;
    if (version !== DB_VERSION) error("Unsupported catalog database version", "database_schema", 409);
    const allowed = new Set(["roots", "projects", "operations", "records", "active_project_operation", "operation_idempotency"]);
    if (objects.some((entry) => !allowed.has(entry.name) || entry.type === "trigger" || entry.type === "view")) error("Catalog database contains an unknown schema object", "database_schema", 409);
    const tables = new Set(objects.filter((entry) => entry.type === "table").map((entry) => entry.name));
    if (["roots", "projects", "operations", "records"].some((name) => !tables.has(name)) || objects.length !== 6) error("Catalog database schema is invalid", "database_schema", 409);
    const columns: Record<string,string[]> = {
      roots:["id","path","label"],
      projects:["id","root_id","root","name","components","created_at"],
      operations:["id","project_id","action","component_ids","state","created_at","updated_at","error","idempotency_key","owner_pid","owner_start","owner_boot","owner_namespace","owner_nonce"],
      records:["namespace","id","value","bytes"],
    };
    for (const [table, expected] of Object.entries(columns)) {
      const actual = (db.query(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((column) => column.name);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) error("Catalog database table definition is invalid", "database_schema", 409);
    }
    const indexSql = new Map(objects.filter((entry) => entry.type === "index").map((entry) => [entry.name, (entry.sql ?? "").replace(/\s+/g," ").trim().toLowerCase()]));
    if (!indexSql.get("active_project_operation")?.includes("unique index") || !indexSql.get("active_project_operation")?.includes("where state in ('queued','running')") || !indexSql.get("operation_idempotency")?.includes("unique index") || !indexSql.get("operation_idempotency")?.includes("where idempotency_key is not null")) error("Catalog database indexes are invalid", "database_schema", 409);
  }
  private probeSchema(): void {
    const probe = new Database(this.dbPath, { readonly: true, strict: true });
    try { probe.exec(`PRAGMA busy_timeout=${BUSY_MS}`); this.checkSchema(probe); } catch (cause) { probe.close(); throw cause; }
    probe.close();
  }
  private initializeSchema(): void {
    this.db.exec(`CREATE TABLE roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,label TEXT NOT NULL);
      CREATE TABLE projects(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES roots(id),root TEXT NOT NULL,name TEXT NOT NULL,components TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,action TEXT NOT NULL,component_ids TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT,idempotency_key TEXT,owner_pid INTEGER,owner_start TEXT,owner_boot TEXT,owner_namespace INTEGER,owner_nonce TEXT);
      CREATE UNIQUE INDEX active_project_operation ON operations(project_id) WHERE state IN ('queued','running');
      CREATE UNIQUE INDEX operation_idempotency ON operations(project_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE records(namespace TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(namespace,id));
      PRAGMA user_version=${DB_VERSION};`);
  }
  private transaction<T>(fn: () => T): T {
    if (this.closed) error("Catalog is closed", "closed", 500);
    if (this.inCallback) error("Nested catalog writes are not permitted", "reentrant_write", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (cause) { try { this.db.exec("ROLLBACK"); } catch {} throw cause; }
  }
  private persistReservedPorts(additional: number[]): void {
    if (!Array.isArray(additional) || additional.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) error("Reserved ports must be integers from 1 to 65535");
    this.transaction(() => {
      const current = this.getRecord<number[]>("system", "reserved-ports") ?? [];
      if (!Array.isArray(current) || current.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) error("Persisted reserved ports are invalid", "database_schema", 500);
      const merged = [...new Set([...current, ...additional])].sort((a,b) => a-b);
      if (merged.length > MAX_PORTS) error("Reserved port limit exceeded", "quota", 413);
      const declared = this.declaredPorts();
      const collision = merged.find((port) => declared.some((entry) => entry.port === port));
      if (collision !== undefined) error(`Reserved port ${collision} is already declared by a project`, "port_conflict", 409);
      this.putRecordInternal("system", "reserved-ports", merged);
    });
  }
  private putRecordInternal(namespace: string, id: string, value: unknown): void {
    const encoded = jsonString(value); const bytes = Buffer.byteLength(encoded) + Buffer.byteLength(namespace) + Buffer.byteLength(id);
    const previous = this.db.query("SELECT bytes FROM records WHERE namespace=? AND id=?").get(namespace, id) as {bytes:number}|null;
    if (!previous) {
      const counts = this.db.query("SELECT (SELECT COUNT(*) FROM records WHERE namespace=?) AS count,(SELECT COUNT(DISTINCT namespace) FROM records WHERE namespace!='system') AS namespaces,(SELECT COALESCE(SUM(bytes),0) FROM records WHERE namespace!='system') AS bytes").get(namespace) as {count:number;namespaces:number;bytes:number};
      if (namespace !== "system" && counts.count >= MAX_RECORDS) error("Record count limit exceeded", "quota", 413);
      if (namespace !== "system" && !this.db.query("SELECT 1 FROM records WHERE namespace=? LIMIT 1").get(namespace) && counts.namespaces >= MAX_NAMESPACES) error("Record namespace limit exceeded", "quota", 413);
      if (namespace !== "system" && counts.bytes + bytes > MAX_RECORD_BYTES) error("Record storage limit exceeded", "quota", 413);
    } else if (namespace !== "system") {
      const total = Number((this.db.query("SELECT COALESCE(SUM(bytes),0) AS bytes FROM records WHERE namespace!='system'").get() as {bytes:number}).bytes) - previous.bytes + bytes;
      if (total > MAX_RECORD_BYTES) error("Record storage limit exceeded", "quota", 413);
    }
    this.db.query("INSERT INTO records(namespace,id,value,bytes) VALUES(?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes").run(namespace,id,encoded,bytes);
  }
  private declaredPorts(): Array<{projectId:string;componentId:string;port:number}> {
    const result: Array<{projectId:string;componentId:string;port:number}> = [];
    for (const project of this.listProjects()) for (const component of project.components) for (const value of [component.url, component.health?.url]) if (value) {
      const parsed = new URL(value); result.push({ projectId: project.id, componentId: component.id, port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) });
    }
    return result;
  }
  private rootFor(path: string): Root | undefined { return this.listRoots().find((root) => isBelow(path, root.path)); }
  private protectedPaths(): string[] {
    const home = resolve(process.env.HOME || homedir());
    return [this.stateDir, this.infraDir, process.env.DEVHUB_DIR, join(home, ".local/share/devhub")].filter((path): path is string => Boolean(path)).flatMap(canonicalVariants);
  }
  private ensureNoProtectedContainment(path: string, allowAncestor = false): void {
    for (const protectedPath of this.protectedPaths()) if (isBelow(path, protectedPath) || (!allowAncestor && isBelow(protectedPath, path))) error("Path overlaps protected DevHub data", "unsafe_path", 403);
  }
  assertAllowedPath(path: string, mustExist = true): string {
    if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path) || path.split(/[\\/]/).includes("..")) error("Path must be an absolute canonical path");
    const absolute = resolve(path); this.ensureNoProtectedContainment(absolute, true);
    let canonical: string;
    try { canonical = realpathSync(absolute); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || mustExist) error("Path does not exist or cannot be resolved", "path_not_found", 404);
      let parent = absolute; const suffix: string[] = [];
      while (!existsSync(parent)) { const next = dirname(parent); if (next === parent) error("Path cannot be resolved"); suffix.unshift(basename(parent)); parent = next; }
      canonical = resolve(realpathSync(parent), ...suffix);
    }
    this.ensureNoProtectedContainment(canonical, true);
    if (!this.rootFor(canonical)) error("Path is outside approved roots", "path_forbidden", 403);
    if (mustExist) { const info = lstatSync(absolute); if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) error("Approved path must be a regular file or directory", "path_forbidden", 403); }
    return canonical;
  }
  listRoots(): Root[] { return (this.db.query("SELECT id,path,label FROM roots ORDER BY id").all() as Root[]).map(clone); }
  addRoot(path: string, label = basename(resolve(path))): Root {
    if (!isAbsolute(path) || path.includes("\0")) error("Root path must be absolute");
    const canonical = realpathSync(resolve(path)); const info = lstatSync(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) error("Root must be a real directory");
    this.ensureNoProtectedContainment(canonical, true);
    if (!label || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)) error("Invalid root label");
    const id = `root-${crypto.randomUUID()}`; const root = { id, path: canonical, label };
    try { this.transaction(() => this.db.query("INSERT INTO roots(id,path,label) VALUES(?,?,?)").run(id,canonical,label)); } catch (cause) { if ((cause as {code?:string}).code === "SQLITE_CONSTRAINT_UNIQUE") error("Root is already registered", "conflict", 409); throw cause; }
    return root;
  }
  removeRoot(id: string): void {
    safeId(id,"root ID"); this.transaction(() => {
      const root = this.db.query("SELECT path FROM roots WHERE id=?").get(id) as {path:string}|null; if (!root) error("Root not found","not_found",404);
      if (this.db.query("SELECT 1 FROM projects WHERE root_id=? LIMIT 1").get(id)) error("Root contains registered projects","conflict",409);
      this.db.query("DELETE FROM roots WHERE id=?").run(id);
    });
  }
  private validateProject(input: ProjectInput): { input: ProjectInput; root: Root; ports: Array<{componentId:string;port:number}> } {
    if (!input || typeof input !== "object") error("Project is required"); safeId(input.id,"project ID");
    assertKeys(input as object,["id","name","root","components"],"project");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128 || /[\u0000-\u001f\u007f]/.test(input.name)) error("Invalid project name");
    let serializedInput: string;
    try { serializedInput = JSON.stringify(input); } catch { return error("Project configuration must be serializable JSON"); }
    if (Buffer.byteLength(serializedInput, "utf8") > 1024 * 1024) error("Project configuration exceeds 1 MiB", "quota", 413);
    const rootPath = this.assertAllowedPath(input.root); if (!lstatSync(input.root).isDirectory()) error("Project root must be a directory"); const root = this.rootFor(rootPath); if (!root) error("Project must be inside an approved root", "path_forbidden", 403);
    this.ensureNoProtectedContainment(rootPath, false);
    if (rootPath !== resolve(input.root)) error("Project root must be canonical");
    if (!Array.isArray(input.components) || input.components.length < 1 || input.components.length > MAX_COMPONENTS) error("Project must have 1 to 64 components");
    const ids = new Set<string>(); const dependencies = new Map<string,string[]>(); const ports: Array<{componentId:string;port:number}> = [];
    const reserved = new Set(this.getRecord<number[]>("system","reserved-ports") ?? []);
    for (const component of input.components) {
      if (!component || typeof component !== "object") error("Invalid component");
      assertKeys(component as object,["id","name","kind","cwd","argv","compose","dependsOn","envFiles","url","health","limits","sources","validation"],"component");
      safeId(component.id,"component ID"); if (ids.has(component.id)) error("Duplicate component ID"); ids.add(component.id);
      if (typeof component.name !== "string" || !component.name || component.name.length > 128 || /[\u0000-\u001f\u007f]/.test(component.name)) error("Invalid component name");
      if (component.kind !== "compose" && component.kind !== "native") error("Invalid component kind");
      if (component.health) { if (typeof component.health !== "object") error("Invalid health check"); assertKeys(component.health,["url"],"health check"); if (typeof component.health.url !== "string") error("Health check URL is required"); }
      if (component.validation) assertKeys(component.validation,["argv"],"validation");
      if (component.sources !== undefined && !Array.isArray(component.sources)) error("Source references must be an array");
      for (const source of component.sources ?? []) {
        if (!source || typeof source !== "object") error("Invalid source reference");
        assertKeys(source,["file","service","stage"],"source reference");
        for (const selector of [source.service,source.stage]) if (selector !== undefined && (typeof selector !== "string" || selector.length > 128 || /[\u0000-\u001f\u007f]/.test(selector))) error("Invalid source selector");
      }
      const cwd = this.assertAllowedPath(component.cwd); if (!lstatSync(component.cwd).isDirectory()) error("Component cwd must be a directory"); this.ensureNoProtectedContainment(cwd, false); if (!isBelow(cwd,rootPath)) error("Component cwd is outside project root", "path_forbidden",403);
      if (cwd !== resolve(component.cwd)) error("Component cwd must be canonical");
      const arrays: Array<[string, unknown[] | undefined]> = [["dependsOn",component.dependsOn],["argv",component.argv],["files",component.compose?.files],["profiles",component.compose?.profiles],["services",component.compose?.services],["envFiles",component.envFiles],["sources",component.sources],["validation.argv",component.validation?.argv]];
      for (const [name,array] of arrays) if (array && (!Array.isArray(array) || array.length > 64)) error(`${name} has too many entries`);
      if (!Array.isArray(component.dependsOn)) error("Component dependencies must be an array");
      dependencies.set(component.id,[...component.dependsOn]);
      for (const dep of component.dependsOn) if (typeof dep !== "string" || !dep) error("Invalid dependency");
      if (component.kind === "native") {
        if (component.compose) error("Native components cannot define Compose identity");
        this.validateArgv(component.argv,"argv"); if (component.validation) this.validateArgv(component.validation.argv,"validation argv");
        this.validateLimits(component.limits);
      } else this.validateCompose(component);
      // Component file references are relative to the component working directory, as Runtime and Discovery resolve them.
      for (const file of [...(component.compose?.files ?? []),...(component.envFiles ?? []),...(component.sources ?? []).map((source) => source.file)]) {
        if (typeof file !== "string" || !file || isAbsolute(file) || file.split(/[\\/]/).includes("..")) error("Configuration file must be relative to the component directory");
        const absolute = resolve(cwd,file); this.assertAllowedPath(absolute,true); if (!isBelow(absolute,rootPath)) error("Configuration file is outside project root", "path_forbidden",403);
        const info = lstatSync(absolute); if (info.isSymbolicLink() || !info.isFile()) error("Configuration files must be regular files", "path_forbidden",403);
      }
      for (const url of [component.url,component.health?.url]) if (url) ports.push({componentId:component.id,port:loopbackUrl(url,reserved).port});
    }
    for (const [id,deps] of dependencies) for (const dep of deps) if (!ids.has(dep) || dep === id) error("Component dependency is missing or self-referential");
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => { if (visiting.has(id)) error("Component dependency cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of dependencies.get(id)!) visit(dep); visiting.delete(id); visited.add(id); };
    for (const id of ids) visit(id);
    const distinctPorts = new Set<string>(); for (const item of ports) { const key = `${item.componentId}:${item.port}`; if (distinctPorts.has(key)) continue; distinctPorts.add(key); }
    return { input: { ...input, components: input.components.map((c) => ({ ...c, dependsOn: [...c.dependsOn] })) }, root, ports };
  }
  private validateArgv(argv: string[] | undefined, label: string): void { if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || typeof argv[0] !== "string" || !argv[0] || argv[0].startsWith("-")) error(`Invalid ${label}`); for (const arg of argv) if (typeof arg !== "string" || !arg || arg.length > 4096 || arg.includes("\0") || /[\r\n]/.test(arg)) error(`Invalid ${label}`); }
  private validateCompose(component: Component): void {
    const compose = component.compose; if (!compose || !Array.isArray(compose.files) || !compose.files.length || !Array.isArray(compose.services) || !compose.services.length || !Array.isArray(compose.profiles)) error("Compose identity, files, profiles and services are required");
    assertKeys(compose as object,["files","projectName","profiles","services"],"Compose");
    this.validateLimits(component.limits);
    for (const value of [compose.projectName,...compose.profiles,...compose.services]) if (typeof value !== "string" || !SELECTOR.test(value.toLowerCase()) || value !== value.toLowerCase()) error("Invalid Compose selector");
    if ([...compose.profiles,...compose.services].some((item) => !SELECTOR.test(item))) error("Invalid Compose selector");
    const name = normalizedComposeName(compose.projectName);
    if (["devhub","dev-infra","devhub-infra","dev-shared-net"].includes(name) || name.startsWith("infra-")) error("Shared infrastructure Compose identity is forbidden", "unsafe_identity",403);
    const protectedNames = [this.infraDir,process.env.DEVHUB_DIR,join(resolve(process.env.HOME || homedir()),".local/share/devhub")].filter((x):x is string=>Boolean(x)).map((p)=>normalizedComposeName(basename(resolve(p))));
    if (protectedNames.includes(name)) error("Infrastructure Compose identity is forbidden", "unsafe_identity",403);
    if (component.argv || component.validation) error("Compose components cannot define arbitrary argv");
  }
  private validateLimits(limits: Component["limits"]): void {
    if (limits) assertKeys(limits,["memoryMb","cpuPercent","tasks"],"resource limit");
    for (const [key,value] of Object.entries(limits ?? {})) {
      const max = key === "memoryMb" ? 1048576 : key === "cpuPercent" ? 10000 : 65536;
      if (!Number.isFinite(value) || value! <= 0 || value! > max || (key === "tasks" && !Number.isInteger(value))) error("Invalid component resource limit");
    }
  }
  private persistProject(input: ProjectInput, creating: boolean): Project {
    return this.transaction(() => {
      const validated = this.validateProject(input);
      const existing = this.db.query("SELECT created_at FROM projects WHERE id=?").get(input.id) as {created_at:string}|null;
      if (creating && existing) error("Project ID already exists","conflict",409);
      if (!creating && !existing) error("Project not found","not_found",404);
      if (!creating && this.db.query("SELECT 1 FROM operations WHERE project_id=? AND state IN ('queued','running') LIMIT 1").get(input.id)) error("Project has an active operation","conflict",409);
      const duplicate = this.db.query("SELECT id FROM projects WHERE root=? AND id!=?").get(validated.input.root,input.id) as {id:string}|null;
      if (duplicate) error("Project root is already registered","conflict",409);
      for (const component of input.components) if (component.kind === "compose") {
        const duplicateName = this.db.query("SELECT id,components FROM projects WHERE id!=?").all(input.id) as Array<{id:string;components:string}>;
        if (duplicateName.some((row) => (JSON.parse(row.components) as Component[]).some((c) => c.compose?.projectName === component.compose?.projectName))) error("Compose project name is already owned","conflict",409);
      }
      const reserved = new Set(this.getRecord<number[]>("system","reserved-ports") ?? []);
      for (const port of validated.ports) if (reserved.has(port.port)) error(`Project URL uses reserved port ${port.port}`,"port_conflict",409);
      const currentPorts = this.declaredPorts().filter((entry) => entry.projectId !== input.id);
      const seen = new Map<string,number>();
      for (const item of validated.ports) {
        const key = `${item.componentId}:${item.port}`; if (seen.has(key)) continue; seen.set(key,item.port);
        if (currentPorts.some((old) => old.port === item.port) || [...seen].some(([other]) => other !== key && other.endsWith(`:${item.port}`))) error(`Project URL port ${item.port} is already owned`,"port_conflict",409);
      }
      const createdAt = existing?.created_at ?? now(); const encoded = JSON.stringify(validated.input.components);
      if (creating) this.db.query("INSERT INTO projects(id,root_id,root,name,components,created_at) VALUES(?,?,?,?,?,?)").run(input.id,validated.root.id,input.root,input.name,encoded,createdAt);
      else this.db.query("UPDATE projects SET root_id=?,root=?,name=?,components=? WHERE id=?").run(validated.root.id,input.root,input.name,encoded,input.id);
      return { ...clone(validated.input), createdAt };
    });
  }
  listProjects(): Project[] { return (this.db.query("SELECT id,root,name,components,created_at AS createdAt FROM projects ORDER BY id").all() as Array<Omit<Project,"components"> & {components:string}>).map((row) => ({ ...row, components: parseJson<Component[]>(row.components) })); }
  getProject(id: string): Project { safeId(id,"project ID"); const row = this.db.query("SELECT id,root,name,components,created_at AS createdAt FROM projects WHERE id=?").get(id) as (Omit<Project,"components"> & {components:string})|null; if (!row) error("Project not found","not_found",404); return { ...row, components: parseJson<Component[]>(row.components) }; }
  createProject(input: ProjectInput): Project { return this.persistProject(input,true); }
  saveProject(input: ProjectInput): Project { return this.persistProject(input,false); }
  removeProject(id: string): void { safeId(id,"project ID"); this.transaction(() => { if (!this.db.query("SELECT 1 FROM projects WHERE id=?").get(id)) error("Project not found","not_found",404); if (this.db.query("SELECT 1 FROM operations WHERE project_id=? AND state IN ('queued','running')").get(id)) error("Project has an active operation","conflict",409); this.db.query("DELETE FROM operations WHERE project_id=?").run(id); this.db.query("DELETE FROM projects WHERE id=?").run(id); }); }
  private operation(row: Record<string,unknown>): Operation { return { id:String(row.id),projectId:String(row.project_id),action:row.action as Action,componentIds:parseJson<string[]>(String(row.component_ids)),state:row.state as Operation["state"],createdAt:String(row.created_at),updatedAt:String(row.updated_at),...(row.error ? {error:String(row.error)} : {}),...(row.idempotency_key ? {idempotencyKey:String(row.idempotency_key)} : {}) }; }
  private recoverWithinTransaction(): void {
    let boot = ""; try { boot = readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(); } catch { return; }
    const rows = this.db.query("SELECT * FROM operations WHERE state IN ('queued','running')").all() as Array<Record<string,unknown>>;
    for (const row of rows) {
      const state = alive({pid:row.owner_pid as number,start:row.owner_start as string,boot:row.owner_boot as string,namespace:row.owner_namespace as number,nonce:row.owner_nonce as string},boot);
      if (state === false) this.db.query("UPDATE operations SET state='unknown',updated_at=?,error=COALESCE(error,'Owner process is no longer alive') WHERE id=?").run(now(),String(row.id));
    }
  }
  claimOperation(projectId: string, action: Action, componentIds: string[], idempotencyKey?: string): OperationClaim {
    safeId(projectId,"project ID"); if (!["start","stop","restart","check"].includes(action)) error("Invalid operation action");
    if (!Array.isArray(componentIds) || componentIds.length > MAX_COMPONENTS) error("Invalid component selection");
    if (idempotencyKey !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) error("Invalid idempotency key");
    processIdentity();
    const owner = this.instanceOwner;
    return this.transaction(() => {
      this.recoverWithinTransaction(); const project = this.getProject(projectId); const selected = [...new Set(componentIds)].sort();
      if (selected.some((id) => !project.components.some((component) => component.id === id))) error("Unknown component selection");
      if (!selected.length) error("At least one component must be selected");
      if (idempotencyKey) {
        const prior = this.db.query("SELECT * FROM operations WHERE project_id=? AND idempotency_key=?").get(projectId,idempotencyKey) as Record<string,unknown>|null;
        if (prior) { if (prior.action !== action || JSON.stringify(parseJson(prior.component_ids as string)) !== JSON.stringify(selected)) error("Idempotency key payload conflicts","conflict",409); return {operation:this.operation(prior),acquired:false}; }
      }
      const active = this.db.query("SELECT 1 FROM operations WHERE project_id=? AND state IN ('queued','running')").get(projectId);
      if (active) error("Project already has an active operation","conflict",409);
      const id = crypto.randomUUID(), time = now();
      this.db.query("INSERT INTO operations(id,project_id,action,component_ids,state,created_at,updated_at,idempotency_key,owner_pid,owner_start,owner_boot,owner_namespace,owner_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,projectId,action,JSON.stringify(selected),"queued",time,time,idempotencyKey ?? null,owner.pid,owner.start,owner.boot,owner.namespace,owner.nonce);
      return {operation:{id,projectId,action,componentIds:selected,state:"queued",createdAt:time,updatedAt:time,...(idempotencyKey ? {idempotencyKey} : {})},acquired:true};
    });
  }
  updateOperation(id: string, patch: Partial<Pick<Operation,"state"|"error">>): Operation {
    return this.transaction(() => {
      const row = this.db.query("SELECT * FROM operations WHERE id=?").get(id) as Record<string,unknown>|null; if (!row) error("Operation not found","not_found",404);
      const next = patch.state ?? row.state as Operation["state"]; const allowed: Record<string,string[]> = {queued:["running","failed"],running:["succeeded","failed"]};
      if (!allowed[String(row.state)]?.includes(next)) error("Invalid operation state transition","conflict",409);
      if (row.owner_nonce !== this.instanceOwner.nonce) error("Operation belongs to another catalog owner","conflict",409);
      if (patch.error !== undefined && typeof patch.error !== "string") error("Operation error must be text");
      const safeError = patch.error === undefined ? null : redactText(patch.error).slice(0,2048);
      this.db.query("UPDATE operations SET state=?,updated_at=?,error=? WHERE id=?").run(next,now(),safeError,id);
      return this.operation(this.db.query("SELECT * FROM operations WHERE id=?").get(id) as Record<string,unknown>);
    });
  }
  getOperation(id: string): Operation { const row = this.db.query("SELECT * FROM operations WHERE id=?").get(id) as Record<string,unknown>|null; if (!row) error("Operation not found","not_found",404); return this.operation(row); }
  listOperations(projectId?: string): Operation[] { const rows = projectId ? this.db.query("SELECT * FROM operations WHERE project_id=? ORDER BY created_at,id").all(projectId) : this.db.query("SELECT * FROM operations ORDER BY created_at,id").all(); return (rows as Array<Record<string,unknown>>).map((row)=>this.operation(row)); }
  recoverOperations(): void { this.transaction(() => this.recoverWithinTransaction()); }
  putRecord<T>(namespace: string,id: string,value:T): void { this.validateRecordKey(namespace,"record namespace"); this.validateRecordKey(id,"record ID"); if (namespace === "system") error("System records are private","forbidden",403); this.transaction(()=>this.putRecordInternal(namespace,id,value)); }
  updateRecord<T>(namespace: string,id: string,update:(current:T|undefined)=>T): T {
    this.validateRecordKey(namespace,"record namespace"); this.validateRecordKey(id,"record ID"); if (namespace === "system") error("System records are private","forbidden",403); if (typeof update !== "function") error("Record updater must be a function");
    return this.transaction(()=>{ const current=this.getRecord<T>(namespace,id); this.inCallback=true; let next:T; try { next=update(current); } finally { this.inCallback=false; } if (next === undefined || (next && typeof (next as {then?:unknown}).then === "function")) error("Record updater must return synchronously defined JSON"); this.putRecordInternal(namespace,id,next); return clone(parseJson<T>(jsonString(next))); });
  }
  deleteRecord(namespace: string, id: string): void { this.validateRecordKey(namespace,"record namespace"); this.validateRecordKey(id,"record ID"); if (namespace === "system") error("System records are private","forbidden",403); this.transaction(()=>{ this.db.query("DELETE FROM records WHERE namespace=? AND id=?").run(namespace,id); }); }
  private validateRecordKey(value:string,label:string):void { if(typeof value!=="string"||!SAFE_RECORD_KEY.test(value)) error(`Invalid ${label}`); }
  getRecord<T>(namespace: string,id: string): T|undefined { this.validateRecordKey(namespace,"record namespace"); this.validateRecordKey(id,"record ID"); const row=this.db.query("SELECT value FROM records WHERE namespace=? AND id=?").get(namespace,id) as {value:string}|null; return row ? parseJson<T>(row.value) : undefined; }
  listRecords<T>(namespace: string): T[] { this.validateRecordKey(namespace,"record namespace"); return (this.db.query("SELECT value FROM records WHERE namespace=? ORDER BY id").all(namespace) as Array<{value:string}>).map((row)=>parseJson<T>(row.value)); }
  close(): void { if (!this.closed) { this.closed=true; this.db.close(); } }
}
