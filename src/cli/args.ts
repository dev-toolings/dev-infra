import { DevHubError } from "../contracts";
import type { Action, RemediationInput } from "../contracts";

type JsonOption = { json: boolean };

export type ProjectAddCommand =
  | ({
      command: "project";
      action: "add";
      mode: "wizard";
      path?: string;
      name?: string;
      preset?: string;
      id?: string;
      composeProjectName?: string;
      apply: boolean;
      group: boolean;
    } & JsonOption)
  | ({
      command: "project";
      action: "add";
      mode: "preset";
      path: string;
      name: string;
      preset: string;
      id?: string;
      composeProjectName?: string;
      apply: boolean;
    } & JsonOption)
  | ({
      command: "project";
      action: "add";
      mode: "file";
      file: string;
      apply: boolean;
    } & JsonOption);

export type ParsedCommand =
  | { command: "help"; topic: string[]; text: string }
  | ({ command: "presets" } & JsonOption)
  | ({ command: "versions" } & JsonOption)
  | ({ command: "import"; path: string; name?: string; id?: string; apply: boolean } & JsonOption)
  | ({ command: "new"; stack: string; name: string; root: string; mode: "docker" | "native"; options: Record<string, string>; services: string[]; versions: Record<string, string>; git: boolean; apply: boolean } & JsonOption)
  | ({ command: "setup"; installDeps: boolean } & JsonOption)
  | ({ command: "root"; action: "list" } & JsonOption)
  | ({ command: "root"; action: "add"; path: string; label?: string } & JsonOption)
  | ({ command: "root"; action: "remove"; id: string } & JsonOption)
  | ({ command: "project"; action: "list" } & JsonOption)
  | ({ command: "project"; action: "show" | "remove" | "status"; id: string } & JsonOption)
  | ({ command: "project"; action: "discover"; path: string; depth?: number } & JsonOption)
  | ProjectAddCommand
  | ({
      command: "project";
      action: Action;
      id: string;
      componentIds?: string[];
    } & JsonOption)
  | ({
      command: "project";
      action: "logs";
      id: string;
      componentId?: string;
      limit?: number;
      cursor?: number;
      follow: boolean;
    } & JsonOption)
  | ({
      command: "maintenance" | "security";
      action: "inventory" | "changes";
    } & JsonOption)
  | ({
      command: "maintenance" | "security";
      action: "scan";
      imageId: string;
    } & JsonOption)
  | ({
      command: "maintenance" | "security";
      action: "scans";
      scanId?: string;
    } & JsonOption)
  | ({
      command: "maintenance" | "security";
      action: "preview";
      input: RemediationInput;
    } & JsonOption)
  | ({
      command: "maintenance" | "security";
      action: "apply" | "validate" | "activate";
      changeId: string;
    } & JsonOption)
  | ({ command: "worktree"; action: "list" } & JsonOption)
  | ({ command: "worktree"; action: "add"; project: string; branch: string; expire?: number; apply: boolean } & JsonOption)
  | ({ command: "worktree"; action: "remove"; id: string; force: boolean } & JsonOption)
  | ({ command: "env"; action: "list" | "doctor" | "reconcile" | "recipes" | "timer-install" } & JsonOption)
  | ({ command: "env"; action: "create"; project: string; feature: string; refs: Record<string, string>; branches: Record<string, string>; build: boolean; idempotencyKey?: string } & JsonOption)
  | ({ command: "env"; action: "status" | "stop" | "test"; id: string } & JsonOption)
  | ({ command: "env"; action: "start"; id: string; build?: boolean; retryStep?: string } & JsonOption)
  | ({ command: "env"; action: "preview"; id: string } & JsonOption)
  | ({ command: "env"; action: "destroy"; id: string; purgeData: boolean; removeWorktrees: boolean; force: boolean } & JsonOption)
  | ({ command: "env"; action: "logs"; id: string; service?: string; tail?: number } & JsonOption)
  | ({ command: "env"; action: "exec"; id: string; service: string; timeout?: number; argv: string[] } & JsonOption)
  | ({ command: "exec"; project: string; timeout?: number; shell: string } & JsonOption)
  | ({ command: "proxy"; action: "sync" } & JsonOption)
  | { command: "mcp" }
  | { command: "infra"; args: string[] };

