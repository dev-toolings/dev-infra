import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "composer.json",
  "pyproject.toml",
  "go.mod",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

const PRIVATE_FILE_PATTERN = /(?:\.db|\.sqlite3?|\.sqlite3?-(?:wal|shm)|\.db-(?:wal|shm)|\.json|\.jsonl|\.key|\.pem|\.token|\.secret|\.credentials?)$/i;

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isAtOrBelow(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return pathFromParent === "" || (!isAbsolute(pathFromParent) && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`));
}

function canonicalProtectedPath(path: string): string[] {
  const absolute = resolve(path);
  try {
    return [absolute, realpathSync(absolute)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const suffix: string[] = [];
    let existing = absolute;
    while (!lstatOrNull(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return [absolute];
      suffix.unshift(basename(existing));
      existing = parent;
    }
    try {
      return [absolute, resolve(realpathSync(existing), ...suffix)];
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === "ENOENT") return [absolute];
      throw fallbackError;
    }
  }
}

function assertOutsideProtectedPaths(statePath: string, infraDir?: string): void {
  const configuredHome = process.env.HOME;
  const home = resolve(configuredHome || homedir());
  const protectedPaths = [
    infraDir === undefined ? resolve(import.meta.dir, "..") : infraDir,
    process.env.DEVHUB_DIR,
    join(home, ".local", "share", "devhub"),
  ].filter((path): path is string => Boolean(path));

  for (const protectedPath of protectedPaths) {
    for (const canonicalPath of canonicalProtectedPath(protectedPath)) {
      if (isAtOrBelow(statePath, canonicalPath) || isAtOrBelow(canonicalPath, statePath)) {
        throw new Error(`State directory must be outside protected DevHub path: ${statePath}`);
      }
    }
  }
}

function assertNoSymlinkedAncestors(statePath: string): void {
  const root = parse(statePath).root;
  const segments = statePath.slice(root.length).split(sep).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);
    const info = lstatOrNull(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`State path contains a symlink: ${current}`);
    if (!info.isDirectory()) throw new Error(`State path ancestor is not a directory: ${current}`);
  }
}

function assertNoProjectAncestor(statePath: string): void {
  const root = parse(statePath).root;
  let current = root;

  for (const segment of statePath.slice(root.length).split(sep).filter(Boolean)) {
    for (const marker of PROJECT_MARKERS) {
      if (lstatOrNull(join(current, marker))) {
        throw new Error(`State directory cannot be inside a project or Git tree: ${current}`);
      }
    }
    current = join(current, segment);
    if (!lstatOrNull(current)) return;
  }

  for (const marker of PROJECT_MARKERS) {
    if (lstatOrNull(join(current, marker))) {
      throw new Error(`State directory cannot be inside a project or Git tree: ${current}`);
    }
  }
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Cannot verify ownership of the DevHub state directory on this platform");
  }
  return process.getuid();
}

function secureExistingPrivateFiles(statePath: string, uid: number, secureAllFiles: boolean): void {
  for (const name of readdirSync(statePath)) {
    const filePath = join(statePath, name);
    const info = lstatSync(filePath);
    const privateFile = secureAllFiles || PRIVATE_FILE_PATTERN.test(name);
    if (info.isSymbolicLink() && privateFile) {
      throw new Error(`Private state file cannot be a symlink: ${filePath}`);
    }
    if (info.isDirectory()) {
      if (!secureAllFiles) continue;
      if (info.uid !== uid) throw new Error(`Private state directory is not owned by the current user: ${filePath}`);
      chmodSync(filePath, 0o700);
      secureExistingPrivateFiles(filePath, uid, true);
      continue;
    }
    if (!privateFile) continue;
    if (!info.isFile()) throw new Error(`Private state entry must be a regular file: ${filePath}`);
    if (info.uid !== uid) throw new Error(`Private state file is not owned by the current user: ${filePath}`);
    if (info.nlink !== 1) throw new Error(`Private state file has a hard link; provide an independent single-link file: ${filePath}`);
    chmodSync(filePath, 0o600);
  }
}

/**
 * Validate and create a canonical, private state directory. The restrictive
 * process umask also protects SQLite files created after this function returns.
 */
export function ensureStateDir(stateDir: string, infraDir?: string): string {
  if (typeof stateDir !== "string" || stateDir.length === 0 || stateDir.includes("\0") || !isAbsolute(stateDir)) {
    throw new Error("State directory path must be an absolute path");
  }
  if (stateDir.split(/[\\/]/).includes("..")) {
    throw new Error("State directory path must not contain parent traversal");
  }

  const statePath = resolve(stateDir);
  if (statePath === parse(statePath).root) throw new Error("Filesystem root cannot be used as the state directory");

  const home = resolve(process.env.HOME || homedir());
  assertOutsideProtectedPaths(statePath, infraDir);
  assertNoSymlinkedAncestors(statePath);
  assertNoProjectAncestor(statePath);

  const uid = currentUid();
  const existing = lstatOrNull(statePath);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`State path must be a real directory: ${statePath}`);
    }
    if (existing.uid !== uid) throw new Error(`State directory is not owned by the current user: ${statePath}`);
    if ((existing.mode & 0o777) !== 0o700) {
      throw new Error(`Existing state directory must have mode 0700: ${statePath}`);
    }
  } else {
    mkdirSync(statePath, { recursive: true, mode: 0o700 });
    assertNoSymlinkedAncestors(statePath);
    const created = lstatSync(statePath);
    if (!created.isDirectory() || created.isSymbolicLink() || created.uid !== uid) {
      throw new Error(`Could not safely create state directory: ${statePath}`);
    }
    chmodSync(statePath, 0o700);
  }

  secureExistingPrivateFiles(statePath, uid, !isAtOrBelow(home, statePath));
  process.umask(process.umask() | 0o077);
  return statePath;
}
