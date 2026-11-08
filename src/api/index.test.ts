import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DevHubError, type AppServices, type ContainerLogLine, type FollowHandle, type Operation, type Project } from "../contracts";
import type { LogEntry } from "../contracts";
import { createApp, issuePairingCode } from "./index";

const fixtures: string[] = [];
const project: Project = {
  id: "sample", name: "Sample", root: "/tmp/sample", createdAt: new Date(0).toISOString(),
  components: [{ id: "api", name: "API", kind: "native", cwd: "/tmp/sample", argv: ["SENTINEL_ARGV"], envFiles: ["SENTINEL_ENV"], validation: { argv: ["SENTINEL_VALIDATE"] }, dependsOn: [] }],
};

function setup(now = () => Date.now()) {
  const follow = { start: async (_id: string, _since: string | undefined, _onLine: (line: ContainerLogLine) => void): Promise<FollowHandle> => ({ stop() {}, done: Promise.resolve(0) }) };
  const stateDir = mkdtempSync(join("/dev/shm", "devhub-api-test-")); fixtures.push(stateDir);
  const code = "PAIRING_TEST_CODE_" + "x".repeat(40);
  const calls: unknown[][] = [];
  const operations: Operation[] = [];
  const pendingLogs: { current?: Promise<LogEntry[]> } = {};
  const variants: Array<{ id: string; parent: string; branch: string }> = [];
  const services = {
    catalog: {
      listRoots: () => [{ id: "root", path: "/tmp/approved", label: "Approved" }],
      listDirectories: async (path?: string) => { if (path === "/missing") throw new DevHubError("This folder does not exist", "path_not_found", 404); return { path: path ?? "/home/you", parent: "/", places: ["/"], entries: [] }; },
      assertAllowedPath: (path: string) => { if (!path.startsWith("/tmp/approved")) throw new Error("path denied"); return path; },
      listProjects: () => [project], getProject: () => project, removeProject: () => {},
    },
    discovery: {
      presets: () => [{ id: "native", name: "Native", description: "Native app" }],
      scan: async () => [], preview: async () => { throw new Error("not used"); }, apply: async () => project,
    },
    operations: {
      listOperations: () => operations, status: async () => ({ projectId: "sample", components: [] }),
      submit: (...args: unknown[]) => { calls.push(args); return { id: "op1", projectId: "sample", action: "start", componentIds: ["api"], state: "queued", createdAt: "now", updatedAt: "now" }; },
      getOperation: () => { throw new Error("not found"); },
      logs: () => pendingLogs.current ?? Promise.resolve([{ seq: 1, time: "now", projectId: "sample", componentId: "api", stream: "stdout", message: "safe" }]),
      inventory: async () => [],
      followContainer: (id: string, since: string | undefined, onLine: (line: ContainerLogLine) => void) => follow.start(id, since, onLine),
    },
    create: { plan: async (input: object, draft?: boolean) => ({ ...input, draft }) },
    worktrees: { list: () => variants, get: (id: string) => variants.find((item) => item.id === id) },
    maintenance: { scan: async () => { throw new Error("not used"); }, listScans: () => [], getScan: () => { throw new Error("not used"); }, preview: async () => { throw new Error("not used"); }, apply: async () => { throw new Error("not used"); }, validate: async () => { throw new Error("not used"); }, activate: async () => { throw new Error("not used"); }, listChanges: () => [] },
  } as unknown as AppServices;
  const app = createApp(services, { stateDir, pairingCode: code, origins: ["http://127.0.0.1:8040"], hostnames: ["127.0.0.1:8040"], now });
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { host: "127.0.0.1:8040", ...init.headers as Record<string, string> } });
  return { app, code, calls, follow, operations, pendingLogs, request, stateDir, variants };
}

async function paired(context: ReturnType<typeof setup>) {
  const response = await context.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: context.code }) });
  const cookie = response.headers.get("set-cookie")!;
  return { response, cookie, auth: { cookie, origin: "http://127.0.0.1:8040", "content-type": "application/json" } };
}

afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("local API authentication", () => {
  test("removes a project with the JSON request the panel sends, and refuses one without that content type", async () => {
    const context = setup();
    const { cookie, auth } = await paired(context);
    expect((await context.request("/api/v1/projects/sample", { method: "DELETE", headers: { cookie, origin: "http://127.0.0.1:8040" } })).status).toBe(400);
    const response = await context.request("/api/v1/projects/sample", { method: "DELETE", headers: auth, body: "{}" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ removed: true });
  });

  test("marks a worktree with its parent and refuses to only unregister it", async () => {
    const context = setup();
    const { auth } = await paired(context);
    context.variants.push({ id: "sample", parent: "shop", branch: "fix/auth" });
    expect((await (await context.request("/api/v1/projects", { headers: auth })).json()).data[0].worktree).toEqual({ parent: "shop", branch: "fix/auth" });
    const response = await context.request("/api/v1/projects/sample", { method: "DELETE", headers: auth, body: "{}" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("devhub worktree remove sample");
  });

  test("requires a session on read and mutation routes, then pairs once and revokes on logout", async () => {
    const context = setup();
    const protectedRoutes: Array<[string, string]> = [
      ["/api/v1/session", "GET"], ["/api/v1/logout", "POST"], ["/api/v1/roots", "GET"], ["/api/v1/directories", "GET"], ["/api/v1/presets", "GET"],
      ["/api/v1/discovery", "POST"], ["/api/v1/projects/preview", "POST"], ["/api/v1/projects", "GET"], ["/api/v1/projects", "POST"],
      ["/api/v1/projects/sample", "DELETE"], ["/api/v1/projects/sample/status", "GET"], ["/api/v1/projects/sample/operations", "GET"], ["/api/v1/projects/sample/operations", "POST"],
      ["/api/v1/projects/sample/logs", "GET"], ["/api/v1/operations/op1", "GET"], ["/api/v1/containers", "GET"], ["/api/v1/scans", "GET"],
      ["/api/v1/scans", "POST"], ["/api/v1/scans/scan1", "GET"], ["/api/v1/remediation", "GET"],
      ["/api/v1/remediation/preview", "POST"], ["/api/v1/remediation/apply", "POST"],
    ];
    for (const [path, method] of protectedRoutes) {
      const response = await context.request(path, { method, headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(response.status).toBe(401);
    }
    const { response: pairedResponse, cookie, auth } = await paired(context);
    expect(pairedResponse.status).toBe(200);
    expect(pairedResponse.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/api/v1");
    expect(await pairedResponse.text()).not.toContain(cookie.split("=")[1]!.split(";")[0]!);
    expect((await context.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: context.code }) })).status).toBe(401);
    expect((await context.request("/api/v1/session", { headers: { cookie } })).status).toBe(200);
    const logout = await context.request("/api/v1/logout", { method: "POST", headers: auth, body: "{}" });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await context.request("/api/v1/session", { headers: { cookie } })).status).toBe(401);
  });

  test("rejects bad Host and Origin, requires JSON, and caps streaming bodies", async () => {
    const context = setup(); const { cookie } = await paired(context);
    expect((await context.app.request("/api/v1/session", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await context.request("/api/v1/session", { headers: { origin: "http://localhost:8040" } })).status).toBe(403);
    expect((await context.request("/api/v1/projects/preview", { method: "POST", headers: { cookie, origin: "http://127.0.0.1:8040" }, body: "{}" })).status).toBe(400);
    const tooLarge = "x".repeat(65_536);
    const response = await context.request("/api/v1/projects/preview", { method: "POST", headers: { cookie, origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ path: tooLarge }) });
    expect(response.status).toBe(413);
  });

  test("a creation preview takes a multi-line Dockerfile but keeps checking the other Docker fields", async () => {
    const context = setup(); const { auth } = await paired(context);
    const body = (docker: unknown) => JSON.stringify({ stack: "php", name: "Shop", rootId: "root", mode: "docker", options: {}, services: [], docker, git: true });
    const preview = (docker: unknown) => context.request("/api/v1/creations/preview", { method: "POST", headers: auth, body: body(docker) });
    expect((await preview({ dockerfile: "FROM php:8.5\nRUN id\n" })).status).toBe(200);
    expect((await preview({ image: "php\nRUN id" })).status).toBe(400);
    expect((await preview({ unknown: "x" })).status).toBe(400);
  });

  test("a creation preview takes edited agent instructions, but no other file", async () => {
    const context = setup(); const { auth } = await paired(context);
    const preview = (instructions: unknown) => context.request("/api/v1/creations/preview", { method: "POST", headers: auth, body: JSON.stringify({ stack: "node", name: "Shop", rootId: "root", mode: "docker", options: {}, services: [], instructions, git: true }) });
    expect((await preview({ "AGENTS.md": "# Mine\n\n- Rule\n" })).status).toBe(200);
    expect((await preview({ "CLAUDE.md": "x" })).status).toBe(400);
    expect((await preview({ "../evil": "x" })).status).toBe(400);
    expect((await preview({ "AGENTS.md": 1 })).status).toBe(400);
    const creation = await context.request("/api/v1/creations", { method: "POST", headers: auth, body: JSON.stringify({ stack: "node", name: "Shop", rootId: "root", mode: "docker", options: {}, services: [], instructions: { "../evil": "x" }, git: true }) });
    expect(creation.status).toBe(400);
  });

  test("a creation preview without a name is a draft, and a creation still needs the name", async () => {
    const context = setup(); const { auth } = await paired(context);
    const body = JSON.stringify({ stack: "node", mode: "docker", options: {}, services: [], git: true });
    const preview = await context.request("/api/v1/creations/preview", { method: "POST", headers: auth, body });
    expect(preview.status).toBe(200);
    const { data } = await preview.json();
    expect(data.name).toBe("my-project");
    expect(data.draft).toBe(true);
    expect((await context.request("/api/v1/creations", { method: "POST", headers: auth, body })).status).toBe(400);
    const named = JSON.stringify({ ...JSON.parse(body), name: "Shop", rootId: "root" });
    expect((await (await context.request("/api/v1/creations/preview", { method: "POST", headers: auth, body: named })).json()).data.draft).toBe(false);
  });

  test("lists folders of a requested path, defaults to home, and maps errors", async () => {
    const context = setup();
    const { cookie } = await paired(context);
    const list = (query = "") => context.request(`/api/v1/directories${query}`, { headers: { cookie } });
    expect((await (await list()).json()).data.path).toBe("/home/you");
    expect((await (await list("?path=%2Fsrv%2Fcode")).json()).data.path).toBe("/srv/code");
    const missing = await list("?path=%2Fmissing");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("path_not_found");
    expect((await list("?path=")).status).toBe(400);
  });

  test("uses submit for 202 operations and rejects surplus command fields", async () => {
    const context = setup(); const { cookie } = await paired(context);
    const headers = { cookie, origin: "http://127.0.0.1:8040", "content-type": "application/json", "idempotency-key": "request-1" };
    const accepted = await context.request("/api/v1/projects/sample/operations", { method: "POST", headers, body: JSON.stringify({ action: "start", componentIds: ["api"] }) });
    expect(accepted.status).toBe(202);
    expect(context.calls).toHaveLength(1);
    expect(context.calls[0]).toEqual(["sample", "start", ["api"], "request-1"]);
    const rejected = await context.request("/api/v1/projects/sample/operations", { method: "POST", headers, body: JSON.stringify({ action: "start", argv: ["SENTINEL_ARGV"] }) });
    expect(rejected.status).toBe(400);
    const publicProjects = JSON.stringify(await (await context.request("/api/v1/projects")).json());
    expect(publicProjects).not.toContain("SENTINEL_ARGV");
    expect(publicProjects).not.toContain("SENTINEL_ENV");
    expect(publicProjects).not.toContain("SENTINEL_VALIDATE");
  });

  test("expires pairing codes and enforces the persisted per-minute attempt limit", async () => {
    let now = Date.now();
    const context = setup(() => now);
    now += 5 * 60_001;
    const expired = await context.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: context.code }) });
    expect(expired.status).toBe(401);
    const other = setup(() => now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await other.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: "wrong-code" }) });
      expect(response.status).toBe(401);
    }
    const limited = await other.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: other.code }) });
    expect(limited.status).toBe(429);
  });

  test("issues private pairing state and streams finite log events with disconnect cleanup", async () => {
    const context = setup();
    const issued = issuePairingCode(context.stateDir);
    expect(issued.code.length).toBeGreaterThanOrEqual(40);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const pairResponse = await context.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: issued.code }) });
    const cookie = pairResponse.headers.get("set-cookie")!;
    expect(pairResponse.status).toBe(200);
    const response = await context.request("/api/v1/projects/sample/logs?cursor=0&limit=10", { headers: { cookie, "last-event-id": "0" } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain("event: log");
    await reader.cancel();
  });

  test("streams redacted container logs and stops the follower on disconnect", async () => {
    const context = setup(); const session = await paired(context), id = "a".repeat(64);
    let stopped = 0, since: string | undefined;
    context.follow.start = async (_id, from, onLine) => {
      since = from;
      onLine({ time: "2026-11-03T22:00:00.000000000Z", stream: "stderr", message: "password=hunter2 ready" });
      return { stop: () => { stopped += 1; }, done: new Promise(() => {}) };
    };
    const response = await context.request(`/api/v1/containers/${id}/logs?since=2026-11-03T21:00:00.5Z`, { headers: { cookie: session.cookie } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: log");
    expect(text).toContain('"stream":"stderr"');
    expect(text).not.toContain("hunter2");
    expect(since).toBe("2026-11-03T21:00:00.5Z");
    await reader.cancel();
    expect(stopped).toBe(1);
  });

  test("skips container log lines over the rate budget and reports how many", async () => {
    const context = setup(); const session = await paired(context);
    context.follow.start = async (_id, _since, onLine) => {
      for (let index = 0; index < 650; index += 1) onLine({ time: "2026-11-03T22:00:00.000000000Z", stream: "stdout", message: `line ${index}` });
      return { stop() {}, done: Promise.resolve(0) };
    };
    const response = await context.request(`/api/v1/containers/${"b".repeat(12)}/logs`, { headers: { cookie: session.cookie } });
    const text = await response.text();
    expect(text.match(/event: log/g)?.length).toBe(500);
    expect(text).toContain('event: dropped\ndata: {"count":150}');
  });

  test("reports a failing docker logs and keeps stack trace indentation", async () => {
    const context = setup(); const session = await paired(context);
    context.follow.start = async (_id, _since, onLine) => {
      onLine({ time: "2026-11-03T22:00:00.000000000Z", stream: "stderr", message: "    at main (app.ts:1)" });
      return { stop() {}, done: Promise.resolve(1) };
    };
    const text = await (await context.request(`/api/v1/containers/${"c".repeat(12)}/logs`, { headers: { cookie: session.cookie } })).text();
    expect(text).toContain('"message":"    at main (app.ts:1)"');
    expect(text).toContain("event: error");
  });

  test("refuses malformed container log queries before following", async () => {
    const context = setup(); const session = await paired(context);
    context.follow.start = async () => { throw new Error("must not run"); };
    for (const path of ["--help/logs", `${"a".repeat(64)}/logs?since=yesterday`]) {
      expect((await context.request(`/api/v1/containers/${path}`, { headers: { cookie: session.cookie } })).status).toBe(400);
    }
  });

  test("expires authenticated sessions after eight hours and caps concurrent log streams", async () => {
    let now = Date.now();
    const context = setup(() => now);
    const { cookie } = await paired(context);
    now += 8 * 60 * 60_000 + 1;
    expect((await context.request("/api/v1/session", { headers: { cookie } })).status).toBe(401);

    const current = setup(); const session = await paired(current);
    const responses: Response[] = [];
    for (let index = 0; index < 32; index += 1) {
      responses.push(await current.request("/api/v1/projects/sample/logs", { headers: { cookie: session.cookie } }));
    }
    const limited = await current.request("/api/v1/projects/sample/logs", { headers: { cookie: session.cookie } });
    expect(limited.status).toBe(429);
    await Promise.all(responses.map((response) => response.body!.cancel()));
  });

  test("never returns argv, env files or validation commands and refuses unmapped remediation sources", async () => {
    const context = setup();
    const { auth } = await paired(context);
    for (const path of ["/api/v1/projects", "/api/v1/projects/sample/status"]) {
      const text = await (await context.request(path, { headers: { cookie: auth.cookie } })).text();
      expect(text).not.toContain("SENTINEL");
    }
    const preview = await context.request("/api/v1/remediation/preview", { method: "POST", headers: auth, body: JSON.stringify({ projectId: "sample", componentId: "api", file: "Dockerfile", replacement: "node:22" }) });
    expect(preview.status).toBe(400);
    expect((await preview.json()).error.code).toBe("source_forbidden");
    const command = await context.request("/api/v1/projects/sample/operations", { method: "POST", headers: auth, body: JSON.stringify({ action: "start", argv: ["sh", "-c", "id"] }) });
    expect(command.status).toBe(400);
  });
});

