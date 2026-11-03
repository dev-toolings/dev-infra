import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { isAbsolute, resolve, relative, basename } from "node:path";
import { DevHubError, type Action, type AppServices, type Component, type Executor, type Project, type ProjectInput, type SetupInput } from "../contracts";
import { publicChange, publicProject, publicSetupPlan } from "../public";
import { parseCliArgs, usage } from "./args";
import { resolveSelection } from "../operations/graph";
import { redactOutput, redactText } from "../operations/logger";

export type CliOptions = { stateDir: string; infraDir: string; run: Executor };

function stable(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    return item;
  };
  return JSON.stringify(sort(redactOutput(value)), null, 2);
}

function write(value: unknown, json: boolean, human?: string): void {
  if (json) stdout.write(`${stable(value)}\n`);
  else if (human !== undefined) stdout.write(`${human}\n`);
  else if (typeof value === "string") stdout.write(`${value}\n`);
  else stdout.write(`${stable(value)}\n`);
}

function safeError(error: unknown): string {
  if (error instanceof DevHubError) return redactText(error.message);
  if (error instanceof Error) return redactText(error.message.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 1000));
  return "Operation failed";
}

function projectSummary(project: Project): unknown { return publicProject(project); }
function projectInputSummary(input: ProjectInput): unknown {
  return {
    id: input.id, name: input.name, root: input.root,
    components: input.components.map(({ argv: _argv, envFiles: _envFiles, validation: _validation, ...component }) => component),
  };
}

function validateProjectInput(value: unknown, catalog: AppServices["catalog"]): ProjectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DevHubError("Project file must contain a project object");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.name !== "string" || typeof input.root !== "string" || !Array.isArray(input.components)) {
    throw new DevHubError("Project file requires id, name, root, and components");
  }
  const root = catalog.assertAllowedPath(input.root);
  const components = input.components as Component[];
  if (components.length < 1 || components.length > 64) throw new DevHubError("Project must contain between 1 and 64 components");
  for (const component of components) {
    if (!component || typeof component.id !== "string" || typeof component.cwd !== "string") throw new DevHubError("Project file contains an invalid component");
    const cwd = catalog.assertAllowedPath(component.cwd);
    const rel = relative(root, cwd);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new DevHubError("Every component must stay inside the project root");
  }
  resolveSelection(components);
  return { id: input.id, name: input.name, root, components };
}

