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
