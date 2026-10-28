import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitRun } from "./git";
import { execCommand } from "./runtime/executor";
import type { Executor } from "./contracts";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
const run: Executor = async (argv, options = {}) => {
  const process = Bun.spawn(argv, { cwd: options.cwd, env: { PATH: Bun.env.PATH!, ...options.env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
};
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), "devhub-git-")); fixtures.push(path);
  const call = (args: string[]) => gitRun(run, ["-C", path, ...args]);
  expect((await call(["init"])).code).toBe(0);
  await call(["config", "user.name", "agent-local"]);
  await call(["config", "user.email", "agent-local@localhost"]);
  return { path, call };
}

test("neutralizes global hooks and signing configuration", async () => {
  const { path, call } = await fixture();
  const marker = join(path, "executed");
  const program = join(path, "unsafe-program");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  writeFileSync(join(path, ".git", "hooks", "post-commit"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const globalConfig = join(path, "hostile-global");
  writeFileSync(globalConfig, `[core]\n hooksPath = ${join(path, ".git", "hooks")}\n[commit]\n gpgSign = true\n[gpg]\n program = ${program}\n`);
  await call(["config", "commit.gpgSign", "true"]);
  writeFileSync(join(path, "file"), "fixture\n");
  expect((await call(["add", "file"])).code).toBe(0);
  const result = await gitRun(run, ["-C", path, "commit", "-m", "fixture"], { env: { GIT_CONFIG_GLOBAL: globalConfig } });
  expect(result.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test("rejects local external filters and merge drivers before repository reads or mutations", async () => {
  const { path, call } = await fixture();
  const marker = join(path, "executed");
  const program = join(path, "unsafe-filter");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
  await call(["config", "filter.escape.clean", program]);
  writeFileSync(join(path, ".gitattributes"), "file filter=escape\n");
  writeFileSync(join(path, "file"), "fixture\n");
  await expect(call(["status", "--porcelain"])).rejects.toThrow("external configuration");
  expect(existsSync(marker)).toBe(false);
  await call(["config", "--unset", "filter.escape.clean"]);
  await call(["config", "merge.escape.driver", program]);
  await expect(call(["add", "file"])).rejects.toThrow("external configuration");
  expect(existsSync(marker)).toBe(false);
});

async function committedFixture() {
  const item = await fixture();
  writeFileSync(join(item.path, "file"), "fixture\n");
  expect((await item.call(["add", "file"])).code).toBe(0);
  expect((await item.call(["commit", "-m", "fixture"])).code).toBe(0);
  return item;
}

test("rejects filters in linked worktree configuration for reads and writes", async () => {
  const { path, call } = await committedFixture();
  await call(["config", "extensions.worktreeConfig", "true"]);
  const linked = join(path, "linked");
  expect((await call(["worktree", "add", "-b", "linked", linked])).code).toBe(0);
  const marker = join(path, "executed");
  const program = join(path, "unsafe-worktree-filter");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
  expect((await gitRun(run, ["-C", linked, "config", "--worktree", "filter.escape.clean", program])).code).toBe(0);
  writeFileSync(join(linked, ".gitattributes"), "file filter=escape\n");
  await expect(gitRun(run, ["-C", linked, "status", "--porcelain"])).rejects.toThrow("external configuration");
  await expect(gitRun(run, ["-C", linked, "add", "file"])).rejects.toThrow("external configuration");
  expect(existsSync(marker)).toBe(false);
});

test("rejects repository signature programs even when show-signature is configured", async () => {
  const { path, call } = await committedFixture();
  const marker = join(path, "executed");
  const program = join(path, "unsafe-signature");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await call(["config", "log.showSignature", "true"]);
  await call(["config", "gpg.program", program]);
  await expect(call(["show", "HEAD"])).rejects.toThrow("external configuration");
  expect(existsSync(marker)).toBe(false);
});

test("rejects core.worktree redirection outside the approved checkout", async () => {
  const { path, call } = await committedFixture();
  const outside = mkdtempSync(join(tmpdir(), "devhub-git-outside-")); fixtures.push(outside);
  writeFileSync(join(outside, "file"), "unchanged\n");
  await call(["config", "core.worktree", outside]);
  await expect(call(["restore", "file"])).rejects.toThrow("external configuration");
  expect(await Bun.file(join(outside, "file")).text()).toBe("unchanged\n");
});

test("rejects a forged Git pointer while allowing a genuine linked worktree", async () => {
  const { path, call } = await committedFixture();
  const linked = join(path, "genuine");
  expect((await call(["worktree", "add", "-b", "genuine", linked])).code).toBe(0);
  expect((await gitRun(run, ["-C", linked, "status", "--porcelain"])).code).toBe(0);
  const forged = mkdtempSync(join(tmpdir(), "devhub-git-forged-")); fixtures.push(forged);
  writeFileSync(join(forged, ".git"), `gitdir: ${join(path, ".git")}\n`);
  await expect(gitRun(run, ["-C", forged, "status", "--porcelain"])).rejects.toThrow("Unverified external Git directory");
});

test("real executor drops ambient Git redirection and configuration parameters", async () => {
  const { path } = await committedFixture();
  const previousDir = process.env.GIT_DIR, previousParameters = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_DIR = "/does-not-exist/devhub-hostile-git";
  process.env.GIT_CONFIG_PARAMETERS = "'core.worktree'='/does-not-exist/redirected'";
  try { expect((await gitRun(execCommand, ["-C", path, "status", "--porcelain"])).code).toBe(0); }
  finally {
    if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir;
    if (previousParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS; else process.env.GIT_CONFIG_PARAMETERS = previousParameters;
  }
});

test("caller PATH and loader injection cannot override the hardened Git environment", async () => {
  const { path } = await committedFixture();
  const result = await gitRun(execCommand, ["-C", path, "status", "--porcelain"], { env: { PATH: "/does-not-exist", LD_PRELOAD: "/does-not-exist/unsafe.so" } });
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("preload");
});
test("initialization rejects the infrastructure checkout before invoking Git", async () => {
  let calls = 0;
  const fake: Executor = async () => { calls++; return { code: 0, stdout: "", stderr: "" }; };
  await expect(gitRun(fake, ["init"], { cwd: resolve(import.meta.dir, "..") })).rejects.toThrow("protected");
  expect(calls).toBe(0);
});
