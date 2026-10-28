import type { ExecOptions, Executor, ExecResult } from "./contracts";
import { DevHubError } from "./contracts";

const prefix = ["git", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "log.showSignature=false"];
const commands = new Set(["init", "rev-parse", "config", "status", "diff", "switch", "checkout", "branch", "add", "commit", "restore", "worktree", "show", "log", "ls-files", "check-ref-format", "symbolic-ref"]);

/** Run Git with fixed config and refuse external repository execution hooks. */
export async function gitRun(run: Executor, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
  if (argv.some((arg) => arg.includes("\0") || arg.includes("\n"))) throw new DevHubError("Invalid Git argument");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_ATTR_NOSYSTEM: "1", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });
  const opts = { ...options, env };
  let offset = 0;
  const location: string[] = [];
  while (argv[offset] === "-C") {
    const path = argv[offset + 1];
    if (!path) throw new DevHubError("Missing Git directory");
    location.push("-C", path);
    offset += 2;
  }
  const verb = argv[offset];
  if (!verb || !commands.has(verb)) throw new DevHubError("Explicit Git command required");
  if (!["init", "rev-parse", "config", "check-ref-format"].includes(verb)) {
    const check = await run([...prefix, ...location, "config", "--no-includes", "--name-only", "--get-regexp", "^(core\\.worktree$|gpg\\..*program$|include\\.|includeif\\.|filter\\.|merge\\..*\\.driver$|diff\\..*\\.(command|textconv)$)"], opts);
    if (check.code === 0 && check.stdout.trim()) throw new DevHubError("Repository has external configuration or filters; manual review required", "unsafe_git", 409);
    if (check.code !== 0 && check.code !== 1) throw new DevHubError("Cannot verify repository configuration", "unsafe_git", 409);
  }
  const safeArgs = ["diff", "show", "log"].includes(verb) ? [...argv.slice(0, offset + 1), "--no-ext-diff", "--no-textconv", ...argv.slice(offset + 1)] : argv;
  return run([...prefix, ...safeArgs], opts);
}
