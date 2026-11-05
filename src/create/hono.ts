import { dirname, relative } from "node:path";

const importPath = (file: string, target: string) => {
  const path = relative(dirname(file), target);
  return path.startsWith(".") ? path : `./${path}`;
};

const PASSES = `/** Under the 3 seconds DevHub waits, so that a hanging dependency still gives a report. */
const CHECK_TIMEOUT_MS = 2_000;

async function passes(check: HealthCheck): Promise<[string, boolean]> {
  const timeout = new Promise((_, reject) => setTimeout(reject, CHECK_TIMEOUT_MS).unref());
  try {
    await Promise.race([check.run(), timeout]);
    return [check.name, true];
  } catch {
    return [check.name, false];
  }
}
`;

const ERRORS = `export type ErrorCode = "invalid" | "not_found";

/** An expected failure. It knows nothing of HTTP: the error handler picks the status. */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
`;

const LOG_PRETTY = `import pinoPretty from "pino-pretty";

/** Keys already placed on the line, never repeated as key=value. */
const RENDERED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "method",
  "path",
  "status",
  "durationMs",
]);

type Paint = (input: string) => string;
type Colors = Record<"green" | "yellow" | "red" | "gray" | "bold", Paint>;

const plain: Paint = (input) => input;
const PLAIN_COLORS: Colors = { green: plain, yellow: plain, red: plain, gray: plain, bold: plain };

function formatStatus(status: number, colors: Colors): string {
  const paint = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
  return paint(String(status));
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /[\\s"=]/.test(value) ? JSON.stringify(value) : value;
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/** The line after the level, exported so a test can read it without a worker. */
export function formatLogLine(
  log: Record<string, unknown>,
  messageKey = "msg",
  colors: Colors = PLAIN_COLORS,
): string {
  const fields = Object.entries(log)
    .filter(([key, value]) => !RENDERED_KEYS.has(key) && key !== messageKey && value !== undefined)
    .map(([key, value]) => \`\${key}=\${formatValue(value)}\`)
    .join(" ");
  const message = String(log[messageKey] ?? "");
  const head =
    message === "http request" && typeof log.status === "number"
      ? \`\${colors.bold(String(log.method))} \${log.path} \${formatStatus(log.status, colors)} \${log.durationMs}ms\`
      : message;
  return fields ? \`\${head}  \${colors.gray(fields)}\` : head;
}

/** In this thread on purpose: \`bun --hot\` reloads the logger, and each worker would stay alive. */
export function prettyStream() {
  // Forced: DevHub reads logs through a pipe, where a TTY check turns colors off.
  const colorize = !process.env.NO_COLOR;
  return pinoPretty({
    sync: true,
    colorize,
    translateTime: "HH:MM:ss.l",
    ignore: "pid,hostname",
    hideObject: true,
    singleLine: false,
    customColors:
      "fatal:bgRed,error:red,warn:yellow,info:green,debug:blue,trace:gray,message:reset",
    messageFormat: (log, messageKey, _level, { colors }) =>
      formatLogLine(log, messageKey, colorize ? colors : PLAIN_COLORS),
  });
}
`;

const LOGGER = `import pino from "pino";

const SECRET_KEYS = ["authorization", "cookie", "password", "token", "secret", "apiKey"];

/** Exported so a test can read the list. A wildcard skips the top level, so both are listed. */
export const LOG_REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, \`*.\${key}\`]);

const redact = { paths: LOG_REDACT_PATHS, censor: "[redacted]" };

/** JSON for a collector, and one readable line per event in development. */
export const logger =
  process.env.NODE_ENV === "development"
    ? pino({ level: "debug", redact }, (await import("./log-pretty.ts")).prettyStream())
    : pino({ level: "info", redact });
`;

const accessLog = (logger: string) => `import { createMiddleware } from "hono/factory";
import type { RequestIdVariables } from "hono/request-id";
import { routePath } from "hono/route";
import { logger } from "${logger}";

export type AppEnv = { Variables: RequestIdVariables & { errorCode?: string } };

/** One line per request. Mount it after requestId() so that the line carries the id. */
export const accessLog = createMiddleware<AppEnv>(async (c, next) => {
  const started = performance.now();
  await next();
  const { status } = c.res;
  const fields = {
    requestId: c.var.requestId,
    method: c.req.method,
    path: c.req.path,
    route: routePath(c, -1),
    status,
    durationMs: Math.round(performance.now() - started),
    ...(c.var.errorCode ? { errorCode: c.var.errorCode } : {}),
  };
  if (status >= 500) logger.error(fields, "http request");
  else if (status >= 400) logger.warn(fields, "http request");
  else logger.info(fields, "http request");
});
`;