type OptionDefinition =
  | { kind: "boolean" }
  | { kind: "value"; repeat?: boolean };

type OptionSchema = Record<string, OptionDefinition>;
type OptionResult = {
  positionals: string[];
  values: Map<string, string | string[]>;
  flags: Set<string>;
  json: boolean;
};

const USAGE = [
  "Usage: devhub <command> [options]",
  "",
  "Existing shared-infrastructure commands:",
  "  up [--with profile[,profile]]",
  "  down | restart | ps | logs [service] | open <target>",
  "  db create|import|list",
  "  doctor | version | help",
  "",
  "Manager commands:",
  "  setup [--install-deps] [--json]",
  "  presets",
  "  versions [--json]",
  "  root list | add PATH [--label LABEL] | remove ID",
  "  import PATH [--name NAME] [--id ID] [--apply]",
  "  new STACK NAME --root PATH [--mode docker|native] [--option KEY=VALUE,...]",
  "      [--service NAME[@VERSION],...] [--no-git] [--apply]",
  "  project list | show ID | discover PATH [--depth N]",
  "  project add [PATH] [--path PATH] [--name NAME] [--preset PRESET]",
  "      [--id ID] [--compose-project-name NAME] [--group] [--apply]",
  "  project add --file FILE [--apply]",
  "  project remove ID | status ID | start|stop|restart|check ID",
  "      [--component ID,...]... | logs ID [--component ID] [--limit N]",
  "      [--cursor N] [--follow]",
  "  worktree list | add PROJECT BRANCH [--expire HOURS] [--apply]",
  "      | remove ID [--force]",
  "  env list | create PROJECT [FEATURE] [--feature FEATURE] [--base REF] [--ref NAME=REF]...",
  "      [--branch NAME=BRANCH]... [--build] [--idempotency-key KEY]",
  "      status|start|stop|destroy|logs|exec|test|preview ID",
  "      start [--build] [--retry-step STEP]",
  "      reconcile | doctor | recipes | timer-install",
  "  exec PROJECT [--timeout SECONDS] -- COMMAND...",
  "  proxy sync",
  "  mcp      MCP server on stdio, for coding agents",
  "  maintenance inventory | scan IMAGE_ID | scans [SCAN_ID] | changes",
  "  maintenance preview --project ID --component ID --file REL",
  "      --replacement REF [--service NAME] [--stage NAME]",
  "  maintenance apply|validate|activate CHANGE_ID",
  "  security is an alias for maintenance.",
  "  infra <arguments...> passes all arguments to the existing Bash CLI.",
  "",
  "Controller commands handled by src/main.ts:",
  "  serve [--port 8040] [--dev | --dev-origin http://localhost:5175]",
  "        --dev also starts the Vite panel server and stops it with the controller",
  "  pair",
  "",
  "Use --json on manager data and action commands. Use --help after a command",
  "to show its usage.",
].join("\n");

