import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DevHubError, type Action, type AppServices } from "../contracts";
import { redactOutput, redactText } from "../operations/logger";

/**
 * MCP over stdio for coding agents: newline-delimited JSON-RPC, tools only.
 * It runs as the local user, like the CLI: whoever can start it can already run `devhub`.
 */
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; call: (args: Record<string, unknown>) => Promise<unknown> };
type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const PROTOCOL = "2025-06-18";
const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(redactOutput(value), null, 2);
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description: string) => ({ type: "string", description });
function arg<T>(args: Record<string, unknown>, name: string, type: "string" | "number" | "boolean", optional = false): T {
  const value = args[name];
  if (value === undefined && optional) return undefined as T;
  if (typeof value !== type) throw new DevHubError(`${name} must be a ${type}`);
  return value as T;
}

export function mcpTools(services: AppServices): Tool[] {
  const { catalog, operations, worktrees } = services;
  return [
    {
      name: "projects_list", description: "List the DevHub projects, with their URL and, for a worktree, its parent and branch.", inputSchema: object({}),
      call: async () => {
        const variants = new Map(worktrees.list().map((item) => [item.id, item]));
        return catalog.listProjects().map((project) => ({ id: project.id, name: project.name, root: project.root, url: project.components.find((item) => item.url)?.url, worktree: variants.get(project.id) }));
      },
    },
    {
      name: "worktree_add", description: "Check out a branch next to a project DevHub runs in Docker and start it with its own port and a copy of its database. The branch is created from HEAD when missing.",
      inputSchema: object({ project: string("ID of the parent project"), branch: string("Git branch"), expireHours: { type: "number", description: "Remove the worktree after this many hours, unless it has uncommitted changes" } }, ["project", "branch"]),
      call: async (args) => {
        const plan = await worktrees.plan(arg(args, "project", "string"), arg(args, "branch", "string"), arg(args, "expireHours", "number", true));
        const result = await worktrees.add(plan);
        return { id: result.project.id, path: result.worktree.path, url: result.url, host: `http://${result.host}`, operation: result.operation.state, error: result.operation.error };
      },
    },
    {
      name: "worktree_remove", description: "Stop a worktree, drop its database and remove its folder. Its branch and commits are kept. Refuses uncommitted changes unless force is true.",
      inputSchema: object({ id: string("ID of the worktree project"), force: { type: "boolean" } }, ["id"]),
      call: (args) => worktrees.remove(arg(args, "id", "string"), arg(args, "force", "boolean", true) ?? false),
    },
    {
      name: "project_action", description: "Start, stop or restart a project.",
      inputSchema: object({ project: string("Project ID"), action: { type: "string", enum: ["start", "stop", "restart"] } }, ["project", "action"]),
      call: async (args) => {
        const action = arg<string>(args, "action", "string");
        if (!["start", "stop", "restart"].includes(action)) throw new DevHubError("action must be start, stop or restart");
        return operations.execute(catalog.getProject(arg(args, "project", "string")).id, action as Action);
      },
    },
    {
      name: "project_status", description: "State and readiness of each component of a project.", inputSchema: object({ project: string("Project ID") }, ["project"]),
      call: (args) => operations.status(arg(args, "project", "string")),
    },
    {
      name: "project_logs", description: "Latest log lines of a project.", inputSchema: object({ project: string("Project ID"), limit: { type: "number", description: "At most 500, default 100" } }, ["project"]),
      call: async (args) => (await operations.logs(arg(args, "project", "string"), { limit: Math.min(arg<number | undefined>(args, "limit", "number", true) ?? 100, 500) })).map((entry) => `${entry.time} ${entry.stream}: ${entry.message}`).join("\n"),
    },
    {
      name: "exec", description: "Run a shell command in the app container of a project DevHub runs in Docker (tests, migrations, linters). Never runs on the host.",
      inputSchema: object({ project: string("Project ID"), command: string("Shell command, run with sh -c in /app"), timeoutSeconds: { type: "number", description: "Default 120, at most 3600" } }, ["project", "command"]),
      call: async (args) => {
        const timeout = Math.min(Math.max(arg<number | undefined>(args, "timeoutSeconds", "number", true) ?? 120, 1), 3600);
        const result = await worktrees.exec(arg(args, "project", "string"), arg(args, "command", "string"), timeout * 1000);
        return `exit code ${result.code}\n--- stdout\n${redactText(result.stdout)}\n--- stderr\n${redactText(result.stderr)}`;
      },
    },
  ];
}

export async function handleMcp(request: Request, tools: Tool[]): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id ?? null, result });
  const failure = (code: number, message: string) => ({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
  // A notification gets no answer.
  if (request.id === undefined) return undefined;
  switch (request.method) {
    case "initialize": {
      const version = readFileSync(resolve(import.meta.dir, "../../VERSION"), "utf8").trim();
      return reply({ protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "devhub", version } });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: tools.map(({ call: _call, ...tool }) => tool) });
    case "tools/call": {
      const tool = tools.find((item) => item.name === request.params?.name);
      if (!tool) return failure(-32602, `Unknown tool: ${String(request.params?.name)}`);
      try {
        return reply({ content: [{ type: "text", text: text(await tool.call((request.params?.arguments ?? {}) as Record<string, unknown>)) }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: redactText(error instanceof Error ? error.message : "Operation failed") }], isError: true });
      }
    }
    default: return failure(-32601, `Method not found: ${request.method}`);
  }
}

/** One request at a time: operations already serialize per project, and agents wait for each answer. */
export async function serveMcp(services: AppServices): Promise<number> {
  const tools = mcpTools(services);
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Request;
    try { request = JSON.parse(line) as Request; } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
    const response = await handleMcp(request, tools);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  return 0;
}