const errorHandler = (errors: string, logger: string) => `import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { AppError, type ErrorCode } from "${errors}";
import { logger } from "${logger}";
import type { AppEnv } from "./access-log.ts";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = { invalid: 400, not_found: 404 };

function fail(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string) {
  c.set("errorCode", code);
  return c.json({ error: { code, message } }, status);
}

/** Every failure leaves as the same JSON, and an unknown one never shows its details. */
export function handleError(error: Error, c: Context<AppEnv>) {
  if (error instanceof AppError) return fail(c, STATUS[error.code], error.code, error.message);
  if (error instanceof HTTPException) return fail(c, error.status, "http_error", error.message);
  logger.error({ err: error, requestId: c.var.requestId }, "unhandled error");
  return fail(c, 500, "internal", \`Internal server error (\${c.var.requestId})\`);
}

export function handleNotFound(c: Context<AppEnv>) {
  return fail(c, 404, "not_found", "Route not found");
}

/** Hook for zValidator, which would otherwise answer with the raw Zod error. */
export function rejectInvalid(
  result: { success: true } | { success: false; error: z.core.$ZodError },
) {
  if (result.success) return;
  const issues = result.error.issues.map(({ path, message }) =>
    path.length > 0 ? \`\${path.join(".")}: \${message}\` : message,
  );
  throw new AppError("invalid", issues.join("; "));
}
`;

const drizzleAdapter = (imports: string[], fn: string, port: string) => `import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
${imports.join("\n")}

export function ${fn}(db: PostgresJsDatabase): ${port} {
  return {
    list: async () => db.select().from(notes).orderBy(notes.createdAt),
    find: async (id) => (await db.select().from(notes).where(eq(notes.id, id)))[0],
    save: async (note) => {
      await db
        .insert(notes)
        .values(note)
        .onConflictDoUpdate({ target: notes.id, set: { body: note.body } });
    },
    delete: async (id) => {
      const deleted = await db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
      return deleted.length > 0;
    },
  };
}
`;

const NOTE_INPUT = `import { z } from "zod";

/** The shape of a request. Business rules stay out of it. */
export const noteInput = z.object({ body: z.string().max(10_000) });
`;

const appFile = (name: string, imports: string[], deps: string) => `import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
${imports.join("\n")}

const name = ${JSON.stringify(name)};

export type AppDeps = ${deps};

export function createApp({ checks, notes }: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use(requestId(), accessLog, secureHeaders());
  app.onError(handleError);
  app.notFound(handleNotFound);
  return app
    .get("/", (c) => c.json({ name, health: "/health" }))
    .route("/health", healthRoutes(checks))
    .route("/notes", noteRoutes(notes));
}

/** For a typed client: \`hc<AppType>(url)\` from \`hono/client\`. */
export type AppType = ReturnType<typeof createApp>;
`;

const appTest = (imports: string[], notes: string) => `import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";
${imports.map((line) => `${line}\n`).join("")}
const newApp = () => createApp({ checks: [], notes: ${notes} });
const post = (body: string) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

test("health answers 503 when a dependency fails", async () => {
  const checks = [{ name: "database", run: () => Promise.reject(new Error("down")) }];
  const app = createApp({ checks, notes: ${notes} });
  const response = await app.request("/health");
  assert.equal(response.status, 503);
});

test("a note can be created, read and deleted", async () => {
  const app = newApp();
  const created = await app.request("/notes", post('{"body":" hello "}'));
  assert.equal(created.status, 201);
  const { id, body } = (await created.json()) as { id: string; body: string };
  assert.equal(body, "hello");
  assert.equal((await app.request(\`/notes/\${id}\`)).status, 200);
  assert.equal((await app.request(\`/notes/\${id}\`, { method: "DELETE" })).status, 204);
  assert.equal((await app.request(\`/notes/\${id}\`)).status, 404);
});

test("every failure answers the same JSON, with a request id", async () => {
  const app = newApp();
  for (const [response, status, code] of [
    [await app.request("/notes", post('{"body":"   "}')), 400, "invalid"],
    [await app.request("/notes", post('{"body":1}')), 400, "invalid"],
    [await app.request("/notes", post("{")), 400, "http_error"],
    [await app.request("/notes/unknown"), 404, "not_found"],
    [await app.request("/unknown"), 404, "not_found"],
  ] as const) {
    assert.equal(response.status, status);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, code);
    assert.ok(response.headers.get("X-Request-Id"));
  }
});
`;

