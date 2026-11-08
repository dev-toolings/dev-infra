import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRun, isTrustedGitOptions } from "./git";
import type { Executor } from "./contracts";
import { envFileKeys, guardExecutor } from "./guard";

test("env keys catch every form Compose reads as a control", () => {
  for (const text of ["COMPOSE_FILE=a", "COMPOSE_FILE: a", "  export COMPOSE_FILE : a", 'A="x" COMPOSE_FILE=a', "B='y' C=1 COMPOSE_FILE=a", '1X="a\nB="\nCOMPOSE_FILE=a', '.X="a\nB="\nCOMPOSE_FILE=a', 'X[0]="a\nB="\nCOMPOSE_FILE=a', 'A=\v"\nB="\nCOMPOSE_FILE=a', 'A="\n# x" COMPOSE_FILE=a']) {
    expect(envFileKeys(text)).toContain("COMPOSE_FILE");
  }
});

test("env keys skip plain comment lines", () => {
  expect(envFileKeys("# COMPOSE_FILE=old\n  #DOCKER_HOST=old\nA=1\n")).toEqual(["A"]);
});

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("guard rejects bare Git executables before invoking the runner", async () => {
  let calls = 0;
  const guarded = guardExecutor(async () => { calls += 1; return { code: 0, stdout: "", stderr: "" }; });

  for (const argv of [["git", "status"], ["/usr/bin/git", "status"], ["git.exe", "status"]]) {
    await expect(guarded(argv)).rejects.toThrow("gitRun");
  }
  expect(calls).toBe(0);
});

test("gitRun's branded options pass through the guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "devhub-guard-git-"));
  fixtures.push(root);
  const gitDir = join(root, ".git");
  mkdirSync(gitDir);
  const expectedGitDir = realpathSync(gitDir);
  const calls: Array<{ argv: string[]; trusted: boolean }> = [];
  const runner: Executor = async (argv, options = {}) => {
    calls.push({ argv, trusted: isTrustedGitOptions(options) });
    return argv.includes("rev-parse")
      ? { code: 0, stdout: `${expectedGitDir}\n${expectedGitDir}\n`, stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  };
  const guarded = guardExecutor(runner);

  const result = await gitRun(guarded, ["-C", root, "status"]);

  expect(result.code).toBe(0);
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.trusted)).toBe(true);
  expect(calls.at(-1)?.argv).toContain("status");
});

test("guard denies Docker destruction and mounted candidate containers before execution", async () => {
  let calls = 0;
  const guarded = guardExecutor(async () => { calls += 1; return { code: 0, stdout: "", stderr: "" }; });
  const forbidden = [
    ["docker", "system", "prune", "-af"],
    ["docker", "buildx", "prune", "-f"],
    ["docker", "--context", "default", "compose", "down", "-fv"],
    ["docker", "network", "rm", "dev-shared-net"],
    ["docker", "network", "rm", "devhub-shop-1234abcd", "dev-shared-net"],
    ["docker", "network", "rm", "-f", "devhub-shop-1234abcd"],
    ["docker", "volume", "rm", "project-data"],
    ["docker", "compose", "-p", "project", "down", "-v"],
    ["docker", "compose", "down", "--volumes=true"],
    ["docker", "compose", "down", "-fv"],
    ["docker-compose", "-p", "project", "down", "-v"],
    ["docker", "compose", "rm", "-vf"],
    ["docker", "compose", "up", "--remove-orphans"],
    ["docker", "rm", "-v", "container-id"],
    ["docker", "container", "rm", "-fv", "container-id"],
    ["docker", "run", "--rm", "--mount=type=bind,src=/tmp,dst=/mnt", "image"],
    ["docker", "run", "--rm", "-v/tmp:/mnt", "image"],
    ["docker", "container", "run", "--rm", "--volumes-from", "other", "image"],
    ["docker", "run", "image"],
    ["docker", "network", "remove", "dev-shared-net"],
    ["docker", "volume", "remove", "data"],
    ["docker", "container", "remove", "--volumes", "container"],
    ["docker", "remove", "-v", "container"],
    ["docker", "run", "--rm", "image"],
    ["docker", "run", "--rm", "--network=host", "image"],
    ["docker", "run", "--rm", "--network=none", "--network", "bridge", "image"],
    ["docker", "run", "--rm", "image", "--network=none"],
    ["docker", "run", "--rm", "--rm=false", "image"],
    ["docker", "compose", "run", "service"],
  ];

  for (const argv of forbidden) await expect(guarded(argv)).rejects.toMatchObject({ code: "unsafe_command" });
  expect(calls).toBe(0);
});

test("guard permits Docker read, config, up, and an ephemeral unmounted run", async () => {
  const calls: string[][] = [];
  const guarded = guardExecutor(async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; });
  const permitted = [
    ["docker", "ps", "--all", "--format", "json"],
    ["docker", "compose", "--project-name", "project", "config", "--format", "json", "--volumes"],
    ["docker", "compose", "--project-name", "project", "up", "-d", "web"],
    ["docker", "run", "--rm", "--network", "none", "image", "scan"],
  ];

  for (const argv of permitted) await guarded(argv);
  expect(calls).toEqual(permitted);
});

test("guard lets DevHub remove a project network of its own, and only that", async () => {
  const guarded = guardExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
  expect((await guarded(["docker", "network", "rm", "devhub-shop--fix-auth-0a1b2c3d"])).code).toBe(0);
  await expect(guarded(["docker", "network", "rm", "devhub-shop"])).rejects.toThrow("not permitted");
});