const COMMAND_USAGE: Record<string, string> = {
  setup: [
    "Usage: devhub setup [--install-deps] [--json]",
    "Check setup prerequisites. Install dependencies only when explicitly requested.",
  ].join("\n"),
  root: "Usage: devhub root list [--json] | add PATH [--label LABEL] [--json] | remove ID [--json]",
  "root list": "Usage: devhub root list [--json]",
  "root add": "Usage: devhub root add PATH [--label LABEL] [--json]",
  "root remove": "Usage: devhub root remove ID [--json]",
  import: [
    "Usage: devhub import PATH [--name NAME] [--id ID] [--apply] [--json]",
    "Preview, then with --apply run a Hono project in an isolated dev container, with its database and env generated by DevHub.",
  ].join("\n"),
  new: [
    "Usage: devhub new STACK NAME --root PATH [--mode docker|native] [--option KEY=VALUE,...]",
    "       [--service NAME[@VERSION],...] [--no-git] [--apply] [--json]",
    "Preview, then with --apply create a project in an approved folder and start it.",
    "Example: devhub new node shop --root ~/code --option runtime=bun,orm=drizzle --service postgres@17,redis --apply",
    "Stacks: node, python, php. Example: devhub new php site --root ~/code --option framework=laravel --apply",
  ].join("\n"),
  project: [
    "Usage: devhub project <list|show|discover|add|remove|start|stop|restart|check|status|logs>",
    "Project commands operate only on explicitly registered projects.",
  ].join("\n"),
  "project list": "Usage: devhub project list [--json]",
  "project show": "Usage: devhub project show ID [--json]",
  "project discover": "Usage: devhub project discover PATH [--depth 0..8] [--json]",
  "project add": [
    "Usage: devhub project add [PATH] [--path PATH] [--name NAME] [--preset PRESET]",
    "       [--id ID] [--compose-project-name NAME] [--group] [--apply] [--json]",
    "       devhub project add --file FILE [--apply] [--json]",
    "Interactive additions return a wizard intent when path, name, or preset is incomplete.",
  ].join("\n"),
  "project remove": "Usage: devhub project remove ID [--json]",
  "project start": "Usage: devhub project start ID [--component ID,...]... [--json]",
  "project stop": "Usage: devhub project stop ID [--component ID,...]... [--json]",
  "project restart": "Usage: devhub project restart ID [--component ID,...]... [--json]",
  "project check": "Usage: devhub project check ID [--component ID,...]... [--json]",
  "project status": "Usage: devhub project status ID [--json]",
  "project logs": "Usage: devhub project logs ID [--component ID] [--limit 1..1000] [--cursor N] [--follow] [--json]",
  env: "Usage: devhub env <list|create|status|start|stop|destroy|logs|exec|test|preview|reconcile|doctor|recipes|timer-install>",
  "env create": "Usage: devhub env create PROJECT [FEATURE] [--feature FEATURE] [--base REF] [--ref NAME=REF]... [--branch NAME=BRANCH]... [--build] [--idempotency-key KEY] [--json]",
  "env start": "Usage: devhub env start ID [--build] [--retry-step STEP] [--json]",
  "env exec": "Usage: devhub env exec ID --service SERVICE [--timeout SECONDS] [--json] -- COMMAND...",
  maintenance: [
    "Usage: devhub maintenance inventory | scan IMAGE_ID | scans [SCAN_ID] | changes",
    "       devhub maintenance preview --project ID --component ID --file REL",
    "           --replacement REF [--service NAME] [--stage NAME]",
    "       devhub maintenance apply|validate|activate CHANGE_ID",
  ].join("\n"),
  "maintenance inventory": "Usage: devhub maintenance inventory [--json]",
  "maintenance scan": "Usage: devhub maintenance scan IMAGE_ID [--json]",
  "maintenance scans": "Usage: devhub maintenance scans [SCAN_ID] [--json]",
  "maintenance changes": "Usage: devhub maintenance changes [--json]",
  "maintenance preview": [
    "Usage: devhub maintenance preview --project ID --component ID --file REL",
    "       --replacement REF [--service NAME] [--stage NAME] [--json]",
  ].join("\n"),
  "maintenance apply": "Usage: devhub maintenance apply CHANGE_ID [--json]",
  "maintenance validate": "Usage: devhub maintenance validate CHANGE_ID [--json]",
  "maintenance activate": "Usage: devhub maintenance activate CHANGE_ID [--json]",
  security: "Usage: devhub security <maintenance subcommand> (alias for maintenance)",
};

function usageError(message: string): never {
  throw new DevHubError("CLI usage error: " + message + " Run 'devhub help' for usage.", "usage", 400);
}

function usageFor(topic: string[]): string {
  if (topic.length === 0) return USAGE;
  if (topic[0] === "security") {
    if (topic.length === 1) return COMMAND_USAGE.security!;
    const maintenanceUsage = COMMAND_USAGE[(["maintenance", ...topic.slice(1)]).join(" ")];
    if (maintenanceUsage) return maintenanceUsage.replaceAll("maintenance", "security");
  }
  const exact = COMMAND_USAGE[topic.join(" ")];
  if (exact) return exact;
  const topLevel = COMMAND_USAGE[topic[0]!];
  return topLevel ?? USAGE;
}

