import { expect, test } from "bun:test";
import { DevHubError } from "../contracts";
import { parseCliArgs, usage } from "./args";

test("empty argv and explicit help return usage text", () => {
  expect(parseCliArgs([])).toEqual({ command: "help", topic: [], text: usage() });
  expect(parseCliArgs(["help"])).toEqual({ command: "help", topic: [], text: usage() });
  expect(parseCliArgs(["--help"])).toMatchObject({ command: "help", topic: [] });
  expect(usage()).toContain("serve [--port 8040]");
  expect(usage()).toContain("pair");
});

test("selected command help is returned before incomplete option parsing", () => {
  const parsed = parseCliArgs(["project", "add", "--name", "--help"]);
  expect(parsed.command).toBe("help");
  expect(parsed).toMatchObject({ topic: ["project", "add"] });
  if (parsed.command === "help") expect(parsed.text).toContain("Usage: devhub project add");

  const aliasHelp = parseCliArgs(["security", "scan", "--help"]);
  expect(aliasHelp).toMatchObject({ topic: ["security", "scan"] });
  if (aliasHelp.command === "help") expect(aliasHelp.text).toContain("Usage: devhub security scan IMAGE_ID");
});

test("unknown commands, subcommands, and options have predictable usage errors", () => {
  for (const argv of [
    ["missing"],
    ["project", "missing"],
    ["project", "list", "--mystery"],
    ["root", "add"],
  ]) {
    try {
      parseCliArgs(argv);
      throw new Error("Expected usage error for " + argv.join(" "));
    } catch (error) {
      expect(error).toBeInstanceOf(DevHubError);
      expect((error as DevHubError).code).toBe("usage");
      expect((error as Error).message).toContain("Run 'devhub help' for usage.");
    }
  }
});

test("infra passes every remaining token through without interpreting flags", () => {
  expect(parseCliArgs(["infra", "--json", "--help", "--label=odd value", "up", "-x"])).toEqual({
    command: "infra",
    args: ["--json", "--help", "--label=odd value", "up", "-x"],
  });
});

test("setup parses its explicit dependency flag and JSON mode", () => {
  expect(parseCliArgs(["setup", "--install-deps", "--json"])).toEqual({
    command: "setup",
    installDeps: true,
    json: true,
  });
});

test("root commands preserve path and label values and parse JSON mode", () => {
  expect(parseCliArgs(["root", "add", "./A Root", "--label=Personal Root", "--json"])).toEqual({
    command: "root",
    action: "add",
    path: "./A Root",
    label: "Personal Root",
    json: true,
  });
  expect(parseCliArgs(["root", "remove", "root-id"])).toMatchObject({
    command: "root",
    action: "remove",
    id: "root-id",
    json: false,
  });
});

test("project add returns wizard intent until all preset fields are supplied", () => {
  expect(parseCliArgs(["project", "add", "--path", "./shop", "--group"])).toMatchObject({
    command: "project",
    action: "add",
    mode: "wizard",
    path: "./shop",
    group: true,
  });

  expect(parseCliArgs(["project", "add", "./shop", "--name", "Shop", "--preset", "compose-existing", "--apply"])).toMatchObject({
    command: "project",
    action: "add",
    mode: "preset",
    path: "./shop",
    name: "Shop",
    preset: "compose-existing",
    apply: true,
  });

  expect(parseCliArgs(["project", "add", "--path=./shop", "--name=--json", "--preset=native"])).toMatchObject({
    command: "project",
    action: "add",
    mode: "preset",
    name: "--json",
    json: false,
  });
});

test("project add file mode is exclusive with path and preset configuration", () => {
  expect(parseCliArgs(["project", "add", "--file", "./setup.json", "--apply", "--json"])).toEqual({
    command: "project",
    action: "add",
    mode: "file",
    file: "./setup.json",
    apply: true,
    json: true,
  });
  expect(() => parseCliArgs(["project", "add", "--file", "./setup.json", "--path", "./shop"])).toThrow("--file cannot be combined");
  expect(() => parseCliArgs(["project", "add", "./shop", "--path", "./shop"])).toThrow("either positionally or with --path");
});

test("--json is not consumed as a missing option value", () => {
  expect(() => parseCliArgs(["project", "add", "--name", "--json"])).toThrow("Missing value for --name");
  expect(() => parseCliArgs(["maintenance", "preview", "--project", "--json"])).toThrow("Missing value for --project");
});