const prettyTest = (logger: string) => `import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLogLine } from "./log-pretty.ts";
import { LOG_REDACT_PATHS } from "./${logger}";

test("an HTTP line is readable and keeps its fields", () => {
  const line = formatLogLine({
    level: 30,
    msg: "http request",
    requestId: "r",
    method: "GET",
    path: "/notes/1",
    route: "/notes/:id",
    status: 200,
    durationMs: 5,
  });
  assert.equal(line, "GET /notes/1 200 5ms  requestId=r route=/notes/:id");
});

test("secrets are on the redaction list", () => {
  for (const path of ["password", "*.password", "authorization", "*.authorization"]) {
    assert.ok(LOG_REDACT_PATHS.includes(path));
  }
});
`;

function moduleFiles(name: string, errors: string, handler: string, access: string, drizzle: boolean): Record<string, string> {
  const health = "src/modules/health", notes = "src/modules/notes";
  const fromRoutes = `${notes}/infrastructure/http/note-routes.ts`;
  const domain = `${notes}/domain/note.ts`;
  const useCase = (imports: string[], body: string) => [...imports, "", body].join("\n");
  const repository = 'import type { NoteRepository } from "../domain/note-repository.ts";';
  const noteType = 'import type { Note } from "../domain/note.ts";';
  return {
    [`${health}/domain/health.ts`]: `export type HealthCheck = { name: string; run: () => Promise<unknown> };
export type HealthReport = { status: "ok" | "degraded"; checks: Record<string, boolean> };

export function toReport(checks: Record<string, boolean>): HealthReport {
  return { status: Object.values(checks).every(Boolean) ? "ok" : "degraded", checks };
}
`,
    [`${health}/application/get-health.ts`]: `import { type HealthCheck, type HealthReport, toReport } from "../domain/health.ts";

${PASSES}
export async function getHealth(checks: HealthCheck[]): Promise<HealthReport> {
  return toReport(Object.fromEntries(await Promise.all(checks.map(passes))));
}
`,
    [`${health}/infrastructure/http/health-routes.ts`]: `import { Hono } from "hono";
import { getHealth } from "../../application/get-health.ts";
import type { HealthCheck } from "../../domain/health.ts";

export function healthRoutes(checks: HealthCheck[]) {
  return new Hono().get("/", async (c) => {
    const report = await getHealth(checks);
    return c.json(report, report.status === "ok" ? 200 : 503);
  });
}
`,
    [`${health}/index.ts`]: `export type { HealthCheck } from "./domain/health.ts";
export { healthRoutes } from "./infrastructure/http/health-routes.ts";
`,
    [domain]: `import { AppError } from "${importPath(domain, errors)}";

export type Note = { id: string; body: string; createdAt: string };

/** A rule of the domain: blank text is not a note. */
function cleanBody(body: string): string {
  const clean = body.trim();
  if (!clean) throw new AppError("invalid", "A note needs some text");
  return clean;
}

export function newNote(body: string): Note {
  return { id: crypto.randomUUID(), body: cleanBody(body), createdAt: new Date().toISOString() };
}

export function withBody(note: Note, body: string): Note {
  return { ...note, body: cleanBody(body) };
}
`,
    [`${notes}/domain/note-repository.ts`]: `import type { Note } from "./note.ts";

/** The port: the domain says what it needs, and infrastructure provides it. */
export type NoteRepository = {
  list(): Promise<Note[]>;
  find(id: string): Promise<Note | undefined>;
  save(note: Note): Promise<void>;
  delete(id: string): Promise<boolean>;
};
`,
    [`${notes}/application/list-notes.ts`]: useCase([noteType, repository], `export function listNotes(notes: NoteRepository): Promise<Note[]> {
  return notes.list();
}
`),
    [`${notes}/application/create-note.ts`]: useCase([`import { type Note, newNote } from "../domain/note.ts";`, repository], `export async function createNote(notes: NoteRepository, body: string): Promise<Note> {
  const note = newNote(body);
  await notes.save(note);
  return note;
}
`),
    [`${notes}/application/get-note.ts`]: useCase([`import { AppError } from "${importPath(`${notes}/application/get-note.ts`, errors)}";`, noteType, repository], `export async function getNote(notes: NoteRepository, id: string): Promise<Note> {
  const note = await notes.find(id);
  if (!note) throw new AppError("not_found", "Note not found");
  return note;
}
`),
    [`${notes}/application/update-note.ts`]: useCase([`import { type Note, withBody } from "../domain/note.ts";`, repository, 'import { getNote } from "./get-note.ts";'], `export async function updateNote(notes: NoteRepository, id: string, body: string): Promise<Note> {
  const note = withBody(await getNote(notes, id), body);
  await notes.save(note);
  return note;
}
`),
    [`${notes}/application/delete-note.ts`]: useCase([`import { AppError } from "${importPath(`${notes}/application/delete-note.ts`, errors)}";`, repository], `export async function deleteNote(notes: NoteRepository, id: string): Promise<void> {
  if (!(await notes.delete(id))) throw new AppError("not_found", "Note not found");
}
`),
    [`${notes}/infrastructure/http/note-schemas.ts`]: NOTE_INPUT,
    [fromRoutes]: `import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { rejectInvalid } from "${importPath(fromRoutes, handler)}";
import { createNote } from "../../application/create-note.ts";
import { deleteNote } from "../../application/delete-note.ts";
import { getNote } from "../../application/get-note.ts";
import { listNotes } from "../../application/list-notes.ts";
import { updateNote } from "../../application/update-note.ts";
import type { NoteRepository } from "../../domain/note-repository.ts";
import { noteInput } from "./note-schemas.ts";

/** Handlers stay beside their path and chained, which keeps types for \`hc\`. */
export function noteRoutes(notes: NoteRepository) {
  return new Hono()
    .get("/", async (c) => c.json(await listNotes(notes)))
    .post("/", zValidator("json", noteInput, rejectInvalid), async (c) => {
      return c.json(await createNote(notes, c.req.valid("json").body), 201);
    })
    .get("/:id", async (c) => c.json(await getNote(notes, c.req.param("id"))))
    .patch("/:id", zValidator("json", noteInput, rejectInvalid), async (c) => {
      return c.json(await updateNote(notes, c.req.param("id"), c.req.valid("json").body));
    })
    .delete("/:id", async (c) => {
      await deleteNote(notes, c.req.param("id"));
      return c.body(null, 204);
    });
}
`,
    [`${notes}/infrastructure/persistence/memory-note-repository.ts`]: `import type { Note } from "../../domain/note.ts";
import type { NoteRepository } from "../../domain/note-repository.ts";

/** Lost at restart: for tests, or until a database adapter of the same port takes over. */
export function memoryNoteRepository(): NoteRepository {
  const notes = new Map<string, Note>();
  return {
    list: async () => [...notes.values()],
    find: async (id) => notes.get(id),
    save: async (note) => {
      notes.set(note.id, note);
    },
    delete: async (id) => notes.delete(id),
  };
}
`,
    [`${notes}/index.ts`]: `export type { NoteRepository } from "./domain/note-repository.ts";
export { noteRoutes } from "./infrastructure/http/note-routes.ts";
${drizzle ? 'export { drizzleNoteRepository } from "./infrastructure/persistence/drizzle-note-repository.ts";\n' : ""}export { memoryNoteRepository } from "./infrastructure/persistence/memory-note-repository.ts";
`,
    ...(drizzle ? {
      [`${notes}/infrastructure/persistence/drizzle-note-repository.ts`]: drizzleAdapter([
        'import type { NoteRepository } from "../../domain/note-repository.ts";',
        'import { notes } from "./schema.ts";',
      ], "drizzleNoteRepository", "NoteRepository"),
    } : {}),
    "src/app.ts": appFile(name, [
      'import { type HealthCheck, healthRoutes } from "./modules/health/index.ts";',
      'import { type NoteRepository, noteRoutes } from "./modules/notes/index.ts";',
      `import { type AppEnv, accessLog } from "${importPath("src/app.ts", access)}";`,
      `import { handleError, handleNotFound } from "${importPath("src/app.ts", handler)}";`,
    ], "{ checks: HealthCheck[]; notes: NoteRepository }"),
    "src/app.test.ts": appTest(['import { memoryNoteRepository } from "./modules/notes/index.ts";'], "memoryNoteRepository()"),
  };
}

