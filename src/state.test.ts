import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
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

test("rejects HOME as state without changing project children", () => {
  const { home, infra } = sandbox();
  const childProject = join(home, "projects", "sample");
  mkdirSync(childProject, { recursive: true });
  writeFileSync(join(childProject, "package.json"), "{}");
  const childProjectMode = statSync(join(childProject, "package.json")).mode & 0o777;

  const mask = process.umask();
  expect(() => ensureStateDir(home, infra)).toThrow("protected DevHub path");
  expect(process.umask()).toBe(mask);
  expect(readFileSync(join(childProject, "package.json"), "utf8")).toBe("{}");
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

test("rejects a hard link without changing the outside file", () => {
  const { root, infra } = sandbox();
  mkdirSync(infra);
  const target = join(infra, "executable.sh");
  writeFileSync(target, "fixture preserved");
  chmodSync(target, 0o755);
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  const linked = join(state, "private.json");
  linkSync(target, linked);

  expect(() => ensureStateDir(state, infra)).toThrow(/hard link/i);
  expect(statSync(target).mode & 0o777).toBe(0o755);
  expect(readFileSync(target, "utf8")).toBe("fixture preserved");
  expect(existsSync(linked)).toBe(true);
  expect(statSync(linked).nlink).toBe(2);
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

for (const kind of ["infra", "configured", "installer", "alias"] as const) {
  test(`state ancestor refuses ${kind} before chmod`, () => {
    const root = mkdtempSync("/var/tmp/devhub-overlap-"); fixtures.push(root);
    const home = join(root, "home"), parent = join(root, "state"), target = join(parent, "checkout");
    mkdirSync(home, {mode:0o700}); mkdirSync(parent, {mode:0o700}); mkdirSync(target, {mode:0o755});
    chmodSync(parent,0o700); chmodSync(target,0o755);
    const sentinel = join(target, "sentinel.txt"); writeFileSync(sentinel,"fixture preserved"); chmodSync(sentinel,0o644);
    process.env.HOME = home; delete process.env.DEVHUB_DIR;
    let infra = join(root, "other-infra");
    if (kind === "infra") infra = target;
    if (kind === "configured") process.env.DEVHUB_DIR = target;
    if (kind === "installer") {
      mkdirSync(join(home,".local","share"),{recursive:true});
      symlinkSync(target,join(home,".local","share","devhub"));
    }
    if (kind === "alias") { infra = join(root,"infra-alias"); symlinkSync(target,infra); }
    const mask = process.umask();
    let error: unknown;
    try { ensureStateDir(parent,infra); } catch (caught) { error = caught; }
    const unchanged = {
      file: statSync(sentinel).mode & 0o777,
      directory: statSync(target).mode & 0o777,
      contents: readFileSync(sentinel,"utf8"),
      mask: process.umask(),
    };
    expect(() => { if (error) throw error; }).toThrow("protected DevHub path");
    expect(unchanged).toEqual({file:0o644,directory:0o755,contents:"fixture preserved",mask});
  });
}

test("supports the dedicated default state directory under HOME", () => {
  const { home, infra } = sandbox();
  const state = join(home, ".local", "state", "devhub");
  expect(ensureStateDir(state, infra)).toBe(state);
  expect(statSync(state).mode & 0o777).toBe(0o700);
});