test("project discovery and lifecycle parse selectors without losing order", () => {
  expect(parseCliArgs(["project", "discover", "./workspace", "--depth=0", "--json"])).toEqual({
    command: "project",
    action: "discover",
    path: "./workspace",
    depth: 0,
    json: true,
  });
  expect(parseCliArgs([
    "project", "start", "shop",
    "--component", "api,web",
    "--component=web,worker",
  ])).toEqual({
    command: "project",
    action: "start",
    id: "shop",
    componentIds: ["api", "web", "worker"],
    json: false,
  });
  expect(() => parseCliArgs(["project", "stop", "shop", "--component", "api,,web"])).toThrow("empty entries");
});

test("project logs accepts one component and bounded selectors", () => {
  expect(parseCliArgs(["project", "logs", "shop", "--component=api", "--limit", "1000", "--cursor=0", "--follow"])).toEqual({
    command: "project",
    action: "logs",
    id: "shop",
    componentId: "api",
    limit: 1000,
    cursor: 0,
    follow: true,
    json: false,
  });
  expect(() => parseCliArgs(["project", "logs", "shop", "--component", "api,web"])).toThrow("one component only");
  expect(() => parseCliArgs(["project", "logs", "shop", "--component", "api", "--component", "web"])).toThrow("may be provided only once");
});

