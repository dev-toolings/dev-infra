import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppServices, Project } from "../contracts";
import { createApp, issuePairingCode } from "./index";

const fixtures: string[] = [];
const project: Project = {
  id: "sample", name: "Sample", root: "/tmp/sample", createdAt: new Date(0).toISOString(),
  components: [{ id: "api", name: "API", kind: "native", cwd: "/tmp/sample", argv: ["SENTINEL_ARGV"], envFiles: ["SENTINEL_ENV"], validation: { argv: ["SENTINEL_VALIDATE"] }, dependsOn: [] }],
};

function setup(now = () => Date.now()) {
  const stateDir = mkdtempSync(join("/dev/shm", "devhub-api-test-")); fixtures.push(stateDir);
  const code = "PAIRING_TEST_CODE_" + "x".repeat(40);
  const calls: unknown[][] = [];
  const services = {
    catalog: {
      listRoots: () => [{ id: "root", path: "/tmp/approved", label: "Approved" }],
      assertAllowedPath: (path: string) => { if (!path.startsWith("/tmp/approved")) throw new Error("path denied"); return path; },
      listProjects: () => [project], getProject: () => project, removeProject: () => {},
    },
    discovery: {
      presets: () => [{ id: "native", name: "Native", description: "Native app" }],
      scan: async () => [], preview: async () => { throw new Error("not used"); }, apply: async () => project,
    },
    operations: {
      listOperations: () => [], status: async () => ({ projectId: "sample", components: [] }),
      submit: (...args: unknown[]) => { calls.push(args); return { id: "op1", projectId: "sample", action: "start", componentIds: ["api"], state: "queued", createdAt: "now", updatedAt: "now" }; },
      getOperation: () => { throw new Error("not found"); },
      logs: async () => [{ seq: 1, time: "now", projectId: "sample", componentId: "api", stream: "stdout", message: "safe" }],
      inventory: async () => [],
    },
    maintenance: { scan: async () => { throw new Error("not used"); }, listScans: () => [], getScan: () => { throw new Error("not used"); }, preview: async () => { throw new Error("not used"); }, apply: async () => { throw new Error("not used"); }, validate: async () => { throw new Error("not used"); }, activate: async () => { throw new Error("not used"); }, listChanges: () => [] },
  } as unknown as AppServices;
  const app = createApp(services, { stateDir, pairingCode: code, origins: ["http://127.0.0.1:8040"], hostnames: ["127.0.0.1:8040"], now });
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { host: "127.0.0.1:8040", ...init.headers as Record<string, string> } });
  return { app, code, calls, request, stateDir };
}

async function paired(context: ReturnType<typeof setup>) {
  const response = await context.request("/api/v1/pair", { method: "POST", headers: { origin: "http://127.0.0.1:8040", "content-type": "application/json" }, body: JSON.stringify({ code: context.code }) });
  const cookie = response.headers.get("set-cookie")!;
  return { response, cookie, auth: { cookie, origin: "http://127.0.0.1:8040", "content-type": "application/json" } };
}

afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("local API authentication", () => {
  test("requires a session on read and mutation routes, then pairs once and revokes on logout", async () => {
    const context = setup();
    const protectedRoutes: Array<[string, string]> = [
      ["/api/v1/session", "GET"], ["/api/v1/logout", "POST"], ["/api/v1/roots", "GET"], ["/api/v1/presets", "GET"],
      ["/api/v1/discovery", "POST"], ["/api/v1/projects/preview", "POST"], ["/api/v1/projects", "GET"], ["/api/v1/projects", "POST"],
      ["/api/v1/projects/sample", "DELETE"], ["/api/v1/projects/sample/status", "GET"], ["/api/v1/projects/sample/operations", "POST"],
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
