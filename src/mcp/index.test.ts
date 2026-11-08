import { expect, test } from "bun:test";
import { DevHubError, type AppServices } from "../contracts";
import { handleMcp, mcpTools } from "./index";

const services = {
  catalog: { listProjects: () => [], getProject: () => { throw new DevHubError("Project not found", "not_found", 404); } },
  operations: {},
  worktrees: { list: () => [], exec: async () => ({ code: 1, stdout: "ok\n", stderr: "DATABASE_URL=postgres://u:secretpassword@h/db\n" }) },
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
  expect(listed.tools.map((tool) => tool.name)).toEqual(["projects_list", "worktree_add", "worktree_remove", "project_action", "project_status", "project_logs", "exec"]);
  expect(listed.tools.every((tool) => !("call" in tool))).toBe(true);
  expect(await call("tools/call", { name: "project_action", arguments: { project: "x", action: "start" } })).toMatchObject({ result: { isError: true, content: [{ text: "Project not found" }] } });
  expect(await call("tools/call", { name: "worktree_add", arguments: { project: 1 } })).toMatchObject({ result: { isError: true, content: [{ text: "project must be a string" }] } });
  expect(await call("tools/call", { name: "nope" })).toMatchObject({ error: { code: -32602 } });
});

test("exec output reaches the agent with its secrets redacted", async () => {
  const reply = await call("tools/call", { name: "exec", arguments: { project: "shop", command: "env" } });
  const text = (reply!.result as { content: Array<{ text: string }> }).content[0]!.text;
  expect(text).toStartWith("exit code 1\n--- stdout\nok\n");
  expect(text).not.toContain("secretpassword");
});
