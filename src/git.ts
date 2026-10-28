import { lstatSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import type { ExecOptions, Executor, ExecResult } from "./contracts";
import { DevHubError } from "./contracts";

const prefix = ["git", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "log.showSignature=false", "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false"];
const trustedOptions = new WeakSet<object>();
export const isTrustedGitOptions = (options?: ExecOptions): boolean => !!options && trustedOptions.has(options);
const commands = new Set(["init", "rev-parse", "config", "status", "diff", "switch", "checkout", "branch", "add", "commit", "restore", "worktree", "show", "log", "ls-files", "check-ref-format", "symbolic-ref"]);

/** Run Git with fixed config and refuse external repository execution hooks. */
export async function gitRun(run: Executor, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
  if (argv.some((arg) => arg.includes("\0") || arg.includes("\n"))) throw new DevHubError("Invalid Git argument");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (["LANG", "LC_ALL", "NO_COLOR", "TERM"].includes(key)) env[key] = value;
  }
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_ATTR_NOSYSTEM: "1", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });
  const opts = { ...options, env };
  trustedOptions.add(opts);
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
  let requested = resolve(options.cwd ?? process.cwd());
  for (let index = 0; index < location.length; index += 2) requested = resolve(requested, location[index + 1]!);
  requested = realpathSync(requested);
  const protectedPaths = [resolve(import.meta.dir, ".."), resolve(homedir(), ".local/share/devhub"), ...(process.env.DEVHUB_DIR ? [resolve(process.env.DEVHUB_DIR)] : [])].map((path) => existsSync(path) ? realpathSync(path) : path);
  if (protectedPaths.some((base) => requested === base || requested.startsWith(base + sep))) throw new DevHubError("Infrastructure checkout is protected", "unsafe_git", 409);
  if (verb === "init" && argv.length !== offset + 1) throw new DevHubError("Git initialization requires an explicit approved working directory", "unsafe_git", 409);
  if (verb !== "init") {
    let root = resolve(options.cwd ?? process.cwd());
    for (let index = 0; index < location.length; index += 2) root = resolve(root, location[index + 1]!);
    while (!existsSync(join(root, ".git"))) {
      const parent = dirname(root);
      if (parent === root) throw new DevHubError("Git checkout metadata is missing", "unsafe_git", 409);
      root = parent;
    }
    root = realpathSync(root);
    const reserved = [resolve(import.meta.dir, ".."), resolve(homedir(), ".local/share/devhub"), ...(process.env.DEVHUB_DIR ? [resolve(process.env.DEVHUB_DIR)] : [])].map((path) => existsSync(path) ? realpathSync(path) : path);
    const forbidden = (path: string) => reserved.some((base) => path === base || path.startsWith(base + sep));
    if (forbidden(root)) throw new DevHubError("Infrastructure checkout is protected", "unsafe_git", 409);
    const dot = join(root, ".git");
    if (lstatSync(dot).isSymbolicLink()) throw new DevHubError("Symlinked Git metadata is not supported", "unsafe_git", 409);
    let expectedDir: string;
    let expectedCommon: string;
    if (lstatSync(dot).isDirectory()) { expectedDir = realpathSync(dot); expectedCommon = expectedDir; }
    else {
      const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(dot, "utf8"));
      if (!match) throw new DevHubError("Invalid Git pointer", "unsafe_git", 409);
      expectedDir = realpathSync(resolve(root, match[1]!));
      const commonFile = join(expectedDir, "commondir"), backlink = join(expectedDir, "gitdir");
      if (!existsSync(commonFile) || !existsSync(backlink)) throw new DevHubError("Unverified external Git directory", "unsafe_git", 409);
      expectedCommon = realpathSync(resolve(expectedDir, readFileSync(commonFile, "utf8").trim()));
      const actualBacklink = realpathSync(resolve(expectedDir, readFileSync(backlink, "utf8").trim()));
      if (actualBacklink !== realpathSync(dot) || dirname(dirname(expectedDir)) !== expectedCommon || dirname(expectedDir) !== join(expectedCommon, "worktrees")) throw new DevHubError("Git worktree backlink mismatch", "unsafe_git", 409);
    }
    if (forbidden(expectedDir) || forbidden(expectedCommon)) throw new DevHubError("Infrastructure Git metadata is protected", "unsafe_git", 409);
    const metadata = await run([...prefix, ...location, "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"], opts);
    const paths = metadata.stdout.trim().split(/\r?\n/);
    if (metadata.code !== 0 || paths.length !== 2 || realpathSync(paths[0]!) !== expectedDir || realpathSync(paths[1]!) !== expectedCommon) throw new DevHubError("Git metadata does not belong to this checkout", "unsafe_git", 409);
  }
  const safeArgs = verb === "status" ? [...argv.slice(0, offset + 1), "--ignore-submodules=all", ...argv.slice(offset + 1)] : ["diff", "show", "log"].includes(verb) ? [...argv.slice(0, offset + 1), "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...argv.slice(offset + 1)] : argv;
  return run([...prefix, ...safeArgs], opts);
}
