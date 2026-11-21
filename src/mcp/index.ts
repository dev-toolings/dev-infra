import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DevHubError, type Action, type AppServices } from "../contracts";
import type { Environment } from "../environments/types";
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
  const { catalog, operations, projects } = services;
  const features = () => services.environments ?? (() => { throw new DevHubError("Feature environments are unavailable", "environments_unavailable", 503); })();
  /** What an agent needs to work in a feature: where its code is and where it answers. */
  const feature = (env: Environment) => ({
    id: env.id, project: env.project, feature: env.feature, observed: env.observed, operation: env.operation,
    url: env.preview?.domainUrl ?? env.preview?.url, worktrees: env.repos.map(({ name, path, branch }) => ({ name, path, branch })),
    ...(env.database ? { database: env.database } : {}),
  });
  return [
    {
      name: "projects_list", description: "List the DevHub projects with their URL, and the feature environments with their worktrees and preview URL.", inputSchema: object({}),
      call: async () => ({
        projects: catalog.listProjects().map((project) => ({ id: project.id, name: project.name, root: project.root, url: project.components.find((item) => item.url)?.url })),
        features: (services.environments?.list() ?? []).filter((env) => env.desired !== "destroyed").map(feature),
      }),
    },
    {
      name: "feature_create", description: "Create and start a feature environment: a worktree on a new branch of a DevHub project (or every repository of a recipe), its own containers, a private copy of its Postgres database and a preview URL. Edit the code in the returned worktree path.",
      inputSchema: object({ project: string("ID of a DevHub project, or of a recipe"), feature: string("Name of the feature"), base: string("Git ref to start from, default the current HEAD"), idempotencyKey: string("Send the same key to retry a create safely") }, ["project", "feature"]),
      call: async (args) => {
        const base = arg<string | undefined>(args, "base", "string", true), key = arg<string | undefined>(args, "idempotencyKey", "string", true);
        return feature(await features().create({ project: arg(args, "project", "string"), feature: arg(args, "feature", "string"), ...(base ? { refs: { "*": base } } : {}), ...(key ? { idempotencyKey: key } : {}) }));
      },
    },
    {
      name: "feature_status", description: "State, preview URL and worktrees of a feature environment.", inputSchema: object({ id: string("Feature environment ID") }, ["id"]),
      call: async (args) => feature(await features().status(arg(args, "id", "string"))),
    },
    {
      name: "feature_exec", description: "Run a shell command in a service container of a feature environment (tests, migrations, linters). Never runs on the host.",
      inputSchema: object({ id: string("Feature environment ID"), command: string("Shell command, run with sh -c"), service: string("Compose service, default app"), timeoutSeconds: { type: "number", description: "Default 120, at most 600" } }, ["id", "command"]),
      call: async (args) => {
        const timeout = Math.min(Math.max(arg<number | undefined>(args, "timeoutSeconds", "number", true) ?? 120, 1), 600);
        const result = await features().exec(arg(args, "id", "string"), arg<string | undefined>(args, "service", "string", true) ?? "app", ["sh", "-c", arg(args, "command", "string")], timeout * 1000);
        return `exit code ${result.code}\n--- stdout\n${redactText(result.stdout, "multiline")}\n--- stderr\n${redactText(result.stderr, "multiline")}`;
      },
    },
    {
      name: "feature_destroy", description: "Remove the containers of a feature environment. Its branch is always kept. purgeData also drops its volumes and database; removeWorktrees also removes its folders, and refuses uncommitted changes and ignored files unless force is true.",
      inputSchema: object({ id: string("Feature environment ID"), purgeData: { type: "boolean" }, removeWorktrees: { type: "boolean" }, force: { type: "boolean" } }, ["id"]),
      call: async (args) => feature(await features().destroy(arg(args, "id", "string"), {
        purgeData: arg(args, "purgeData", "boolean", true) ?? false, removeWorktrees: arg(args, "removeWorktrees", "boolean", true) ?? false, force: arg(args, "force", "boolean", true) ?? false,
      })),
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
        const result = await projects.exec(arg(args, "project", "string"), arg(args, "command", "string"), timeout * 1000);
        return `exit code ${result.code}\n--- stdout\n${redactText(result.stdout, "multiline")}\n--- stderr\n${redactText(result.stderr, "multiline")}`;
      },
    },
  ];
}

export async function handleMcp(message: unknown, tools: Tool[]): Promise<Record<string, unknown> | undefined> {
  // Batches (arrays) are not supported and get the same answer as any other invalid message.
  if (typeof message !== "object" || message === null || Array.isArray(message) || typeof (message as { method?: unknown }).method !== "string") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const request = message as Request;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id ?? null, result });
  const failure = (code: number, message: string) => ({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
  // A notification gets no answer.
  if (request.id === undefined) return undefined;
  switch (request.method) {
    case "initialize": {
      const version = readFileSync(resolve(import.meta.dir, "../../VERSION"), "utf8").trim();
      // PROTOCOL is the only version this server speaks, so it is the answer whatever the client asked for.
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "devhub", version } });
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
    let request: unknown;
    try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
    const response = await handleMcp(request, tools);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  return 0;
}