export function usage(): string {
  return USAGE;
}

function makeHelp(topic: string[] = []): ParsedCommand {
  return { command: "help", topic, text: usageFor(topic) };
}

function isHelpToken(value: string): boolean {
  return value === "--help" || value === "-h";
}

function containsHelp(args: string[]): boolean {
  return args.some(isHelpToken);
}

function ensureKnownAction(command: string, action: string, valid: string[]): void {
  if (!valid.includes(action)) usageError("Unknown " + command + " command: " + action + ".");
}

function collectOptions(args: string[], schema: OptionSchema, allowJson = true): OptionResult {
  const positionals: string[] = [];
  const values = new Map<string, string | string[]>();
  const flags = new Set<string>();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;

    if (token === "--json" && allowJson) {
      json = true;
      continue;
    }

    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = token.slice(2, equals === -1 ? undefined : equals);
      const hasInlineValue = equals !== -1;
      const definition = Object.hasOwn(schema, name) ? schema[name] : undefined;
      if (!definition) usageError("Unknown option: --" + name + ".");

      if (definition.kind === "boolean") {
        if (hasInlineValue) usageError("Option --" + name + " does not take a value.");
        flags.add(name);
        continue;
      }

      let value: string;
      if (hasInlineValue) {
        value = token.slice(equals + 1);
      } else {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("-")) {
          usageError("Missing value for --" + name + ".");
        }
        value = next;
        index += 1;
      }

      if (value.length === 0) usageError("Missing value for --" + name + ".");

      const existing = values.get(name);
      if (definition.repeat) {
        const list = Array.isArray(existing) ? existing : existing === undefined ? [] : [existing];
        list.push(value);
        values.set(name, list);
      } else {
        if (existing !== undefined) usageError("Option --" + name + " may be provided only once.");
        values.set(name, value);
      }
      continue;
    }

    if (token.startsWith("-")) usageError("Unknown option: " + token + ".");
    positionals.push(token);
  }

  return { positionals, values, flags, json };
}

function stringValue(options: OptionResult, name: string): string | undefined {
  const value = options.values.get(name);
  if (Array.isArray(value)) usageError("Option --" + name + " cannot be repeated here.");
  return value;
}

function requiredOption(options: OptionResult, name: string): string {
  const value = stringValue(options, name);
  if (value === undefined) usageError("Missing required option --" + name + ".");
  return value;
}

function optionalInteger(options: OptionResult, name: string, minimum: number, maximum?: number): number | undefined {
  const value = stringValue(options, name);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) usageError("Option --" + name + " must be a whole number.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    const bounds = maximum === undefined ? "at least " + minimum : "between " + minimum + " and " + maximum;
    usageError("Option --" + name + " must be a safe integer " + bounds + ".");
  }
  return parsed;
}

function exactPositionals(options: OptionResult, count: number, description: string): string[] {
  if (options.positionals.length !== count) {
    usageError("Expected " + description + (count === 1 ? "." : " values."));
  }
  return options.positionals;
}

function noPositionals(options: OptionResult): void {
  if (options.positionals.length > 0) usageError("Unexpected argument: " + options.positionals[0] + ".");
}

function parseSetup(args: string[]): ParsedCommand {
  const parsed = collectOptions(args, { "install-deps": { kind: "boolean" } });
  noPositionals(parsed);
  return { command: "setup", installDeps: parsed.flags.has("install-deps"), json: parsed.json };
}

function parseRoot(action: string, args: string[]): ParsedCommand {
  ensureKnownAction("root", action, ["list", "add", "remove"]);

  if (action === "list") {
    const parsed = collectOptions(args, {});
    noPositionals(parsed);
    return { command: "root", action, json: parsed.json };
  }

  if (action === "add") {
    const parsed = collectOptions(args, { label: { kind: "value" } });
    const [path] = exactPositionals(parsed, 1, "a root path");
    return { command: "root", action, path: path!, label: stringValue(parsed, "label"), json: parsed.json };
  }

  const parsed = collectOptions(args, {});
  const [id] = exactPositionals(parsed, 1, "a root ID");
  return { command: "root", action: "remove", id: id!, json: parsed.json };
}

