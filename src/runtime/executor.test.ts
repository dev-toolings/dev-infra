import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "./executor";
test("executor rejects excess output and enforces a finite deadline", async () => {
  await expect(execCommand([process.execPath, "--eval", "process.stdout.write('x'.repeat(65536))"], { maxOutputBytes: 64 })).rejects.toThrow("output exceeded");
  await expect(execCommand([process.execPath, "--eval", "setTimeout(()=>{},10000)"], { timeoutMs: 20 })).rejects.toThrow("timed out");
});

test("executor rejects caller-controlled executable and loader environment", async () => {
  for (const key of ["PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    await expect(execCommand([process.execPath, "--eval", "process.exit(0)"], { env: { [key]: "attacker-controlled" } })).rejects.toThrow("Unsupported command environment");
  }
});

test("executor passes only inherited safe values and explicit locale/color values to a child", async () => {
  const result = await execCommand([
    process.execPath,
    "--eval",
    "process.stdout.write(JSON.stringify({path:process.env.PATH,home:process.env.HOME,ldPreload:process.env.LD_PRELOAD,noColor:process.env.NO_COLOR,lang:process.env.LANG}))",
  ], { env: { NO_COLOR: "1", LANG: "C" } });
  const childEnv = JSON.parse(result.stdout) as Record<string, string | undefined>;

  expect(result.code).toBe(0);
  expect(childEnv.path).toBe(process.env.PATH);
  expect(childEnv.home).toBe(process.env.HOME);
  expect(childEnv.ldPreload).toBeUndefined();
  expect(childEnv.noColor).toBe("1");
  expect(childEnv.lang).toBe("C");
});

 test("executor rejects non-finite and fractional limits before spawning", async () => {
  for (const value of [NaN, Infinity, -1, 0, 0.5]) {
    for (const key of ["timeoutMs", "maxOutputBytes"]) await expect(execCommand(["never-spawn"], { [key]: value })).rejects.toThrow("positive finite integers");
  }
});

test("termination kills a child that ignores SIGTERM, waits for it and refuses new commands", async () => {
  const base = mkdtempSync(join(tmpdir(), "devhub-terminate-")), pidFile = join(base, "child.pid");
  const stubborn = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); require("node:fs").renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)}); setInterval(() => {}, 1000);`;
  const script = `
    import { existsSync, readFileSync } from "node:fs";
    import { execCommand, terminateChildren } from ${JSON.stringify(join(import.meta.dir, "executor.ts"))};
    void execCommand([process.execPath, "--eval", ${JSON.stringify(stubborn)}]).catch(() => {});
    while (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(10);
    const pid = Number(readFileSync(${JSON.stringify(pidFile)}, "utf8"));
    await terminateChildren(100);
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    const refused = await execCommand(["sleep", "30"]).then(() => "ran", (error) => error.code);
    process.stdout.write(JSON.stringify({ alive, refused }));
    process.exit(0);
  `;
  try {
    const fixture = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { cwd: base, stdout: "pipe", stderr: "inherit" });
    expect(await new Response(fixture.stdout).text()).toBe(JSON.stringify({ alive: false, refused: "shutting_down" }));
    expect(await fixture.exited).toBe(0);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 20_000);
