import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRun } from "./git";
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

test("neutralizes global hooks and local signing programs", async () => {
  const { path, call } = await fixture();
  const marker = join(path, "executed");
  const program = join(path, "unsafe-program");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  writeFileSync(join(path, ".git", "hooks", "post-commit"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const globalConfig = join(path, "hostile-global");
  writeFileSync(globalConfig, `[core]\n hooksPath = ${join(path, ".git", "hooks")}\n[commit]\n gpgSign = true\n[gpg]\n program = ${program}\n`);
  await call(["config", "commit.gpgSign", "true"]);
  await call(["config", "gpg.program", program]);
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