function parseProjectAdd(args: string[]): ParsedCommand {
  const parsed = collectOptions(args, {
    path: { kind: "value" },
    name: { kind: "value" },
    preset: { kind: "value" },
    id: { kind: "value" },
    "compose-project-name": { kind: "value" },
    file: { kind: "value" },
    apply: { kind: "boolean" },
    group: { kind: "boolean" },
  });

  if (parsed.positionals.length > 1) usageError("Project add accepts at most one positional path.");
  const optionPath = stringValue(parsed, "path");
  const positionalPath = parsed.positionals[0];
  if (optionPath !== undefined && positionalPath !== undefined) {
    usageError("Provide the project path either positionally or with --path, not both.");
  }

  const file = stringValue(parsed, "file");
  const name = stringValue(parsed, "name");
  const preset = stringValue(parsed, "preset");
  const id = stringValue(parsed, "id");
  const composeProjectName = stringValue(parsed, "compose-project-name");
  const group = parsed.flags.has("group");
  const apply = parsed.flags.has("apply");

  if (file !== undefined) {
    if (
      positionalPath !== undefined ||
      optionPath !== undefined ||
      name !== undefined ||
      preset !== undefined ||
      id !== undefined ||
      composeProjectName !== undefined ||
      group
    ) {
      usageError("--file cannot be combined with project path, preset, ID, or grouping options.");
    }
    return { command: "project", action: "add", mode: "file", file, apply, json: parsed.json };
  }

  const path = optionPath ?? positionalPath;
  if (path !== undefined && name !== undefined && preset !== undefined && !group) {
    return {
      command: "project",
      action: "add",
      mode: "preset",
      path,
      name,
      preset,
      id,
      composeProjectName,
      apply,
      json: parsed.json,
    };
  }

  return {
    command: "project",
    action: "add",
    mode: "wizard",
    path,
    name,
    preset,
    id,
    composeProjectName,
    apply,
    group,
    json: parsed.json,
  };
}

function parseProject(action: string, args: string[]): ParsedCommand {
  ensureKnownAction(
    "project",
    action,
    ["list", "show", "discover", "add", "remove", "start", "stop", "restart", "check", "status", "logs"],
  );

  if (action === "list") {
    const parsed = collectOptions(args, {});
    noPositionals(parsed);
    return { command: "project", action, json: parsed.json };
  }

  if (action === "add") return parseProjectAdd(args);

  if (action === "discover") {
    const parsed = collectOptions(args, { depth: { kind: "value" } });
    const [path] = exactPositionals(parsed, 1, "a discovery path");
    return {
      command: "project",
      action,
      path: path!,
      depth: optionalInteger(parsed, "depth", 0, 8),
      json: parsed.json,
    };
  }

  if (action === "show" || action === "remove" || action === "status") {
    const parsed = collectOptions(args, {});
    const [id] = exactPositionals(parsed, 1, "a project ID");
    return { command: "project", action, id: id!, json: parsed.json };
  }

  if (action === "logs") {
    const parsed = collectOptions(args, {
      component: { kind: "value" },
      limit: { kind: "value" },
      cursor: { kind: "value" },
      follow: { kind: "boolean" },
    });
    const [id] = exactPositionals(parsed, 1, "a project ID");
    const componentId = stringValue(parsed, "component");
    if (componentId?.includes(",")) usageError("Project logs accepts one component only.");
    return {
      command: "project",
      action,
      id: id!,
      componentId,
      limit: optionalInteger(parsed, "limit", 1, 1000),
      cursor: optionalInteger(parsed, "cursor", 0),
      follow: parsed.flags.has("follow"),
      json: parsed.json,
    };
  }

  const parsed = collectOptions(args, { component: { kind: "value", repeat: true } });
  const [id] = exactPositionals(parsed, 1, "a project ID");
  const componentValues = parsed.values.get("component");
  const componentIds = Array.isArray(componentValues)
    ? componentValues.flatMap((value) => value.split(","))
    : componentValues === undefined
      ? undefined
      : [componentValues];
  if (componentIds?.some((componentId) => componentId.length === 0)) {
    usageError("Component selectors cannot contain empty entries.");
  }
  const deduplicated = componentIds === undefined ? undefined : [...new Set(componentIds)];
  return { command: "project", action: action as Action, id: id!, componentIds: deduplicated, json: parsed.json };
}

