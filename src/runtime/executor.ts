import type { Executor, Follower, LogStreamName } from "../contracts";
import { DevHubError } from "../contracts";
import { isTrustedGitOptions } from "../git";

const inherited = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "NO_COLOR"];
const safeCallerEnvironment = new Set(["LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "NO_COLOR", "TERM", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR"]);
const trustedGitEnvironment = new Map([
  ["GIT_CONFIG_GLOBAL", "/dev/null"],
  ["GIT_CONFIG_NOSYSTEM", "1"],
  ["GIT_TERMINAL_PROMPT", "0"],
  ["GIT_PAGER", "cat"],
  ["GIT_ATTR_NOSYSTEM", "1"],
  ["GIT_EDITOR", "true"],
  ["GIT_SEQUENCE_EDITOR", "true"],
]);

// Children run in their own process groups, so nothing but this set reaches them at shutdown.
const running = new Set<number>();
let shuttingDown = false;
const signalGroup = (pid: number, signal: NodeJS.Signals | 0) => { try { process.kill(-pid, signal); return true; } catch { return false; } };
async function groupsExited(pids: number[], waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (pids.some((pid) => signalGroup(pid, 0))) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}
/** Refuse new commands and end every running group (SIGTERM, then SIGKILL after the grace period), so none outlives this process. */
export async function terminateChildren(graceMs = 5_000): Promise<void> {
  shuttingDown = true;
  const pids = [...running];
  for (const pid of pids) signalGroup(pid, "SIGTERM");
  if (await groupsExited(pids, graceMs)) return;
  for (const pid of pids) signalGroup(pid, "SIGKILL");
  await groupsExited(pids, 1_000);
}

const MAX_FOLLOW_LINE = 64 * 1024;

function commandEnvironment(options: Parameters<Executor>[1]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key]!;

  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (typeof value !== "string" || key.includes("\0") || value.includes("\0")) {
      throw new DevHubError("Invalid command environment", "unsafe_environment", 400);
    }
    if (safeCallerEnvironment.has(key)) {
      env[key] = value;
      continue;
    }
    const fixedGitValue = trustedGitEnvironment.get(key);
    if (fixedGitValue !== undefined && value === fixedGitValue && isTrustedGitOptions(options)) {
      env[key] = value;
      continue;
    }
    throw new DevHubError("Unsupported command environment variable", "unsafe_environment", 400);
  }
  return env;
}

/** Run argv directly with an allowlisted parent environment and finite output/time. */
export const execCommand: Executor = async (argv, options = {}) => {
  if (!argv.length || argv.some((value) => typeof value !== "string" || value.includes("\0"))) throw new DevHubError("Invalid command arguments");
  for (const value of [options.maxOutputBytes, options.timeoutMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new DevHubError("Command limits must be positive finite integers");
  }
  const env = commandEnvironment(options);
  const limit = Math.min(Math.max(options.maxOutputBytes ?? 2_097_152, 1), 16_777_216);
  const timeout = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 900_000);
  if (shuttingDown) throw new DevHubError("Controller is shutting down", "shutting_down", 503);
  const child = Bun.spawn(argv, { cwd: options.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  running.add(child.pid);
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
  } finally { if (timer) clearTimeout(timer); running.delete(child.pid); }
};

/** Streams a read-only command until it exits or stop() kills its group; the shutdown path tracks it like any other child. */
export const followLines: Follower = (argv, onLine) => {
  if (shuttingDown) throw new DevHubError("Controller is shutting down", "shutting_down", 503);
  const child = Bun.spawn(argv, { env: commandEnvironment({}), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  running.add(child.pid);
  const pump = async (source: ReadableStream<Uint8Array>, stream: LogStreamName) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of source) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop()!.slice(0, MAX_FOLLOW_LINE);
      for (const line of lines) onLine(line, stream);
    }
    if (rest) onLine(rest, stream);
  };
  const done = Promise.all([child.exited, pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]).then(([code]) => code).finally(() => running.delete(child.pid));
  return { stop: () => { signalGroup(child.pid, "SIGKILL"); }, done };
};
