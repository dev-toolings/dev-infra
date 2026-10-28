import type { Executor } from "../contracts";
import { DevHubError } from "../contracts";

const inherited = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "TERM", "NO_COLOR"];
/** Run argv directly with an allowlisted parent environment and finite output/time. */
export const execCommand: Executor = async (argv, options = {}) => {
  if (!argv.length || argv.some((value) => typeof value !== "string" || value.includes("\0"))) throw new DevHubError("Invalid command arguments");
  const env: Record<string, string> = {};
  for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  Object.assign(env, options.env);
  const limit = Math.min(Math.max(options.maxOutputBytes ?? 2_097_152, 1), 16_777_216);
  const timeout = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 900_000);
  const child = Bun.spawn(argv, { cwd: options.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let used = 0;
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(); readers.push(reader);
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      used += chunk.value.length;
      if (used > limit) { kill(); throw new DevHubError("Command output exceeded its limit", "output_limit", 502); }
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(buffer);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { kill(); reject(new DevHubError("Command timed out", "timeout", 504)); }, timeout); });
    const [code, stdout, stderr] = await Promise.race([result, deadline]);
    return { code, stdout, stderr };
  } catch (error) {
    kill();
    for (const reader of readers) void reader.cancel().catch(() => {});
    throw error;
  } finally { if (timer) clearTimeout(timer); }
};