function parseMaintenance(command: "maintenance" | "security", action: string, args: string[]): ParsedCommand {
  ensureKnownAction(command, action, ["inventory", "scan", "scans", "changes", "preview", "apply", "validate", "activate"]);

  if (action === "inventory" || action === "changes") {
    const parsed = collectOptions(args, {});
    noPositionals(parsed);
    return { command, action, json: parsed.json };
  }

  if (action === "scan") {
    const parsed = collectOptions(args, {});
    const [imageId] = exactPositionals(parsed, 1, "an image ID");
    return { command, action, imageId: imageId!, json: parsed.json };
  }

  if (action === "scans") {
    const parsed = collectOptions(args, {});
    if (parsed.positionals.length > 1) usageError("Maintenance scans accepts at most one scan ID.");
    return { command, action, scanId: parsed.positionals[0], json: parsed.json };
  }

  if (action === "preview") {
    const parsed = collectOptions(args, {
      project: { kind: "value" },
      component: { kind: "value" },
      file: { kind: "value" },
      replacement: { kind: "value" },
      service: { kind: "value" },
      stage: { kind: "value" },
    });
    noPositionals(parsed);
    const input: RemediationInput = {
      projectId: requiredOption(parsed, "project"),
      componentId: requiredOption(parsed, "component"),
      file: requiredOption(parsed, "file"),
      replacement: requiredOption(parsed, "replacement"),
      service: stringValue(parsed, "service"),
      stage: stringValue(parsed, "stage"),
    };
    return { command, action, input, json: parsed.json };
  }

  const parsed = collectOptions(args, {});
  const [changeId] = exactPositionals(parsed, 1, "a change ID");
  return { command, action: action as "apply" | "validate" | "activate", changeId: changeId!, json: parsed.json };
}

