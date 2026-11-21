import { expect, test } from "bun:test";
import { DevHubError, type AppServices } from "../contracts";
import { handleMcp, mcpTools } from "./index";

const services = {
  catalog: { listProjects: () => [], getProject: () => { throw new DevHubError("Project not found", "not_found", 404); } },
  operations: {},
  projects: { exec: async () => ({ code: 1, stdout: "ok\n", stderr: "DATABASE_URL=postgres://u:secretpassword@h/db\n" }) },
  environments: {
    list: () => [],
    exec: async (id: string, service: string, argv: string[], timeout: number) => ({ code: 0, stdout: JSON.stringify({ id, service, argv, timeout }), stderr: "" }),
  },
} as unknown as AppServices;
const tools = mcpTools(services);
const call = (method: string, params?: Record<string, unknown>) => handleMcp({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, tools);

test("initialize announces tools only, and a notification gets no answer", async () => {
  expect(await call("initialize", { protocolVersion: "2025-06-18" })).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "devhub" } } });
  expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, tools)).toBeUndefined();
  expect(await call("resources/list")).toMatchObject({ error: { code: -32601 } });
});

test("tools are listed without their handlers and their errors come back as tool errors", async () => {
  const listed = (await call("tools/list"))!.result as { tools: Array<Record<string, unknown>> };
  expect(listed.tools.map((tool) => tool.name)).toEqual(["projects_list", "feature_create", "feature_status", "feature_exec", "feature_destroy", "project_action", "project_status", "project_logs", "exec"]);
  expect(listed.tools.every((tool) => !("call" in tool))).toBe(true);
  expect(await call("tools/call", { name: "project_action", arguments: { project: "x", action: "start" } })).toMatchObject({ result: { isError: true, content: [{ text: "Project not found" }] } });
  expect(await call("tools/call", { name: "feature_create", arguments: { project: 1 } })).toMatchObject({ result: { isError: true, content: [{ text: "project must be a string" }] } });
  expect(await call("tools/call", { name: "nope" })).toMatchObject({ error: { code: -32602 } });
});

test("exec output reaches the agent with its secrets redacted", async () => {
  const reply = await call("tools/call", { name: "exec", arguments: { project: "shop", command: "env" } });
  const text = (reply!.result as { content: Array<{ text: string }> }).content[0]!.text;
  expect(text).toStartWith("exit code 1\n--- stdout\nok\n");
  expect(text).not.toContain("secretpassword");
});

test("feature_exec runs a shell command in the app service of the feature by default", async () => {
  const reply = await call("tools/call", { name: "feature_exec", arguments: { id: "ef-1", command: "bun test", timeoutSeconds: 30 } });
  const text = (reply!.result as { content: Array<{ text: string }> }).content[0]!.text;
  expect(JSON.parse(text.split("\n")[2]!)).toEqual({ id: "ef-1", service: "app", argv: ["sh", "-c", "bun test"], timeout: 30_000 });
});

test("feature_exec returns long output whole, with its secrets redacted", async () => {
  const long = { ...services, environments: { ...services.environments, exec: async () => ({ code: 0, stdout: `${"x".repeat(20_000)}\nTOKEN=fixture-secret-value\n`, stderr: "" }) } } as unknown as AppServices;
  const reply = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feature_exec", arguments: { id: "ef-1", command: "cat big" } } }, mcpTools(long));
  const text = (reply!.result as { content: Array<{ text: string }> }).content[0]!.text;
  expect(text).toContain("x".repeat(20_000));
  expect(text).not.toContain("fixture-secret-value");
});

test("a message that is not an object with a string method is an Invalid Request, not a crash", async () => {
  for (const message of [null, 42, "x", [], { jsonrpc: "2.0", id: 3 }]) {
    expect(await handleMcp(message, tools)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
});

test("initialize answers the server protocol version when the client asks for one it does not support", async () => {
  expect(await call("initialize", { protocolVersion: "1999-01-01" })).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
});
