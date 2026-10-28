import { expect, test } from "bun:test";
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