function standardFiles(name: string, errors: string, handler: string, access: string, drizzle: boolean): Record<string, string> {
  const service = "src/services/notes.ts", routes = "src/routes/notes.ts";
  return {
    "src/routes/health.ts": `import { Hono } from "hono";

export type HealthCheck = { name: string; run: () => Promise<unknown> };

${PASSES}
export function healthRoutes(checks: HealthCheck[]) {
  return new Hono().get("/", async (c) => {
    const results = await Promise.all(checks.map(passes));
    const healthy = results.every(([, ok]) => ok);
    const status = healthy ? "ok" : "degraded";
    return c.json({ status, checks: Object.fromEntries(results) }, healthy ? 200 : 503);
  });
}
`,
    "src/schemas/notes.ts": NOTE_INPUT,
    [service]: `import { AppError } from "${importPath(service, errors)}";

export type Note = { id: string; body: string; createdAt: string };
export type NoteStore = {
  list(): Promise<Note[]>;
  find(id: string): Promise<Note | undefined>;
  save(note: Note): Promise<void>;
  delete(id: string): Promise<boolean>;
};

/** Lost at restart: for tests, or until a database store takes over. */
export function memoryNoteStore(): NoteStore {
  const notes = new Map<string, Note>();
  return {
    list: async () => [...notes.values()],
    find: async (id) => notes.get(id),
    save: async (note) => {
      notes.set(note.id, note);
    },
    delete: async (id) => notes.delete(id),
  };
}

function cleanBody(body: string): string {
  const clean = body.trim();
  if (!clean) throw new AppError("invalid", "A note needs some text");
  return clean;
}

export function listNotes(notes: NoteStore): Promise<Note[]> {
  return notes.list();
}

export async function getNote(notes: NoteStore, id: string): Promise<Note> {
  const note = await notes.find(id);
  if (!note) throw new AppError("not_found", "Note not found");
  return note;
}

export async function createNote(notes: NoteStore, body: string): Promise<Note> {
  const note = {
    id: crypto.randomUUID(),
    body: cleanBody(body),
    createdAt: new Date().toISOString(),
  };
  await notes.save(note);
  return note;
}

export async function updateNote(notes: NoteStore, id: string, body: string): Promise<Note> {
  const note = { ...(await getNote(notes, id)), body: cleanBody(body) };
  await notes.save(note);
  return note;
}

export async function deleteNote(notes: NoteStore, id: string): Promise<void> {
  if (!(await notes.delete(id))) throw new AppError("not_found", "Note not found");
}
`,
    ...(drizzle ? {
      "src/services/drizzle-note-store.ts": drizzleAdapter([
        'import { notes } from "../lib/schema.ts";',
        'import type { NoteStore } from "./notes.ts";',
      ], "drizzleNoteStore", "NoteStore"),
    } : {}),
    [routes]: `import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { rejectInvalid } from "${importPath(routes, handler)}";
import { noteInput } from "../schemas/notes.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  type NoteStore,
  updateNote,
} from "../services/notes.ts";

/** Handlers stay beside their path and chained, which keeps types for \`hc\`. */
export function noteRoutes(notes: NoteStore) {
  return new Hono()
    .get("/", async (c) => c.json(await listNotes(notes)))
    .post("/", zValidator("json", noteInput, rejectInvalid), async (c) => {
      return c.json(await createNote(notes, c.req.valid("json").body), 201);
    })
    .get("/:id", async (c) => c.json(await getNote(notes, c.req.param("id"))))
    .patch("/:id", zValidator("json", noteInput, rejectInvalid), async (c) => {
      return c.json(await updateNote(notes, c.req.param("id"), c.req.valid("json").body));
    })
    .delete("/:id", async (c) => {
      await deleteNote(notes, c.req.param("id"));
      return c.body(null, 204);
    });
}
`,
    "src/app.ts": appFile(name, [
      `import { type AppEnv, accessLog } from "${importPath("src/app.ts", access)}";`,
      `import { handleError, handleNotFound } from "${importPath("src/app.ts", handler)}";`,
      'import { type HealthCheck, healthRoutes } from "./routes/health.ts";',
      'import { noteRoutes } from "./routes/notes.ts";',
      'import type { NoteStore } from "./services/notes.ts";',
    ], "{ checks: HealthCheck[]; notes: NoteStore }"),
    "src/app.test.ts": appTest(['import { memoryNoteStore } from "./services/notes.ts";'], "memoryNoteStore()"),
  };
}

/** The Hono application itself: one layout per code structure, with the same behavior. */
export function honoFiles(name: string, modules: boolean, drizzle: boolean): Record<string, string> {
  const lib = modules ? "src/shared/infrastructure" : "src/lib";
  const http = modules ? `${lib}/http` : "src/middleware";
  const errors = modules ? "src/shared/domain/errors.ts" : "src/lib/errors.ts";
  const logger = `${lib}/logger.ts`, access = `${http}/access-log.ts`, handler = `${http}/error-handler.ts`;
  return {
    [errors]: ERRORS,
    [logger]: LOGGER,
    [`${lib}/log-pretty.ts`]: LOG_PRETTY,
    [`${lib}/log-pretty.test.ts`]: prettyTest("logger.ts"),
    [access]: accessLog(importPath(access, logger)),
    [handler]: errorHandler(importPath(handler, errors), importPath(handler, logger)),
    ...(modules ? moduleFiles : standardFiles)(name, errors, handler, access, drizzle),
  };
}