/** One word is a shell command line; several are quoted one by one, as `docker exec` would pass them. */
function shellCommand(words: string[]): string {
  return words.length === 1 ? words[0]! : words.map((word) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`).join(" ");
}

export function parseCliArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) return makeHelp();

  const [command, ...rest] = argv;
  if (command === "infra") return { command, args: rest };

  if (command === "--help" || command === "-h") {
    if (rest.length > 0) usageError("Global help takes no command arguments.");
    return makeHelp();
  }

  if (command === "help") {
    if (rest.some((argument) => !isHelpToken(argument))) usageError("The help command takes no arguments.");
    return makeHelp();
  }

  if (command === "presets" || command === "versions") {
    const parsed = collectOptions(rest, {});
    noPositionals(parsed);
    return { command, json: parsed.json };
  }

  if (command === "import") {
    const parsed = collectOptions(rest, { name: { kind: "value" }, id: { kind: "value" }, apply: { kind: "boolean" } });
    const [path] = exactPositionals(parsed, 1, "a project path");
    return { command: "import", path: path!, name: stringValue(parsed, "name"), id: stringValue(parsed, "id"), apply: parsed.flags.has("apply"), json: parsed.json };
  }

  if (command === "new") {
    const parsed = collectOptions(rest, { root: { kind: "value" }, mode: { kind: "value" }, option: { kind: "value" }, service: { kind: "value" }, "no-git": { kind: "boolean" }, apply: { kind: "boolean" } });
    const [stack, name] = exactPositionals(parsed, 2, "a stack and a project name");
    const root = stringValue(parsed, "root") ?? usageError("--root is required.");
    const mode = stringValue(parsed, "mode") ?? "docker";
    if (mode !== "docker" && mode !== "native") usageError("--mode must be docker or native.");
    const options = Object.fromEntries((stringValue(parsed, "option") ?? "").split(",").filter(Boolean).map((pair) => {
      const index = pair.indexOf("=");
      if (index < 1) usageError("--option takes KEY=VALUE pairs.");
      return [pair.slice(0, index), pair.slice(index + 1)];
    }));
    const picked = (stringValue(parsed, "service") ?? "").split(",").filter(Boolean).map((item) => item.split("@"));
    if (picked.some((item) => item.length > 2)) usageError("--service takes NAME or NAME@VERSION.");
    const services = picked.map(([service]) => service!);
    const versions = Object.fromEntries(picked.filter(([, version]) => version).map(([service, version]) => [service!, version!]));
    return { command: "new", stack: stack!, name: name!, root, mode, options, services, versions, git: !parsed.flags.has("no-git"), apply: parsed.flags.has("apply"), json: parsed.json };
  }

  if (command === "worktree") {
    const [action, ...args] = rest;
    if (!action || isHelpToken(action)) return makeHelp([command]);
    ensureKnownAction(command, action, ["list", "add", "remove"]);
    if (action === "list") { const parsed = collectOptions(args, {}); noPositionals(parsed); return { command, action, json: parsed.json }; }
    if (action === "add") {
      const parsed = collectOptions(args, { expire: { kind: "value" }, apply: { kind: "boolean" } });
      const [project, branch] = exactPositionals(parsed, 2, "a project ID and a branch");
      return { command, action, project: project!, branch: branch!, expire: optionalInteger(parsed, "expire", 1, 2160), apply: parsed.flags.has("apply"), json: parsed.json };
    }
    const parsed = collectOptions(args, { force: { kind: "boolean" } });
    const [id] = exactPositionals(parsed, 1, "a worktree ID");
    return { command, action: "remove", id: id!, force: parsed.flags.has("force"), json: parsed.json };
  }

  if (command === "env") {
    if (!rest[0] || isHelpToken(rest[0])) return makeHelp([command]);
    const [action, ...args] = rest;
    ensureKnownAction(command, action!, ["list", "create", "status", "start", "stop", "destroy", "logs", "exec", "test", "preview", "reconcile", "doctor", "recipes", "timer-install"]);
    if (containsHelp(args)) return makeHelp([command, action!]);
    if (["list", "doctor", "reconcile", "recipes", "timer-install"].includes(action!)) {
      const parsed = collectOptions(args, {}); noPositionals(parsed);
      return { command, action: action as "list" | "doctor" | "reconcile" | "recipes" | "timer-install", json: parsed.json };
    }
    if (action === "create") {
      const parsed = collectOptions(args, { feature: { kind: "value" }, base: { kind: "value" }, ref: { kind: "value", repeat: true }, branch: { kind: "value", repeat: true }, build: { kind: "boolean" }, "idempotency-key": { kind: "value" } });
      if (parsed.positionals.length < 1 || parsed.positionals.length > 2) usageError("Expected a project ID and optional feature name.");
      const [project, positionalFeature] = parsed.positionals;
      const optionFeature = stringValue(parsed, "feature");
      if (positionalFeature !== undefined && optionFeature !== undefined) usageError("Give the feature name once, either positionally or with --feature.");
      const feature = positionalFeature ?? optionFeature ?? usageError("A feature name is required (use --feature FEATURE).");
      const pairs = (name: string) => {
        const values = parsed.values.get(name);
        const entries = values === undefined ? [] : Array.isArray(values) ? values : [values];
        const mapped: Array<[string, string]> = [];
        const seen = new Set<string>();
        for (const item of entries) {
          const at = item.indexOf("=");
          if (at < 1 || at === item.length - 1) usageError(`--${name} takes NAME=VALUE.`);
          const key = item.slice(0, at);
          if (seen.has(key)) usageError(`--${name} cannot repeat a name.`);
          seen.add(key);
          mapped.push([key, item.slice(at + 1)]);
        }
        return Object.fromEntries(mapped);
      };
      const refs = pairs("ref"), branches = pairs("branch"), base = stringValue(parsed, "base");
      if (base !== undefined) {
        if (Object.hasOwn(refs, "*")) usageError("--base cannot be combined with --ref *=REF.");
        refs["*"] = base;
      }
      return { command, action, project: project!, feature, refs, branches, build: parsed.flags.has("build"), idempotencyKey: stringValue(parsed, "idempotency-key"), json: parsed.json };
    }
    if (action === "exec") {
      const split = args.indexOf("--");
      if (split < 0 || split === args.length - 1) usageError("Usage: devhub env exec ID --service SERVICE -- COMMAND...");
      const parsed = collectOptions(args.slice(0, split), { timeout: { kind: "value" }, service: { kind: "value" } });
      const optionService = stringValue(parsed, "service");
      const [id, positionalService] = exactPositionals(parsed, optionService === undefined ? 2 : 1, "an environment ID and a single service");
      const timeoutSeconds = optionalInteger(parsed, "timeout", 1, 600);
      return { command, action, id: id!, service: (optionService ?? positionalService)!, timeout: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000, argv: args.slice(split + 1), json: parsed.json };
    }
    const parsed = collectOptions(args, action === "destroy" ? { "purge-data": { kind: "boolean" }, "remove-worktrees": { kind: "boolean" }, force: { kind: "boolean" } } : action === "logs" ? { tail: { kind: "value" }, service: { kind: "value" } } : action === "start" ? { build: { kind: "boolean" }, "retry-step": { kind: "value" } } : {});
    const optionService = action === "logs" ? stringValue(parsed, "service") : undefined;
    const [id, positionalService] = exactPositionals(parsed, action === "logs" && optionService === undefined && parsed.positionals.length > 1 ? 2 : 1, action === "logs" ? "an environment ID and optional service" : "an environment ID");
    if (action === "logs") return { command, action, id: id!, service: optionService ?? positionalService, tail: optionalInteger(parsed, "tail", 1, 1000), json: parsed.json };
    if (action === "destroy") return { command, action, id: id!, purgeData: parsed.flags.has("purge-data"), removeWorktrees: parsed.flags.has("remove-worktrees"), force: parsed.flags.has("force"), json: parsed.json };
    if (action === "start") return { command, action, id: id!, build: parsed.flags.has("build"), retryStep: stringValue(parsed, "retry-step"), json: parsed.json };
    if (action === "preview") return { command, action, id: id!, json: parsed.json };
    return { command, action: action as "status" | "stop" | "test", id: id!, json: parsed.json };
  }

  if (command === "exec") {
    const split = rest.indexOf("--");
    if (split < 0 || split === rest.length - 1) usageError("Usage: devhub exec PROJECT [--timeout SECONDS] -- COMMAND...");
    const parsed = collectOptions(rest.slice(0, split), { timeout: { kind: "value" } });
    const [project] = exactPositionals(parsed, 1, "a project ID");
    return { command, project: project!, timeout: optionalInteger(parsed, "timeout", 1, 3600), shell: shellCommand(rest.slice(split + 1)), json: parsed.json };
  }

  if (command === "proxy") {
    const [action, ...args] = rest;
    if (!action || isHelpToken(action)) return makeHelp([command]);
    ensureKnownAction(command, action, ["sync"]);
    const parsed = collectOptions(args, {});
    noPositionals(parsed);
    return { command, action: "sync", json: parsed.json };
  }

  if (command === "mcp") {
    if (rest.length) usageError("The mcp command takes no arguments.");
    return { command };
  }

  if (command === "serve" || command === "pair") {
    usageError("The " + command + " command is handled by src/main.ts.");
  }

  if (command === "setup") {
    if (containsHelp(rest)) return makeHelp(["setup"]);
    return parseSetup(rest);
  }

  if (command === "root" || command === "project" || command === "maintenance" || command === "security") {
    if (rest.length === 0 || isHelpToken(rest[0]!)) return makeHelp([command]);
    const [action, ...args] = rest;
    const validActions = command === "root"
      ? ["list", "add", "remove"]
      : command === "project"
        ? ["list", "show", "discover", "add", "remove", "start", "stop", "restart", "check", "status", "logs"]
        : ["inventory", "scan", "scans", "changes", "preview", "apply", "validate", "activate"];
    ensureKnownAction(command, action!, validActions);
    if (containsHelp(args)) return makeHelp([command, action!]);
    if (command === "root") return parseRoot(action!, args);
    if (command === "project") return parseProject(action!, args);
    return parseMaintenance(command, action!, args);
  }

  usageError("Unknown command: " + command + ".");
}
