import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { ensureStateDir } from "../state";
import { publicChange, publicProject, publicSetupPlan } from "../public";
import { resolveSelection } from "../operations/graph";
import { logEvent, redactLogLine, redactText } from "../operations/logger";
import { DevHubError, type AppServices, type ContainerLogLine, type CreateInput, type DockerCustom, type FollowHandle, type RemediationInput } from "../contracts";

const PREFIX = "/api/v1";
const DB_NAME = "api-auth.sqlite";
const CODE_TTL = 5 * 60_000;
const SESSION_TTL = 8 * 60 * 60_000;
const BODY_LIMIT = 64 * 1024;
const STREAM_LIMIT = 32;
const STREAM_TTL = 30_000;
const LOG_POLL_MS = 2_000;
const CONTAINER_LOG_TTL = 15 * 60_000;
const CONTAINER_LOG_FLUSH_MS = 100;
const CONTAINER_LOG_LINES_PER_SECOND = 500;
const CONTAINER_LOG_MAX_QUEUED = 64;
// Redaction is quadratic on a huge unbroken token, so its CPU time is budgeted like the lines are.
const CONTAINER_LOG_REDACT_MS_PER_SECOND = 200;
const SESSION_CHECK_MS = 30_000;
const RECENT_OPERATIONS = 20;
// Bun closes a connection idle for 10 s by default, and a quiet container sends nothing.
const CONTAINER_LOG_HEARTBEAT_MS = 5_000;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const LOG_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TOKEN_BYTES = 32;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KNOWN_PRESETS = new Set(["symfony-docker", "laravel-docker", "node-docker", "compose-existing", "native", "custom"]);

type ApiOptions = { stateDir: string; origins?: string[]; hostnames?: string[]; pairingCode?: string; now?: () => number };
type ApiEnv = { Variables: { sessionHash: string } };
type Pairing = { code: string; expiresAt: string };
type RecordValue = Record<string, unknown>;