describe("project operation history", () => {
  test("returns the newest operations without their private fields, so the history survives a reload", async () => {
    const context = setup();
    const { auth } = await paired(context);
    context.operations.push(...Array.from({ length: 25 }, (_, index): Operation => ({ id: `op${index}`, projectId: "sample", action: "start", componentIds: ["api"], state: "succeeded", createdAt: "now", updatedAt: "now", idempotencyKey: "SENTINEL_KEY" })));
    const response = await context.request("/api/v1/projects/sample/operations", { headers: auth });
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: Operation[] };
    expect(data.map((operation) => operation.id)).toEqual(Array.from({ length: 20 }, (_, index) => `op${index + 5}`));
    expect(JSON.stringify(data)).not.toContain("SENTINEL_KEY");
  });
});

describe("project log stream", () => {
  test("a client that leaves during a read ends the stream quietly", async () => {
    const context = setup();
    const { auth } = await paired(context);
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", record);
    try {
      for (const failed of [false, true]) {
        let entries!: (value: LogEntry[]) => void, failure!: (reason: Error) => void;
        context.pendingLogs.current = new Promise<LogEntry[]>((resolve, reject) => { entries = resolve; failure = reject; });
        const response = await context.request("/api/v1/projects/sample/logs?limit=10", { headers: auth });
        await response.body!.cancel();
        if (failed) failure(new Error("read failed"));
        else entries([{ seq: 1, time: "now", projectId: "sample", componentId: "api", stream: "stdout", message: "late" }]);
        await Bun.sleep(5);
      }
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", record); }
  });
});
