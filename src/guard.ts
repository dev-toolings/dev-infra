import { basename } from "node:path";
import type { Executor } from "./contracts";
import { DevHubError } from "./contracts";
import { isTrustedGitOptions } from "./git";

/** Keys of a dotenv file as Compose reads them: `KEY=value` and also the YAML-style `KEY: value`. */
export function envFileKeys(text: string): string[] {
  return [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/gm)].map((match) => match[1]!);
}

const dockerGlobalValueOptions = new Set(["--config", "--context", "--host", "-H", "--log-level", "-l"]);
const composeGlobalValueOptions = new Set([
  "--ansi", "--env-file", "--file", "-f", "--parallel", "--profile", "--progress",
  "--project-directory", "--project-name", "-p",
]);
const dockerRunValueOptions = new Set([
  "--add-host", "--annotation", "--attach", "--blkio-weight", "--blkio-weight-device",
  "--cap-add", "--cap-drop", "--cgroupns", "--cgroup-parent", "--cpu-period", "--cpu-quota",
  "--cpu-rt-period", "--cpu-rt-runtime", "--cpu-shares", "--cpus", "--cpuset-cpus", "--cpuset-mems",
  "--device", "--device-cgroup-rule", "--device-read-bps", "--device-read-iops", "--device-write-bps",
  "--device-write-iops", "--dns", "--dns-option", "--dns-search", "--domainname", "--entrypoint",
  "--env", "--env-file", "--expose", "--gpus", "--group-add", "--health-cmd", "--health-interval",
  "--health-retries", "--health-start-interval", "--health-start-period", "--health-timeout",
  "--hostname", "--init-path", "--ip", "--ip6", "--ipc", "--isolation", "--kernel-memory",
  "--label", "--label-file", "--link", "--link-local-ip", "--log-driver", "--log-opt", "--mac-address",
  "--memory", "--memory-reservation", "--memory-swap", "--memory-swappiness", "--mount", "--name",
  "--network", "--network-alias", "--oom-score-adj", "--pid", "--pids-limit", "--platform",
  "--publish", "--pull", "--restart", "--runtime", "--security-opt", "--shm-size", "--stop-signal",
  "--stop-timeout", "--storage-opt", "--sysctl", "--tmpfs", "--ulimit", "--user", "--userns",
  "--uts", "--volume", "--volumes-from", "--workdir",
]);

function optionName(token: string): string | undefined {
  const match = /^--([^=]+)(?:=.*)?$/.exec(token);
  return match?.[1] ? `--${match[1]}` : undefined;
}

function nextCommandIndex(args: string[], start: number, valueOptions: Set<string>): number {
  for (let index = start; index < args.length;) {
    const token = args[index]!;
    if (token === "--") return -1;
    if (!token.startsWith("-")) return index;
    const name = optionName(token) ?? token;
    index += valueOptions.has(name) && !token.includes("=") ? 2 : 1;
  }
  return -1;
}

function optionValueFlagsContain(args: string[], start: number, longFlags: Set<string>, shortFlag?: string): boolean {
  for (let index = start; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") return false;
    const name = optionName(token);
    if (name && longFlags.has(name)) return true;
    if (shortFlag && /^-[^-]/.test(token) && token.slice(1).includes(shortFlag)) return true;
  }
  return false;
}

