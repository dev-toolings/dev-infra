import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Executor } from "../contracts";
import { Versions } from "./index";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(answer: { code: number; stdout: string; stderr: string }, goInstalled = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "devhub-versions-")); dirs.push(stateDir);
  const run: Executor = async (argv) => argv[0] === "which" ? { code: goInstalled ? 0 : 1, stdout: "", stderr: "" } : answer;
  return new Versions({ run, stateDir, infraDir: "/infra" });
}
const report = { checkedAt: "2026-11-04T00:00:00Z", items: [{ name: "mysql", state: "eol", vulns: [], errors: [] }] };

test("a report with findings exits non-zero but is kept, and reading it runs nothing", async () => {
  const versions = fixture({ code: 1, stdout: JSON.stringify(report), stderr: "exit status 1" });
  expect(versions.latest()).toBeUndefined();
  expect(await versions.check()).toEqual(report as never);
  expect(versions.latest()).toEqual(report as never);
});

test("a second check joins the one in progress, and a broken report file reads as none", async () => {
  let runs = 0;
  const stateDir = mkdtempSync(join(tmpdir(), "devhub-versions-")); dirs.push(stateDir);
  const run: Executor = async (argv) => { if (argv[0] === "go") runs++; return { code: 0, stdout: JSON.stringify(report), stderr: "" }; };
  const versions = new Versions({ run, stateDir, infraDir: "/infra" });
  await Promise.all([versions.check(), versions.check()]);
  expect(runs).toBe(1);
  writeFileSync(join(stateDir, "versions.json"), "{ cut");
  expect(versions.latest()).toBeUndefined();
});

test("a check without output or without Go fails and names the cause", async () => {
  await expect(fixture({ code: 1, stdout: "", stderr: "versionwatch: no compose.yml" }).check()).rejects.toThrow("no compose.yml");
  await expect(fixture({ code: 0, stdout: "", stderr: "" }, false).check()).rejects.toThrow("Go is needed");
});