test("numeric selectors accept safe integer boundaries and reject invalid values", () => {
  expect(parseCliArgs(["project", "discover", ".", "--depth", "8"])).toMatchObject({ depth: 8 });
  expect(parseCliArgs(["project", "logs", "shop", "--limit", "1", "--cursor", "9007199254740991"])).toMatchObject({
    limit: 1,
    cursor: Number.MAX_SAFE_INTEGER,
  });

  for (const depth of ["9", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    expect(() => parseCliArgs(["project", "discover", ".", "--depth", depth])).toThrow("Option --depth");
  }
  for (const limit of ["0", "1001", "2.5"]) {
    expect(() => parseCliArgs(["project", "logs", "shop", "--limit", limit])).toThrow("Option --limit");
  }
  for (const cursor of ["-1", "1.25", "Infinity", "9007199254740992"]) {
    expect(() => parseCliArgs(["project", "logs", "shop", "--cursor=" + cursor])).toThrow("Option --cursor");
  }
});

test("maintenance selectors and security alias parse typed input only", () => {
  expect(parseCliArgs(["maintenance", "preview", "--project", "shop", "--component", "api", "--file", "Dockerfile", "--replacement", "example/api:v2", "--service", "api", "--stage", "runtime", "--json"])).toEqual({
    command: "maintenance",
    action: "preview",
    input: {
      projectId: "shop",
      componentId: "api",
      file: "Dockerfile",
      replacement: "example/api:v2",
      service: "api",
      stage: "runtime",
    },
    json: true,
  });
  expect(parseCliArgs(["security", "scan", "sha256:abc"])).toEqual({
    command: "security",
    action: "scan",
    imageId: "sha256:abc",
    json: false,
  });
  expect(parseCliArgs(["maintenance", "scans"])).toMatchObject({ action: "scans", scanId: undefined });
  expect(parseCliArgs(["maintenance", "activate", "change-id"])).toMatchObject({
    action: "activate",
    changeId: "change-id",
  });
});

test("serve and pair remain owned by the composition entry point", () => {
  expect(() => parseCliArgs(["serve"])).toThrow("handled by src/main.ts");
  expect(() => parseCliArgs(["pair"])).toThrow("handled by src/main.ts");
});

 test("inherited option names are rejected without echoing option values", () => {
  for (const name of ["__proto__", "constructor", "toString", "unknown"]) {
    try { parseCliArgs(["project","list",`--${name}=private-value`]); throw new Error("Expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(DevHubError);
      expect((error as Error).message).not.toContain("private-value");
    }
  }
});

test("import takes one path and previews unless --apply is given", () => {
  expect(parseCliArgs(["import", "/code/api", "--name", "API"])).toEqual({ command: "import", path: "/code/api", name: "API", id: undefined, apply: false, json: false });
  expect(parseCliArgs(["import", "/code/api", "--apply", "--json"])).toMatchObject({ apply: true, json: true });
  expect(() => parseCliArgs(["import"])).toThrow("project path");
});

test("new requires a stack, a name and a root, and defaults to Docker with Git", () => {
  expect(parseCliArgs(["new", "node", "shop", "--root", "/code", "--option", "runtime=node,orm=drizzle", "--service", "redis"])).toEqual({
    command: "new", stack: "node", name: "shop", root: "/code", mode: "docker", options: { runtime: "node", orm: "drizzle" }, services: ["redis"], versions: {}, git: true, apply: false, json: false,
  });
  expect(parseCliArgs(["new", "node", "shop", "--root", "/code", "--service", "postgres@17,redis"])).toMatchObject({ services: ["postgres", "redis"], versions: { postgres: "17" } });
  expect(parseCliArgs(["new", "node", "shop", "--root", "/code", "--mode", "native", "--no-git", "--apply"])).toMatchObject({ mode: "native", git: false, apply: true });
  expect(() => parseCliArgs(["new", "node", "shop"])).toThrow("--root");
  expect(() => parseCliArgs(["new", "node", "shop", "--root", "/code", "--mode", "vm"])).toThrow("--mode");
});

test("exec, proxy and mcp commands parse", () => {
  expect(parseCliArgs(["exec", "shop", "--timeout", "30", "--", "bun", "test", "--watch"])).toEqual({ command: "exec", project: "shop", timeout: 30, shell: "bun test --watch", json: false });
  expect(parseCliArgs(["exec", "shop", "--", "grep", "a b", "it's"])).toMatchObject({ shell: "grep 'a b' 'it'\\''s'" });
  expect(parseCliArgs(["exec", "shop", "--", "bun test && bun run lint"])).toMatchObject({ shell: "bun test && bun run lint" });
  expect(() => parseCliArgs(["exec", "shop", "bun"])).toThrow("devhub exec PROJECT");
  expect(parseCliArgs(["proxy", "sync"])).toEqual({ command: "proxy", action: "sync", json: false });
  expect(parseCliArgs(["mcp"])).toEqual({ command: "mcp" });
});

test("environment CLI parses feature refs, attached branches, and bounded operations", () => {
  expect(parseCliArgs(["env", "exec", "ef-demo", "--service", "api", "--json", "--", "printenv", "--quiet"])).toEqual({ command: "env", action: "exec", id: "ef-demo", service: "api", timeout: undefined, argv: ["printenv", "--quiet"], json: true });
  expect(parseCliArgs(["env", "logs", "ef-demo", "--service", "api", "--tail", "25"])).toEqual({ command: "env", action: "logs", id: "ef-demo", service: "api", tail: 25, json: false });
  expect(parseCliArgs(["env", "create", "shop", "checkout", "--base", "main", "--ref", "api=refs/heads/api", "--branch", "web=feature/web", "--build", "--idempotency-key", "retry-1", "--json"])).toEqual({
    command: "env", action: "create", project: "shop", feature: "checkout", refs: { "*": "main", api: "refs/heads/api" }, branches: { web: "feature/web" }, build: true, idempotencyKey: "retry-1", json: true,
  });
  expect(parseCliArgs(["env", "exec", "ef-123", "api", "--timeout", "15", "--", "bun", "test", "--run"])).toEqual({ command: "env", action: "exec", id: "ef-123", service: "api", timeout: 15_000, argv: ["bun", "test", "--run"], json: false });
  expect(parseCliArgs(["env", "destroy", "ef-123", "--purge-data", "--remove-worktrees", "--force"])).toMatchObject({ action: "destroy", purgeData: true, removeWorktrees: true, force: true });
  expect(parseCliArgs(["env", "logs", "ef-123", "api", "--tail", "200"])).toMatchObject({ action: "logs", id: "ef-123", service: "api", tail: 200 });
  expect(parseCliArgs(["env", "start", "ef-123", "--build", "--retry-step", "migrate"])).toMatchObject({ action: "start", id: "ef-123", build: true, retryStep: "migrate" });
  expect(parseCliArgs(["env", "timer-install"])).toEqual({ command: "env", action: "timer-install", json: false });
  expect(parseCliArgs(["env", "create", "shop", "--feature", "checkout"])).toMatchObject({ project: "shop", feature: "checkout" });
  expect(() => parseCliArgs(["env", "exec", "ef-123", "api", "--timeout", "0", "--", "echo", "x"])).toThrow("between 1 and 600");
  expect(() => parseCliArgs(["env", "create", "shop", "checkout", "--ref", "invalid"])).toThrow("NAME=VALUE");
});