function dockerRunHasMountOrNoAutoRemove(args: string[], start: number): string | undefined {
  let hasAutoRemove = false;
  let hasIsolatedNetwork = false;
  const mountOptions = new Set(["--mount", "--volume", "--volumes-from"]);

  for (let index = start; index < args.length;) {
    const token = args[index]!;
    if (token === "--") break;
    if (!token.startsWith("-")) break; // The image name ends Docker option parsing.

    const name = optionName(token);
    if (name === "--network") {
      const network = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[index + 1];
      if (network !== "none") return "Docker candidate runs require --network none";
      hasIsolatedNetwork = true;
    }
    if (name && mountOptions.has(name)) return "Docker run mounts are not permitted";
    if (token.startsWith("--rm=") && token !== "--rm=true") return "Docker run must use --rm";
    if (token === "--rm" || token === "--rm=true") hasAutoRemove = true;
    if (/^-[^-]/.test(token)) {
      const flags = token.slice(1);
      if (flags.includes("v")) return "Docker run mounts are not permitted";
      // Docker's short options that take a separate value consume it here.
      if (flags === "a" || flags === "c" || flags === "e" || flags === "h" || flags === "l" || flags === "m" || flags === "p" || flags === "u" || flags === "w") {
        index += 2;
        continue;
      }
    }
    const long = name ?? token;
    if (dockerRunValueOptions.has(long) && !token.includes("=")) index += 2;
    else index += 1;
  }

  if (!hasAutoRemove) return "Docker run must use --rm";
  return hasIsolatedNetwork ? undefined : "Docker candidate runs require --network none";
}

function composeCommandError(rootArgs: string[]): string | undefined {
  const composeIndex = nextCommandIndex(rootArgs, 0, composeGlobalValueOptions);
  if (composeIndex < 0) return undefined;
  const action = rootArgs[composeIndex]!.toLowerCase();
  const actionArgs = rootArgs.slice(composeIndex + 1);

  if (rootArgs.some((arg) => arg === "--remove-orphans" || arg.startsWith("--remove-orphans="))) {
    return "Compose orphan removal is not permitted";
  }
  if ((action === "down" || action === "rm") && optionValueFlagsContain(actionArgs, 0, new Set(["--volumes"]), "v")) {
    return "Compose volume removal is not permitted";
  }
  if (action === "run") return "Compose run is not permitted";
  return undefined;
}

function dockerCommandError(argv: string[]): string | undefined {
  const executable = basename(argv[0] ?? "").toLowerCase();
  if (executable === "docker-compose" || executable === "docker-compose.exe") {
    return composeCommandError(argv.slice(1));
  }
  if (executable !== "docker" && executable !== "docker.exe") return undefined;

  const args = argv.slice(1);
  const rootIndex = nextCommandIndex(args, 0, dockerGlobalValueOptions);
  if (rootIndex < 0) return undefined;
  const root = args[rootIndex]!.toLowerCase();
  const rootArgs = args.slice(rootIndex + 1);

  if (root === "compose") return composeCommandError(rootArgs);

  if (root === "run" || (root === "container" && rootArgs[0]?.toLowerCase() === "run")) {
    const offset = root === "container" ? 1 : 0;
    return dockerRunHasMountOrNoAutoRemove(rootArgs, offset);
  }

  const subcommand = rootArgs[0]?.toLowerCase();
  if (root === "prune" || subcommand === "prune") return "Docker prune is not permitted";
  if ((root === "volume" || root === "network") && (subcommand === "rm" || subcommand === "remove")) {
    return `Docker ${root} removal is not permitted`;
  }

  if (((root === "rm" || root === "remove") || (root === "container" && (subcommand === "rm" || subcommand === "remove"))) && optionValueFlagsContain(rootArgs, root === "container" ? 1 : 0, new Set(["--volumes"]), "v")) {
    return "Docker container volume removal is not permitted";
  }

  return undefined;
}

/** Gate process execution against untrusted Git and destructive Docker argv. */
export function guardExecutor(run: Executor): Executor {
  return async (argv, options = {}) => {
    const executable = basename(argv[0] ?? "").toLowerCase();
    if ((executable === "git" || executable === "git.exe") && !isTrustedGitOptions(options)) {
      throw new DevHubError("Git must be invoked through gitRun", "unsafe_git", 403);
    }
    const denied = dockerCommandError(argv);
    if (denied) throw new DevHubError(denied, "unsafe_command", 403);
    return run(argv, options);
  };
}
