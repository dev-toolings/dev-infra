import { expect, test } from "bun:test";
import {
  redactLogLine,
  createLogger,
  formatLogLine,
  LOG_REDACT_PATHS,
  REDACTED,
  redactFields,
  redactText,
  SENSITIVE_KEY_NAMES,
} from "./logger";

const fixedNow = () => new Date("2026-10-29T12:34:56.789Z");

test("production logger emits bounded structured JSON with injected time", () => {
  const line = formatLogLine("info", "operation completed", {
    operationId: "op-123",
    password: "do-not-print",
  }, { mode: "production", now: fixedNow });

  expect(JSON.parse(line)).toEqual({
    time: "2026-10-29T12:34:56.789Z",
    level: "info",
    msg: "operation completed",
    operationId: "op-123",
    password: REDACTED,
  });
  expect(line.length).toBeLessThanOrEqual(8192);
});

test("development logger formats HTTP access lines and colors through pipes", () => {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const line = formatLogLine("info", "http request", {
      method: "GET",
      path: "/api/items?token=private",
      route: "/api/items/:id",
      status: 200,
      durationMs: 55,
      requestId: "req-7",
    }, { mode: "development", color: true, now: fixedNow });
    const plain = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

    expect(plain).toContain("[12:34:56.789]");
    expect(plain).toContain("GET /api/items/:id");
    expect(plain).toContain("200 55ms");
    expect(plain).toContain("requestId=req-7");
    expect(line).toContain("\u001b[32mINFO\u001b[0m");
    expect(line).toContain("\u001b[32m200\u001b[0m");
    expect(line).not.toContain("private");
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test("NO_COLOR disables ANSI even when color is requested", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "";
  try {
    const line = formatLogLine("warn", "check", { status: 503 }, {
      mode: "development",
      color: true,
      now: fixedNow,
    });
    expect(line).not.toContain("\u001b[");
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test("logger uses injected sink and clock and filters lower levels", () => {
  const lines: string[] = [];
  const log = createLogger({
    mode: "production",
    level: "warn",
    write: (line) => lines.push(line),
    now: fixedNow,
  });

  expect(lines).toEqual([]);
  log.info({ event: "ignored" }, "quiet");
  log.error({ operationId: "op-9" }, "failed");

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    time: "2026-10-29T12:34:56.789Z",
    level: "error",
    msg: "failed",
    operationId: "op-9",
  });
});

test("redacts nested secret fields, credential text, URL credentials, query secrets, and emails without mutation", () => {
  const fields = {
    requestId: "req-safe",
    userEmail: "dev@example.test",
    auth: "private-auth-value",
    sessionId: "private-session-value",
    body: { text: "private request content" },
    rawRequestBody: "private raw request content",
    nested: {
      apiKey: "key-value",
      message: "Authorization: Bearer abc123 https://alice:pw@example.test/p?access_token=query-secret&mode=dev",
      note: "password='phrase with spaces' contact dev@example.test",
    },
  };
  const before = structuredClone(fields);
  const safe = redactFields(fields);
  const serialized = JSON.stringify(safe);

  expect(fields).toEqual(before);
  expect(safe.requestId).toBe("req-safe");
  expect(safe.userEmail).toBe(REDACTED);
  expect(safe.auth).toBe(REDACTED);
  expect(safe.sessionId).toBe(REDACTED);
  expect(safe.body).toBe(REDACTED);
  expect(safe.rawRequestBody).toBe(REDACTED);
  expect(serialized).not.toContain("key-value");
  expect(serialized).not.toContain("abc123");
  expect(serialized).not.toContain("alice:pw");
  expect(serialized).not.toContain("query-secret");
  expect(serialized).not.toContain("phrase with spaces");
  expect(serialized).not.toContain("dev@example.test");
  expect(serialized).toContain("mode=dev");
  expect(LOG_REDACT_PATHS).toContain("*.token");
  expect(LOG_REDACT_PATHS).toContain("*.authorization");
  expect(LOG_REDACT_PATHS).toContain("*.cookie");
  expect(SENSITIVE_KEY_NAMES).toContain("authorization");
});

test("redactText removes terminal controls and redacts free-standing credentials", () => {
  const text = redactText("\u001b[31mtoken=unsafe\u001b[0m email dev@example.test\nnext line");
  expect(text).toBe("token=[redacted] email [redacted] next line");
  expect(text).not.toContain("\u001b");
});

test("nested data, errors, cycles, and excessive entries stay bounded", () => {
  const cyclic: Record<string, unknown> = { status: "ok" };
  cyclic.self = cyclic;
  cyclic.deep = { a: { b: { c: { d: { e: "hidden below depth limit" } } } } };
  const error = new Error("operation failed token=private");
  error.stack = "sensitive stack contents";
  cyclic.error = error;
  cyclic.long = "x".repeat(9000);
  for (let index = 0; index < 100; index += 1) cyclic[`field${index}`] = index;

  const safe = redactFields(cyclic);
  const serialized = JSON.stringify(safe);

  expect(safe.self).toBe("[circular]");
  expect(serialized).toContain("[max-depth]");
  expect(serialized).toContain("[truncated]");
  expect(serialized).not.toContain("sensitive stack contents");
  expect(serialized).not.toContain("token=private");
  expect(serialized.length).toBeLessThanOrEqual(8192);
  expect(Object.keys(safe).length).toBeLessThanOrEqual(65);

  const manyFields = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field${index}`, "v".repeat(900)]));
  const line = formatLogLine("info", "large event", manyFields, { mode: "production", now: fixedNow });
  expect(line.length).toBeLessThanOrEqual(8192);
  expect(() => JSON.parse(line)).not.toThrow();
});

 test("cookie headers and prototype-shaped fields cannot leak or forge an HTTP line", () => {
  expect(redactText("Cookie: first=secret-one; second=secret-two")).toBe("Cookie: [redacted]");
  expect(redactFields({pass:"secret",pwd:"secret"})).toMatchObject({pass:REDACTED,pwd:REDACTED});
  const fields = JSON.parse('{"__proto__":{"method":"GET","path":"/forged","status":200,"durationMs":1},"event":"actual"}');
  const line = formatLogLine("info","actual message",fields,{mode:"development",color:false,now:fixedNow});
  expect(line).toContain("actual message");
  expect(line).not.toContain("GET /forged 200");
  expect(Object.hasOwn(redactFields(fields),"__proto__")).toBe(true);
});

test("container log lines keep JSON valid, colors and spacing, but never a secret", () => {
  const json = JSON.parse(redactLogLine(JSON.stringify({ message: "password=hunter2 ok", context: { token: "abc", big: "x".repeat(3000) }, level_name: "INFO" })));
  expect(json).toMatchObject({ message: "password=[redacted] ok", context: { token: "[redacted]" }, level_name: "INFO" });
  expect(json.context.big.length).toBe(3000);

  expect(redactLogLine("\u001b[32m  INFO\u001b[0m   app  started\u0007\u001b]0;title\u0007")).toBe("\u001b[32m  INFO\u001b[0m   app  started");
  expect(redactLogLine("\tat main (app.ts:1)")).toBe("\tat main (app.ts:1)");

  const colored = redactLogLine("\u001b[31mpassword=\u001b[0mhunter2 next");
  expect(colored).not.toContain("hunter2");
  expect(colored).not.toContain("\u001b");

  expect(redactLogLine("{not json password=hunter2")).not.toContain("hunter2");
});