async function promptLine(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new DevHubError("Incomplete project add options require an interactive terminal; provide --path, --name, and --preset");
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function addProject(command: Extract<ReturnType<typeof parseCliArgs>, { command: "project"; action: "add" }>, services: AppServices): Promise<unknown> {
  if (command.mode === "file") {
    let value: unknown;
    try { value = JSON.parse(readFileSync(command.file, "utf8")); }
    catch { throw new DevHubError("Could not read a valid project JSON file"); }
    const input = validateProjectInput(value, services.catalog);
    if (!command.apply) return { preview: true, project: projectInputSummary(input) };
    return projectSummary(services.catalog.createProject(input));
  }

  if (command.mode === "wizard" && command.group) {
    const scanPath = command.path ?? await promptLine("Scan path: ");
    const found = await services.discovery.scan(scanPath);
    if (!found.length) throw new DevHubError("No projects were detected under that approved path");
    const candidates = found.map((detection, index) => `${index + 1}. ${detection.name} (${detection.path})`).join("\n");
    const selectionText = await promptLine(`Select detections to group (comma-separated indices):\n${candidates}\nSelection: `);
    const selectedIndexes = [...new Set(selectionText.split(",").map((part) => Number(part.trim())))];
    if (!selectedIndexes.length || selectedIndexes.some((index) => !Number.isInteger(index) || index < 1 || index > found.length)) throw new DevHubError("Invalid group selection");
    const selected = selectedIndexes.map((index) => found[index - 1]!);
    const root = resolve(scanPath);
    const id = command.id ?? basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
    const input: ProjectInput = { id, name: command.name ?? await promptLine("Project name: "), root, components: selected.flatMap((item) => item.components) };
    if (!input.components.length) throw new DevHubError("Selected detections have no runnable components to group");
    resolveSelection(input.components);
    if (!command.apply) return { preview: true, project: projectInputSummary(input) };
    return projectSummary(services.catalog.createProject(input));
  }

  const path = command.path ?? await promptLine("Project path: ");
  const name = command.name ?? await promptLine("Project name: ");
  const preset = command.preset ?? (await promptLine(`Preset (${services.discovery.presets().map((item) => item.id).join(", ")}): `));
  const setup: SetupInput = { path, name, preset, ...(command.id ? { id: command.id } : {}), ...(command.composeProjectName ? { composeProjectName: command.composeProjectName } : {}) };
  const plan = await services.discovery.preview(setup);
  if (!command.json) {
    stdout.write(`Project preview: ${plan.project.name} (${plan.project.id})\nRoot: ${plan.project.root}\n`);
    for (const component of plan.project.components) stdout.write(`  ${component.id}: ${component.kind} ${component.cwd}\n`);
    for (const file of plan.files) stdout.write(`  create ${file.path}\n`);
    for (const warning of plan.warnings) stdout.write(`  warning: ${warning}\n`);
  }
  if (!command.apply) return { preview: true, plan: publicSetupPlan(plan) };
  const created = projectSummary(await services.discovery.apply(plan.id));
  return command.json ? { plan: publicSetupPlan(plan), project: created } : created;
}

export async function runCli(argv: string[], services: AppServices, options: CliOptions): Promise<number> {
  let json = argv.includes("--json");
  try {
    const command = parseCliArgs(argv);
    json = "json" in command ? command.json : false;
    if (command.command === "help") { write(command.text || usage(), false); return 0; }
    if (command.command === "presets") { write(services.discovery.presets(), command.json); return 0; }
    if (command.command === "setup") {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      for (const [label, argv] of [["bun", ["bun", "--version"]], ["dockerCompose", ["docker", "compose", "version"]]] as const) {
        try {
          const result = await options.run([...argv], { cwd: options.infraDir, timeoutMs: 10_000, maxOutputBytes: 32_000 });
          checks[label] = { ok: result.code === 0, ...(result.code === 0 ? {} : { detail: "Command is unavailable or returned an error" }) };
        } catch { checks[label] = { ok: false, detail: "Command is unavailable" }; }
      }
      if (!checks.bun!.ok) throw new DevHubError("Bun is required. Install it for your user with: curl -fsSL https://bun.sh/install | bash");
      if (command.installDeps) {
        const install = await options.run(["bun", "install", "--frozen-lockfile"], { cwd: options.infraDir, timeoutMs: 900_000, maxOutputBytes: 2_000_000 });
        checks.dependencies = { ok: install.code === 0, ...(install.code === 0 ? {} : { detail: "Frozen dependency installation failed" }) };
      }
      write({ checks, stateDir: options.stateDir, infraDir: options.infraDir }, command.json,
        `Bun: available\nDocker Compose: ${checks.dockerCompose!.ok ? "available" : "unavailable"}\nState: ${options.stateDir}\nCheckout: ${options.infraDir}${command.installDeps ? `\nDependency installation: ${checks.dependencies!.ok ? "complete" : "failed"}` : ""}`);
      return Object.values(checks).every((check) => check.ok) ? 0 : 1;
    }
    if (command.command === "infra") {
      const result = await options.run(["bash", resolve(options.infraDir, "bin/devhub"), ...command.args], { cwd: options.infraDir, timeoutMs: 900_000, maxOutputBytes: 4_000_000 });
      if (result.stdout) stdout.write(result.stdout);
      if (result.stderr) stderr.write(result.stderr);
      return result.code;
    }
    if (command.command === "root") {
      if (command.action === "list") write(services.catalog.listRoots(), command.json);
      else if (command.action === "add") write(services.catalog.addRoot(command.path, command.label), command.json, "Root approved");
      else { services.catalog.removeRoot(command.id); write({ removed: command.id }, command.json, "Root removed"); }
      return 0;
    }
    if (command.command === "project") {
      if (command.action === "list") { write(services.catalog.listProjects().map(projectSummary), command.json); return 0; }
      if (command.action === "add") { write(await addProject(command, services), command.json); return 0; }
      if (command.action === "discover") {
        const detections = await services.discovery.scan(command.path, command.depth);
        write(detections.map(({ components, ...detection }) => ({ ...detection, components: components.map(({ argv: _argv, envFiles: _envFiles, validation: _validation, ...component }) => component) })), command.json);
        return 0;
      }
      const project = services.catalog.getProject(command.id);
      if (command.action === "show") { write(projectSummary(project), command.json); return 0; }
      if (command.action === "remove") { services.catalog.removeProject(project.id); write({ removed: project.id }, command.json, "Project unregistered; its files and services were left in place"); return 0; }
      if (command.action === "status") { const status = await services.operations.status(project.id); write(status, command.json); return status.components.some((item) => item.state === "unhealthy" || item.state === "unknown") ? 1 : 0; }
      if (command.action === "logs") {
        let cursor = command.cursor;
        const emitEntries = async (): Promise<void> => {
          const entries = await services.operations.logs(project.id, { componentId: command.componentId, cursor, limit: command.limit ?? 100 });
          if (entries.length) {
            if (command.json) write(entries, true);
            else for (const entry of entries) stdout.write(`${redactText(entry.time)} ${redactText(entry.componentId)} ${entry.stream}: ${redactText(entry.message)}\n`);
            cursor = Math.max(cursor ?? 0, ...entries.map((entry) => entry.seq));
          }
        };
        await emitEntries();
        if (command.follow) {
          let stopped = false;
          const onInterrupt = () => { stopped = true; };
          process.once("SIGINT", onInterrupt);
          try {
            while (!stopped) {
              await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
              if (!stopped) await emitEntries();
            }
          } finally { process.removeListener("SIGINT", onInterrupt); }
        }
        return 0;
      }
      if (!["start", "stop", "restart", "check"].includes(command.action)) throw new DevHubError("Unsupported project action");
      const action = command.action as Action;
      // Operations expands dependencies itself; pass the operator's selection unchanged.
      const componentIds = "componentIds" in command ? command.componentIds : undefined;
      const operation = await services.operations.execute(project.id, action, componentIds?.length ? componentIds : undefined);
      write(operation, command.json);
      return operation.state === "succeeded" ? 0 : 1;
    }
    if (command.command === "maintenance" || command.command === "security") {
      let exitCode = 0;
      switch (command.action) {
        case "inventory": write(await services.operations.inventory(), command.json); break;
        case "scan": {
          const scan = await services.maintenance.scan(command.imageId);
          write(scan, command.json);
          if (scan.state === "failed") exitCode = 1;
          break;
        }
        case "scans": write(command.scanId ? services.maintenance.getScan(command.scanId) : services.maintenance.listScans(), command.json); break;
        case "changes": write(services.maintenance.listChanges().map(publicChange), command.json); break;
        case "preview": write(publicChange(await services.maintenance.preview(command.input)), command.json); break;
        case "apply": {
          const change = await services.maintenance.apply(command.changeId);
          write(publicChange(change), command.json);
          if (change.state === "failed") exitCode = 1;
          break;
        }
        case "validate": {
          const change = await services.maintenance.validate(command.changeId);
          write(publicChange(change), command.json);
          if (change.state === "failed") exitCode = 1;
          break;
        }
        case "activate": {
          const change = await services.maintenance.activate(command.changeId);
          write(publicChange(change), command.json);
          if (change.state === "failed") exitCode = 1;
          break;
        }
      }
      return exitCode;
    }
    return 1;
  } catch (error) {
    const message = safeError(error);
    if (json) stderr.write(`${stable({ error: { message } })}\n`);
    else stderr.write(`devhub: ${message}\n`);
    return 1;
  }
}
