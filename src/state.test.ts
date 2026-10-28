import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ensureStateDir } from "./state";

const fixtures: string[] = [];
let savedUmask = 0;
let savedHome: string | undefined;
let savedDevhubDir: string | undefined;

beforeEach(() => {
  savedUmask = process.umask();
  savedHome = process.env.HOME;
  savedDevhubDir = process.env.DEVHUB_DIR;
  delete process.env.DEVHUB_DIR;
});

afterEach(() => {
  process.umask(savedUmask);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDevhubDir === undefined) delete process.env.DEVHUB_DIR;
  else process.env.DEVHUB_DIR = savedDevhubDir;
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join("/var/tmp", "devhub-state-test-"));
  fixtures.push(root);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  process.env.HOME = home;
  return { root, home, infra: join(root, "infra") };
}

test("requires an absolute path and rejects parent traversal before creation", () => {
  const { root, infra } = sandbox();
  expect(() => ensureStateDir("relative-state", infra)).toThrow("absolute path");
  expect(() => ensureStateDir(`${root}/../escaped-state`, infra)).toThrow("parent traversal");
  expect(existsSync(join(root, "escaped-state"))).toBe(false);
});

test("rejects the infrastructure checkout, DEVHUB_DIR, and installer state path", () => {
  const { root, home, infra } = sandbox();
  mkdirSync(infra);
  expect(() => ensureStateDir(join(infra, "state"), infra)).toThrow("protected DevHub path");

  const configured = join(root, "configured-devhub");
  process.env.DEVHUB_DIR = configured;
  expect(() => ensureStateDir(join(configured, "state"), infra)).toThrow("protected DevHub path");

  const actualConfigured = join(root, "actual-configured");
  const configuredAlias = join(root, "configured-alias");
  mkdirSync(actualConfigured);
  symlinkSync(actualConfigured, configuredAlias);
  process.env.DEVHUB_DIR = join(configuredAlias, "managed");
  expect(() => ensureStateDir(join(actualConfigured, "managed", "state"), infra)).toThrow("protected DevHub path");

  expect(() => ensureStateDir(join(home, ".local", "share", "devhub", "state"), infra)).toThrow("protected DevHub path");
});

test("rejects Git and recognized project roots in the state path ancestry", () => {
  const { root, infra } = sandbox();
  const markers = [".git", "package.json", "composer.json", "pyproject.toml", "go.mod", "compose.yml", "docker-compose.yaml"];

  for (const marker of markers) {
    const project = join(root, `project-${marker.replaceAll(".", "-")}`);
    mkdirSync(project);
    const markerPath = join(project, marker);
    if (marker === ".git") mkdirSync(markerPath);
    else writeFileSync(markerPath, "fixture");
    expect(() => ensureStateDir(join(project, ".state"), infra)).toThrow("project or Git tree");
  }
});

test("does not inspect arbitrary children of a normal home directory", () => {
  const { home, infra } = sandbox();
  const childProject = join(home, "projects", "sample");
  mkdirSync(childProject, { recursive: true });
  writeFileSync(join(childProject, "package.json"), "{}");
  const childProjectMode = statSync(join(childProject, "package.json")).mode & 0o777;

  const statePath = ensureStateDir(home, infra);
  expect(statePath).toBe(home);
  expect(statSync(statePath).mode & 0o777).toBe(0o700);
  expect(statSync(join(childProject, "package.json")).mode & 0o777).toBe(childProjectMode);
});

test("rejects symlinked ancestors and a symlinked state directory", () => {
  const { root, infra } = sandbox();
  const actual = join(root, "actual");
  const link = join(root, "linked-parent");
  mkdirSync(actual);
  symlinkSync(actual, link);
  expect(() => ensureStateDir(join(link, "state"), infra)).toThrow("symlink");

  const stateTarget = join(root, "state-target");
  const stateLink = join(root, "state-link");
  mkdirSync(stateTarget, { mode: 0o700 });
  symlinkSync(stateTarget, stateLink);
  expect(() => ensureStateDir(stateLink, infra)).toThrow("symlink");
});

test("rejects symlinked database and private JSON files", () => {
  const { root, infra } = sandbox();
  const statePath = ensureStateDir(join(root, "state"), infra);
  const external = join(root, "external-secret");
  writeFileSync(external, "secret");
  symlinkSync(external, join(statePath, "pairing.json"));

  expect(() => ensureStateDir(statePath, infra)).toThrow("Private state file cannot be a symlink");

  rmSync(join(statePath, "pairing.json"));
  symlinkSync(external, join(statePath, "catalog.sqlite"));
  expect(() => ensureStateDir(statePath, infra)).toThrow("Private state file cannot be a symlink");
});

test("requires an existing state root to be owned and mode 0700", () => {
  const { root, infra } = sandbox();
  const statePath = join(root, "existing-state");
  mkdirSync(statePath, { mode: 0o700 });
  chmodSync(statePath, 0o750);

  expect(() => ensureStateDir(statePath, infra)).toThrow("mode 0700");
});

test("creates a private directory and secures existing database and credential files without rewriting them", () => {
  const { root, infra } = sandbox();
  const statePath = ensureStateDir(join(root, "state"), infra);
  const contents = new Map([
    ["catalog.sqlite", "database"],
    ["catalog.sqlite-wal", "wal"],
    ["catalog.sqlite-shm", "shm"],
    ["pairing.json", "pairing"],
    ["session.json", "session"],
    ["pairing.token", "token"],
    ["private-state", "private state"],
  ]);

  for (const [name, content] of contents) {
    const filePath = join(statePath, name);
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o644);
  }

  ensureStateDir(statePath, infra);
  expect(statSync(statePath).mode & 0o777).toBe(0o700);
  for (const [name, content] of contents) {
    const filePath = join(statePath, name);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, "utf8")).toBe(content);
  }

  const databaseDirectory = join(statePath, "database");
  mkdirSync(databaseDirectory, { mode: 0o755 });
  const nestedWal = join(databaseDirectory, "catalog.sqlite-wal");
  writeFileSync(nestedWal, "nested wal");
  chmodSync(nestedWal, 0o644);
  ensureStateDir(statePath, infra);
  expect(statSync(databaseDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(nestedWal).mode & 0o777).toBe(0o600);

  const createdAfterward = join(statePath, "future-session.json");
  writeFileSync(createdAfterward, "private");
  expect(statSync(createdAfterward).mode & 0o777).toBe(0o600);
});

test("default infrastructure path is rejected without creating state in the checkout", () => {
  sandbox();
  const candidate = resolve(import.meta.dir, "..", ".state-probe");
  expect(() => ensureStateDir(candidate)).toThrow("protected DevHub path");
  expect(existsSync(candidate)).toBe(false);
});
