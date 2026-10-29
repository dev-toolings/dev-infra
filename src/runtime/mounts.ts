import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DevHubError } from "../contracts";

/** Subset of `docker compose config --format json` used by the mount policy. */
export type ComposeModel = {
  services?: Record<string, { volumes?: Array<string | { type?: string; source?: string }>; env_file?: unknown } | undefined>;
  volumes?: Record<string, { name?: string; external?: boolean; driver_opts?: Record<string, unknown> } | null>;
};

const within = (path: string, root: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const refuse = (message: string) => new DevHubError(message, "unsafe_compose", 403);
/** Resolve symlinks of the longest existing prefix so aliases of protected paths are caught. */
function canonicalHostPath(path: string): string {
  const absolute = resolve(path);
  let prefix = absolute; const rest: string[] = [];
  while (true) {
    try { return join(realpathSync(prefix), ...rest); } catch {
      const parent = resolve(prefix, "..");
      if (parent === prefix) return absolute;
      rest.unshift(prefix.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); prefix = parent;
    }
  }
}
export function sharedVolumeName(name: string): boolean {
  return /^(?:dev-infra|devhub|devhub-infra)_/.test(name) || /^infra_[a-z0-9]+_data$/.test(name) || /_infra_[a-z0-9]+_data$/.test(name);
}
export function protectedHostPaths(stateDir: string): string[] {
  // Docker storage roots back every named volume, including the shared infra volumes, so they are protected as a whole.
  const home = resolve(process.env.HOME || homedir());
  return ["/var/run/docker.sock", "/run/docker.sock", "/var/lib/docker", "/var/lib/containerd", join(home, ".local/share/docker"), resolve(import.meta.dir, "../.."), stateDir, process.env.DEVHUB_DIR, join(resolve(process.env.HOME || homedir()), ".local/share/devhub")]
    .filter((x): x is string => !!x).flatMap((p) => [...new Set([resolve(p), canonicalHostPath(p)])]);
}
/**
 * Project code is trusted, but shared DevHub data, the Docker socket and DevHub state must never be
 * mounted into project containers, whether by bind mount, symlink alias, external volume or a
 * local-driver volume whose device points at a protected host path.
 */
export function assertSharedDataUntouched(model: ComposeModel, services: string[], stateDir: string): void {
  const protectedPaths = protectedHostPaths(stateDir);
  const hostPathProtected = (path: string) => { const real = canonicalHostPath(path); return protectedPaths.some((p) => within(real, p) || within(p, real)); };
  for (const [key, volume] of Object.entries(model.volumes ?? {})) {
    const name = typeof volume?.name === "string" ? volume.name : key;
    if (sharedVolumeName(name)) throw refuse("Project Compose files cannot use shared DevHub volumes");
    const device = volume?.driver_opts?.device;
    if (device !== undefined && (typeof device !== "string" || !isAbsolute(device) || hostPathProtected(device))) throw refuse("Project volumes cannot bind the Docker socket or DevHub data");
  }
  for (const service of services) for (const mount of model.services?.[service]?.volumes ?? []) {
    const source = typeof mount === "string" ? mount.split(":")[0]! : typeof mount?.source === "string" ? mount.source : "";
    const type = typeof mount === "string" ? (source.startsWith("/") || source.startsWith(".") ? "bind" : "volume") : mount?.type;
    if (type === "volume" && source && sharedVolumeName(model.volumes?.[source]?.name ?? source)) throw refuse("Project Compose files cannot use shared DevHub volumes");
    if (type === "bind" && isAbsolute(source) && hostPathProtected(source)) throw refuse("Project Compose files cannot mount the Docker socket or DevHub data");
  }
}