function clock(options: ApiOptions): number { return options.now?.() ?? Date.now(); }
function randomToken(): string { return Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString("base64url"); }
function digest(value: string): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex"), b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function authDb(stateDir: string): Database {
  const path = join(ensureStateDir(stateDir), DB_NAME);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid API auth state file");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const db = new Database(path, { create: true, strict: true });
  chmodSync(path, 0o600);
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name).sort();
  const expected = ["api_meta", "api_pairing", "api_sessions", "api_throttle"];
  if (tables.length && (tables.length !== expected.length || tables.some((name, index) => name !== expected[index]))) {
    db.close(); throw new Error("Unrecognized API auth database schema");
  }
  const columns: Record<string, string[]> = {
    api_meta: ["key", "value"], api_pairing: ["id", "hash", "expires"],
    api_sessions: ["hash", "expires", "created"], api_throttle: ["id", "window_start", "attempts", "blocked_until"],
  };
  for (const table of tables) {
    const actual = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (actual.length !== columns[table]!.length || actual.some((name, index) => name !== columns[table]![index])) {
      db.close(); throw new Error("Unrecognized API auth database schema");
    }
  }
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version !== 0 && version !== 1) { db.close(); throw new Error("Unsupported API auth database version"); }
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS api_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_pairing (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_throttle (id INTEGER PRIMARY KEY CHECK(id=1), window_start INTEGER NOT NULL, attempts INTEGER NOT NULL, blocked_until INTEGER NOT NULL);`);
  db.exec("PRAGMA user_version=1");
  return db;
}

export function issuePairingCode(stateDir: string): Pairing {
  const db = authDb(stateDir);
  try {
    const code = randomToken();
    const expiresAtMs = Date.now() + CODE_TTL;
    db.query("INSERT INTO api_pairing(id,hash,expires) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, expires=excluded.expires").run(digest(code), expiresAtMs);
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  } finally { db.close(); }
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function boundedString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }
function json(data: unknown, status = 200): Response { return Response.json({ data }, { status }); }
function fail(code: string, message: string, status: number): Response { return Response.json({ error: { code, message } }, { status }); }
function safeFailure(error: unknown): Response {
  if (error instanceof DevHubError) {
    const code = /^[a-z][a-z0-9_-]{0,63}$/.test(error.code) ? error.code : "request_failed";
    // Client errors carry an actionable, redacted and bounded message; server errors stay generic.
    const message = error.status < 500 ? redactText(error.message).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) : "The request could not be completed.";
    return fail(code, message || "The request could not be completed.", error.status);
  }
  return fail("internal", "The request could not be completed.", 500);
}
function loopbackOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash && parsed.origin === value;
  } catch { return false; }
}
function cookieToken(request: Request): string | undefined {
  const cookie = request.headers.get("Cookie");
  if (!cookie || cookie.length > 4096) return undefined;
  const match = /(?:^|;\s*)devhub_session=([A-Za-z0-9_-]{40,64})(?:;|$)/.exec(cookie);
  return match?.[1];
}
function event(entry: unknown): { id: number; data: unknown } | undefined {
  if (!isRecord(entry) || !Number.isSafeInteger(entry.seq) || (entry.seq as number) < 0) return undefined;
  return { id: entry.seq as number, data: {
    seq: entry.seq, time: typeof entry.time === "string" ? entry.time : "",
    projectId: typeof entry.projectId === "string" ? entry.projectId : "",
    componentId: typeof entry.componentId === "string" ? entry.componentId : "",
    stream: entry.stream === "stderr" ? "stderr" : "stdout",
    message: typeof entry.message === "string" ? redactText(entry.message).slice(0, 4096) : "",
    ...(typeof entry.sourceId === "string" ? { sourceId: redactText(entry.sourceId).slice(0, 128) } : {}),
  } };
}
function publicOperation(operation: ReturnType<AppServices["operations"]["getOperation"]>) {
  return { id: operation.id, projectId: operation.projectId, action: operation.action,
    componentIds: [...operation.componentIds], state: operation.state, createdAt: operation.createdAt,
    updatedAt: operation.updatedAt, ...(operation.error ? { error: redactText(operation.error).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) } : {}) };
}
function publicStatus(status: Awaited<ReturnType<AppServices["operations"]["status"]>>) {
  return { projectId: status.projectId, components: status.components.map(({ componentId, state, ready, url, detail }) => ({ componentId, state, ready, url, ...(detail ? { detail: redactText(detail).slice(0, 300) } : {}) })) };
}
function publicScan(scan: ReturnType<AppServices["maintenance"]["getScan"]>) {
  return { id: scan.id, imageId: scan.imageId, state: scan.state, scannedAt: scan.scannedAt,
    scanner: scan.scanner, databaseUpdatedAt: scan.databaseUpdatedAt,
    findings: scan.findings.map(({ id: findingId, package: packageName, installedVersion, fixedVersion, severity, title, target }) => ({
      id: findingId, package: packageName, installedVersion, fixedVersion, severity, title, target,
    })), ...(scan.error ? { error: "Image scan failed. Inspect local CLI details." } : {}) };
}

export function createApp(services: AppServices, options: ApiOptions): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const db = authDb(options.stateDir);
  const allowedOrigins = new Set(options.origins ?? ["http://127.0.0.1:8040", "http://localhost:8040"]);
  const allowedHosts = new Set(options.hostnames ?? ["127.0.0.1:8040", "localhost:8040"]);
  for (const host of allowedHosts) {
    let parsed: URL;
    try { parsed = new URL(`http://${host}`); } catch { throw new Error("Hosts must be exact loopback host and port values"); }
    if (parsed.host !== host || parsed.username || parsed.password || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.port) throw new Error("Hosts must be exact loopback host and port values");
  }
  for (const origin of allowedOrigins) {
    if (!loopbackOrigin(origin) || !allowedHosts.has(new URL(origin).host)) throw new Error("Origins must be exact configured loopback origins and hosts");
  }
  if (options.pairingCode) {
    if (Buffer.byteLength(options.pairingCode) < 32) throw new Error("Pairing code seed must contain at least 256 bits");
    const expires = clock(options) + CODE_TTL;
    db.query("INSERT INTO api_pairing(id,hash,expires) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, expires=excluded.expires").run(digest(options.pairingCode), expires);
  }
  let streams = 0;
  const sessionAlive = (request: Request) => {
    const token = cookieToken(request), row = token && db.query<{ expires: number }, [string]>("SELECT expires FROM api_sessions WHERE hash=?").get(digest(token));
    return Boolean(row && row.expires > clock(options));
  };

  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    const originHeader = c.req.header("origin");
    if (!host || host.includes(",") || host.trim() !== host || !allowedHosts.has(host)) return fail("host_forbidden", "Host is not allowed.", 403);
    if (originHeader && (!loopbackOrigin(originHeader) || !allowedOrigins.has(originHeader) || !allowedHosts.has(new URL(originHeader).host))) return fail("origin_forbidden", "Origin is not allowed.", 403);
    const began = Date.now();
    try { await next(); }
    finally { const status = c.res.status; logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "http", { method: c.req.method, route: c.req.routePath || c.req.path, status, durationMs: Date.now() - began }); }
    if (originHeader && allowedOrigins.has(originHeader)) {
      c.header("Access-Control-Allow-Origin", originHeader);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
  });

  app.options(`${PREFIX}/*`, (c) => {
    const origin = c.req.header("origin"), method = c.req.header("access-control-request-method"), headers = c.req.header("access-control-request-headers") ?? "";
    if (!origin || !allowedOrigins.has(origin) || !["GET", "POST", "DELETE", "OPTIONS"].includes(method ?? "")
      || headers.split(",").map((header) => header.trim().toLowerCase()).some((header) => !["content-type", "idempotency-key", "last-event-id"].includes(header))) {
      return fail("preflight_forbidden", "Preflight request is not allowed.", 403);
    }
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, Last-Event-ID", "Vary": "Origin" } });
  });

  async function parseBody(c: Context<ApiEnv>): Promise<RecordValue | Response> {
    const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json") return fail("content_type", "Content-Type must be application/json.", 400);
    const length = c.req.header("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
      try { await c.req.raw.body?.cancel(); } catch {}
      return fail("body_too_large", "Request body exceeds the size limit.", 413);
    }
    const reader = c.req.raw.body?.getReader();
    if (!reader) return fail("invalid_json", "A JSON object is required.", 400);
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength;
        if (total > BODY_LIMIT) { await reader.cancel(); return fail("body_too_large", "Request body exceeds the size limit.", 413); }
        chunks.push(part.value);
      }
    } catch { return fail("invalid_json", "A JSON object is required.", 400); }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(value)) return fail("invalid_json", "A JSON object is required.", 400);
      return value;
    } catch { return fail("invalid_json", "A JSON object is required.", 400); }
  }
  const auth = (c: Context<ApiEnv>): Response | undefined => {
    const token = cookieToken(c.req.raw); if (!token) return fail("unauthorized", "Authentication required.", 401);
    const now = clock(options), tokenHash = digest(token);
    const read = db.transaction(() => {
      db.query("DELETE FROM api_sessions WHERE expires<=?").run(now);
      return db.query<{ hash: string; expires: number }, [string]>("SELECT hash,expires FROM api_sessions WHERE hash=?").get(tokenHash);
    });
    const row = read.immediate();
    if (!row || row.expires <= clock(options) || !constantEqual(row.hash, digest(token))) return fail("unauthorized", "Authentication required.", 401);
    c.set("sessionHash", row.hash); return undefined;
  };
  app.use(`${PREFIX}/*`, async (c, next) => {
    if (c.req.path === `${PREFIX}/pair` && c.req.method === "POST") return next();
    const rejected = auth(c); if (rejected) return rejected;
    if (["POST", "DELETE", "PUT", "PATCH"].includes(c.req.method)) {
      if (!c.req.header("origin") || !allowedOrigins.has(c.req.header("origin")!)) return fail("origin_required", "A configured Origin is required for mutations.", 403);
      if (c.req.path !== `${PREFIX}/logout` && c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return fail("content_type", "Content-Type must be application/json.", 400);
    }
    return next();
  });

  app.post(`${PREFIX}/pair`, async (c) => {
    if (!c.req.header("origin") || !allowedOrigins.has(c.req.header("origin")!)) return fail("origin_required", "A configured Origin is required.", 403);
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["code"]) || !boundedString(body.code, 128)) return fail("invalid_body", "Invalid pairing request.", 400);
    const now = clock(options);
    const tx = db.transaction(() => {
      const throttle = db.query<{ window_start: number; attempts: number; blocked_until: number }, []>("SELECT window_start,attempts,blocked_until FROM api_throttle WHERE id=1").get();
      if (throttle?.blocked_until && throttle.blocked_until > now) return { kind: "limited" as const };
      db.query("DELETE FROM api_sessions WHERE expires<=?").run(now);
      const current = db.query<{ hash: string; expires: number }, []>("SELECT hash,expires FROM api_pairing WHERE id=1").get();
      const recent = throttle && now - throttle.window_start < 60_000;
      const attempts = recent ? throttle!.attempts + 1 : 1;
      const blocked = attempts >= 5 ? now + Math.min(60_000 * 2 ** Math.min(Math.max(attempts - 5, 0), 5), 30 * 60_000) : 0;
      db.query("INSERT INTO api_throttle(id,window_start,attempts,blocked_until) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts,blocked_until=excluded.blocked_until").run(recent ? throttle!.window_start : now, attempts, blocked);
      if (!current || current.expires <= now) {
        if (current) db.query("DELETE FROM api_pairing WHERE id=1").run();
        return { kind: "invalid" as const };
      }
      if (!constantEqual(current.hash, digest(body.code as string))) return { kind: "invalid" as const };
      const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM api_sessions").get()?.count ?? 0;
      if (count >= 128) return { kind: "quota" as const };
      db.query("DELETE FROM api_pairing WHERE id=1").run();
      const token = randomToken(), tokenHash = digest(token), expiry = now + SESSION_TTL;
      db.query("INSERT INTO api_sessions(hash,expires,created) VALUES(?,?,?)").run(tokenHash, expiry, now);
      return { kind: "success" as const, token };
    });
    const result = tx.immediate();
    if (result.kind !== "success") return fail(result.kind === "limited" ? "pairing_limited" : result.kind === "quota" ? "session_quota" : "invalid_pairing", result.kind === "limited" ? "Pairing is temporarily unavailable." : result.kind === "quota" ? "Session capacity is full." : "Pairing code is invalid or expired.", result.kind === "limited" ? 429 : result.kind === "quota" ? 503 : 401);
    return new Response(JSON.stringify({ data: { authenticated: true } }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": `devhub_session=${result.token}; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=${SESSION_TTL / 1000}` } });
  });
  app.get(`${PREFIX}/session`, (c) => json({ authenticated: true }));
  app.post(`${PREFIX}/logout`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, [])) return fail("invalid_body", "Invalid logout request.", 400);
    const hash = c.get("sessionHash"); db.query("DELETE FROM api_sessions WHERE hash=?").run(hash);
    return new Response(JSON.stringify({ data: { authenticated: false } }), { headers: { "Content-Type": "application/json", "Set-Cookie": "devhub_session=; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=0" } });
  });

  app.get(`${PREFIX}/roots`, (c) => json(services.catalog.listRoots().map(({ id: rootId, path, label }) => ({ id: rootId, path, label }))));
  app.post(`${PREFIX}/roots`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["path"]) || !boundedString(body.path, 4096)) return fail("invalid_body", "A folder path is required.", 400);
    const { id: rootId, path, label } = services.catalog.addRoot(body.path);
    return json({ id: rootId, path, label }, 201);
  });
  app.get(`${PREFIX}/directories`, async (c) => {
    const path = c.req.query("path");
    if (path !== undefined && !boundedString(path, 4096)) return fail("invalid_query", "Invalid folder path.", 400);
    return json(await services.catalog.listDirectories(path));
  });
  app.get(`${PREFIX}/presets`, (c) => json(services.discovery.presets()));
  app.get(`${PREFIX}/stacks`, () => json(services.create.stacks()));
  const dockerCustom = (value: unknown) => {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as RecordValue, ["image", "packages", "extensions", "dockerfile", "args", "env"])) return false;
    const { image, packages, extensions, dockerfile, args, env } = value as DockerCustom;
    const variables = (items: unknown) => items === undefined || (!!items && typeof items === "object" && !Array.isArray(items) && Object.values(items).every((item) => typeof item === "string" && item.length <= 1024));
    const names = (items: unknown) => items === undefined || (Array.isArray(items) && items.length <= 64 && items.every((item) => boundedString(item, 64)));
    return (image === undefined || boundedString(image, 256)) && names(packages) && names(extensions) && (dockerfile === undefined || typeof dockerfile === "string") && variables(args) && variables(env);
  };
  /** These names become paths in the new project, so no other key gets through. Their size is bounded by the request body. */
  const instructionFiles = (value: unknown) => value === undefined || (!!value && typeof value === "object" && !Array.isArray(value) && exactKeys(value as RecordValue, ["AGENTS.md"]) && Object.values(value).every((item) => typeof item === "string"));
  const createInput = (body: RecordValue): CreateInput | undefined => {
    const { stack, name, rootId, mode, options, services: selected, versions, docker, instructions, git } = body;
    const strings = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => boundedString(item, 64));
    if (!exactKeys(body, ["stack", "name", "rootId", "mode", "options", "services", "versions", "docker", "instructions", "git"]) || !boundedString(stack, 64) || !boundedString(name, 128) || !boundedString(rootId, 4096)
      || (mode !== "docker" && mode !== "native") || !strings(options) || (versions !== undefined && !strings(versions)) || !dockerCustom(docker) || !instructionFiles(instructions) || !Array.isArray(selected) || !selected.every((item) => boundedString(item, 64)) || typeof git !== "boolean") return undefined;
    return { stack, name, rootId, mode, options: options as Record<string, string>, services: selected as string[], ...(versions ? { versions: versions as Record<string, string> } : {}), ...(docker ? { docker: docker as DockerCustom } : {}), ...(instructions ? { instructions: instructions as Record<string, string> } : {}), git };
  };
  app.post(`${PREFIX}/creations/preview`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    // A form with no name yet still shows the files of its choices, under a stand-in name.
    const draft = body.name === undefined;
    const input = createInput(draft ? { rootId: "none", ...body, name: "my-project" } : body); if (!input) return fail("invalid_body", "Invalid project creation request.", 400);
    return json(await services.create.plan(input, draft));
  });
  app.post(`${PREFIX}/creations`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    const input = createInput(body); if (!input) return fail("invalid_body", "Invalid project creation request.", 400);
    const { project, operation, url } = await services.create.apply(await services.create.plan(input), false);
    return json({ project: publicProject(project), operation: publicOperation(operation), url }, 201);
  });
  app.post(`${PREFIX}/discovery`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["path", "depth"]) || !boundedString(body.path, 4096) || (body.depth !== undefined && (!Number.isInteger(body.depth) || Number(body.depth) < 0 || Number(body.depth) > 8))) return fail("invalid_body", "Invalid discovery request.", 400);
    services.catalog.assertAllowedPath(body.path);
    const detections = await services.discovery.scan(body.path, body.depth as number | undefined);
    return json(detections.map((detection) => ({ path: detection.path, name: detection.name, git: detection.git, stacks: detection.stacks, composeFiles: detection.composeFiles, makeTargets: detection.makeTargets, components: detection.components.map((component) => ({ id: component.id, name: component.name, kind: component.kind, cwd: component.cwd, compose: component.compose, dependsOn: component.dependsOn, url: component.url, health: component.health, limits: component.limits })), warnings: detection.warnings })));
  });
  app.post(`${PREFIX}/projects/preview`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["path", "name", "preset", "id", "composeProjectName"]) || !boundedString(body.path, 4096) || !boundedString(body.name, 128) || typeof body.preset !== "string" || !KNOWN_PRESETS.has(body.preset) || (body.id !== undefined && !id(body.id)) || (body.composeProjectName !== undefined && !boundedString(body.composeProjectName, 63))) return fail("invalid_body", "Invalid project preview request.", 400);
    services.catalog.assertAllowedPath(body.path);
    const plan = await services.discovery.preview({ path: body.path, name: body.name, preset: body.preset, id: body.id as string | undefined, composeProjectName: body.composeProjectName as string | undefined });
    return json(publicSetupPlan(plan));
  });
  app.post(`${PREFIX}/projects`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["planId"]) || !id(body.planId)) return fail("invalid_body", "A setup plan ID is required.", 400);
    return json(publicProject(await services.discovery.apply(body.planId)), 201);
  });
  app.get(`${PREFIX}/projects`, (c) => {
    const variants = new Map(services.worktrees.list().map((item) => [item.id, { parent: item.parent, branch: item.branch }]));
    return json(services.catalog.listProjects().map((project) => ({ ...publicProject(project), ...(variants.has(project.id) ? { worktree: variants.get(project.id) } : {}) })));
  });
  app.delete(`${PREFIX}/projects/:id`, async (c) => {
    const projectId = c.req.param("id"); if (!id(projectId)) return fail("invalid_id", "Invalid project ID.", 400);
    const active = services.operations.listOperations(projectId).some((operation) => operation.state === "queued" || operation.state === "running");
    if (active) return fail("operation_active", "Project has an active operation.", 409);
    if (services.worktrees.get(projectId)) return fail("worktree", `Remove a worktree with devhub worktree remove ${projectId}: it also drops its database and folder.`, 409);
    services.catalog.removeProject(projectId); return json({ removed: true });
  });
  app.get(`${PREFIX}/projects/:id/status`, async (c) => {
    if (!id(c.req.param("id"))) return fail("invalid_id", "Invalid project ID.", 400);
    return json(publicStatus(await services.operations.status(c.req.param("id"))));
  });
  app.get(`${PREFIX}/projects/:id/operations`, (c) => {
    const projectId = c.req.param("id"); if (!id(projectId)) return fail("invalid_id", "Invalid project ID.", 400);
    return json(services.operations.listOperations(projectId).slice(-RECENT_OPERATIONS).map(publicOperation));
  });
  app.post(`${PREFIX}/projects/:id/operations`, async (c) => {
    const projectId = c.req.param("id"), body = await parseBody(c);
    if (body instanceof Response) return body;
    if (!id(projectId) || !exactKeys(body, ["action", "componentIds"]) || !["start", "stop", "restart", "check"].includes(String(body.action)) || (body.componentIds !== undefined && (!Array.isArray(body.componentIds) || body.componentIds.length < 1 || body.componentIds.length > 64 || body.componentIds.some((value) => !id(value))))) return fail("invalid_body", "Invalid operation request.", 400);
    const project = services.catalog.getProject(projectId);
    if (body.componentIds) resolveSelection(project.components, body.componentIds as string[]);
    const key = c.req.header("idempotency-key");
    if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return fail("invalid_idempotency_key", "Invalid Idempotency-Key.", 400);
    return json(publicOperation(services.operations.submit(projectId, body.action as "start" | "stop" | "restart" | "check", body.componentIds as string[] | undefined, key)), 202);
  });
  app.get(`${PREFIX}/operations/:id`, (c) => id(c.req.param("id")) ? json(publicOperation(services.operations.getOperation(c.req.param("id")))) : fail("invalid_id", "Invalid operation ID.", 400));

  app.get(`${PREFIX}/projects/:id/logs`, async (c) => {
    const projectId = c.req.param("id"), componentId = c.req.query("componentId"), limitRaw = c.req.query("limit") ?? "100", cursorRaw = c.req.query("cursor");
    if (!id(projectId) || (componentId && !id(componentId))) return fail("invalid_query", "Invalid log query.", 400);
    const limit = Number(limitRaw), queryCursor = cursorRaw === undefined ? 0 : Number(cursorRaw), last = c.req.header("last-event-id");
    if (!/^(?:[1-9]\d{0,3})$/.test(limitRaw) || !Number.isSafeInteger(limit) || limit > 1000 || !Number.isSafeInteger(queryCursor) || queryCursor < 0 || (cursorRaw !== undefined && !/^(?:0|[1-9]\d{0,15})$/.test(cursorRaw)) || (last !== undefined && !/^(?:0|[1-9]\d{0,15})$/.test(last))) return fail("invalid_query", "Invalid log cursor or limit.", 400);
    if (streams >= STREAM_LIMIT) return fail("stream_limit", "Log stream capacity is full.", 429);
    const startCursor = last === undefined ? queryCursor : Number(last);
    streams += 1;
    let streamCancel: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let cursor = startCursor, closed = false, pollTimer: ReturnType<typeof setTimeout> | undefined, lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
        const encoder = new TextEncoder();
        const finish = (close = true) => { if (closed) return; closed = true; if (pollTimer) clearTimeout(pollTimer); if (lifetimeTimer) clearTimeout(lifetimeTimer); streams = Math.max(0, streams - 1); if (close) { try { controller.close(); } catch {} } };
        streamCancel = () => finish(false);
        const pump = async () => {
          if (closed) return;
          if (!sessionAlive(c.req.raw)) return finish();
          try {
            const entries = await services.operations.logs(projectId, { componentId, cursor, limit: Math.min(limit, 100) });
            if (closed) return; // The client left during the read.
            let output = "";
            const batch = entries.slice(0, Math.min(limit, 100));
            const first = batch.map(event).find((item) => item && item.id > cursor);
            if (first && first.id > cursor + 1) output += `event: reset\ndata: ${JSON.stringify({ cursor, resumeAt: first.id })}\n\n`;
            for (const candidate of batch) {
              const item = event(candidate); if (!item || item.id <= cursor) continue;
              output += `id: ${item.id}\nevent: log\ndata: ${JSON.stringify(item.data)}\n\n`; cursor = item.id;
              if (output.length > 60_000) break;
            }
            if (output) controller.enqueue(encoder.encode(output));
          } catch { if (closed) return; controller.enqueue(encoder.encode("event: error\ndata: {\"error\":{\"code\":\"stream_error\",\"message\":\"Log stream failed.\"}}\n\n")); return finish(); }
          // Each poll reads every component source (docker logs, journalctl): keep it at seconds, not milliseconds.
          pollTimer = setTimeout(pump, LOG_POLL_MS);
        };
        void pump();
        lifetimeTimer = setTimeout(() => finish(), STREAM_TTL);
      },
      cancel() { streamCancel?.(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
  });
  app.get(`${PREFIX}/containers/:id/logs`, (c) => {
    const containerId = c.req.param("id"), since = c.req.query("since");
    if (!CONTAINER_ID.test(containerId) || (since !== undefined && !LOG_TIME.test(since))) return fail("invalid_query", "Invalid log query.", 400);
    if (streams >= STREAM_LIMIT) return fail("stream_limit", "Log stream capacity is full.", 429);
    streams += 1;
    let streamCancel: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false, seq = 0, sentThisSecond = 0, redactMs = 0, ticks = 0, quietMs = 0, dropped = 0, output = "";
        let follower: FollowHandle | undefined, sessionTimer: ReturnType<typeof setInterval> | undefined, lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
        const send = () => {
          if (dropped) { output += `event: dropped\ndata: ${JSON.stringify({ count: dropped })}\n\n`; dropped = 0; }
          if (output) { controller.enqueue(encoder.encode(output)); output = ""; }
        };
        const flushTimer = setInterval(() => {
          quietMs = output || dropped ? 0 : quietMs + CONTAINER_LOG_FLUSH_MS;
          if (quietMs >= CONTAINER_LOG_HEARTBEAT_MS) { quietMs = 0; output = ": ping\n\n"; }
          send();
          ticks += 1;
          // A costly line stays as debt, so one spike skips the next seconds instead of repeating.
          if (ticks * CONTAINER_LOG_FLUSH_MS >= 1000) { ticks = 0; sentThisSecond = 0; redactMs = Math.max(0, redactMs - CONTAINER_LOG_REDACT_MS_PER_SECOND); }
        }, CONTAINER_LOG_FLUSH_MS);
        const finish = (close = true) => {
          if (closed) return;
          closed = true; clearInterval(flushTimer); clearInterval(sessionTimer); clearTimeout(lifetimeTimer); follower?.stop(); streams = Math.max(0, streams - 1);
          if (close) { try { send(); controller.close(); } catch {} }
        };
        streamCancel = () => finish(false);
        const failed = () => { output += "event: error\ndata: {\"code\":\"stream_error\",\"message\":\"Docker cannot read the logs of this container.\"}\n\n"; };
        // Over budget or behind a slow client, lines are counted and skipped before any redaction work.
        const onLine = (line: ContainerLogLine) => {
          if (closed) return;
          if (sentThisSecond >= CONTAINER_LOG_LINES_PER_SECOND || redactMs >= CONTAINER_LOG_REDACT_MS_PER_SECOND || (controller.desiredSize ?? 0) < -CONTAINER_LOG_MAX_QUEUED) { dropped += 1; return; }
          sentThisSecond += 1; seq += 1;
          const started = performance.now(), message = redactLogLine(line.message);
          redactMs += performance.now() - started;
          output += `event: log\ndata: ${JSON.stringify({ seq, time: line.time, stream: line.stream, message })}\n\n`;
        };
        sessionTimer = setInterval(() => { if (!sessionAlive(c.req.raw)) finish(); }, SESSION_CHECK_MS);
        lifetimeTimer = setTimeout(() => finish(), CONTAINER_LOG_TTL);
        void services.operations.followContainer(containerId, since, onLine).then((handle) => {
          follower = handle;
          if (closed) { handle.stop(); return; }
          void handle.done.then((code) => { if (code !== 0) failed(); finish(); });
        }).catch(() => { failed(); finish(); });
      },
      cancel() { streamCancel?.(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
  });
  app.get(`${PREFIX}/containers`, async () => json((await services.operations.inventory()).map((container) => ({ id: container.id, name: container.name, imageId: container.imageId, image: container.image, state: container.state, health: container.health, projectId: container.projectId, componentId: container.componentId, composeProject: container.composeProject, ports: container.ports, memoryBytes: container.memoryBytes, cpuPercent: container.cpuPercent }))));
  app.post(`${PREFIX}/scans`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["imageId"]) || !boundedString(body.imageId, 512)) return fail("invalid_body", "Invalid scan request.", 400);
    return json(publicScan(await services.maintenance.scan(body.imageId as string)));
  });
  app.get(`${PREFIX}/versions`, () => json(services.versions.latest() ?? null));
  app.post(`${PREFIX}/versions/check`, async () => json(await services.versions.check()));
  app.get(`${PREFIX}/scans`, (c) => json(services.maintenance.listScans().map(publicScan)));
  app.get(`${PREFIX}/scans/:id`, (c) => id(c.req.param("id")) ? json(publicScan(services.maintenance.getScan(c.req.param("id")))) : fail("invalid_id", "Invalid scan ID.", 400));
  app.get(`${PREFIX}/remediation`, (c) => json(services.maintenance.listChanges().map(publicChange)));
  app.post(`${PREFIX}/remediation/preview`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    const allowed = ["projectId", "componentId", "file", "replacement", "service", "stage"];
    if (!exactKeys(body, allowed) || !id(body.projectId) || !id(body.componentId) || !boundedString(body.file, 512) || body.file.startsWith("/") || body.file.split(/[\\/]/).includes("..") || !boundedString(body.replacement, 512) || (body.service !== undefined && !boundedString(body.service, 128)) || (body.stage !== undefined && !boundedString(body.stage, 128))) return fail("invalid_body", "Invalid remediation preview request.", 400);
    const input: RemediationInput = { projectId: body.projectId, componentId: body.componentId, file: body.file, replacement: body.replacement, service: body.service as string | undefined, stage: body.stage as string | undefined };
    const project = services.catalog.getProject(input.projectId), component = project.components.find((entry) => entry.id === input.componentId);
    if (!component || !component.sources?.some((source) => source.file === input.file && (source.service ?? undefined) === input.service && (source.stage ?? undefined) === input.stage)) return fail("source_forbidden", "Source is not an approved component mapping.", 400);
    return json(publicChange(await services.maintenance.preview(input)));
  });
  for (const action of ["apply", "validate", "activate"] as const) app.post(`${PREFIX}/remediation/${action}`, async (c) => {
    const body = await parseBody(c); if (body instanceof Response) return body;
    if (!exactKeys(body, ["changeId"]) || !id(body.changeId)) return fail("invalid_body", "A change ID is required.", 400);
    const change = await services.maintenance[action](body.changeId as string);
    return json(publicChange(change));
  });

  app.notFound(() => fail("not_found", "Route not found.", 404));
  app.onError((error) => safeFailure(error));
  return app;
}
