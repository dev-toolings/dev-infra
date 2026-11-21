import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DevHubError } from "../contracts";

/** Linux flock releases the descriptor when the owner exits, including after SIGKILL. */
export async function featureLock<T>(directory: string, name: string, execute: () => Promise<T> | T, waitSeconds = 0): Promise<T> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(["flock", "--conflict-exit-code", "75", "--timeout", String(waitSeconds), join(directory, name + ".lock"),
    "/bin/sh", "-c", "printf 'locked\\n'; cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  try {
    const signal = await reader.read();
    if (signal.done) {
      const code = await child.exited;
      throw new DevHubError(code === 75 ? "A conflicting feature operation is active" : "Could not acquire a feature lock",
        code === 75 ? "operation_busy" : "lock_failed", code === 75 ? 409 : 500);
    }
    return await execute();
  } finally {
    child.stdin.end();
    await child.exited;
    await reader.cancel();
  }
}
