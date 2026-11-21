import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { DevHubError, type Executor } from "../contracts";
import type { Environment, Recipe } from "./types";

const CADDY_IMAGE = "caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee";
const OWNER_LABEL = "com.devhub.feature";
const NAME = /^[a-z0-9][a-z0-9_-]{0,55}$/;
const SERVICE = /^[a-zA-Z0-9][A-Za-z0-9_.-]{0,62}$/;
type Model = {
  services: Record<string, Record<string, any>>;
  networks?: Record<string, Record<string, any>>;
  volumes?: Record<string, Record<string, any>>;
  secrets?: Record<string, Record<string, any>>;
  configs?: Record<string, Record<string, any>>;
  "x-devhub-env-files"?: Record<string, (string | { path: string; required?: boolean; format?: string })[]>;
};

const fail = (message: string): never => { throw new DevHubError(message, "compose_invalid", 400); };
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

function safePath(path: string, roots: string[], kind: string, approved: string[] = []): string {
  if (!isAbsolute(path)) fail(`Compose ${kind} path must be absolute after normalization`);
  const canonical = (() => { try { return realpathSync(path); } catch { return fail(`Compose ${kind} path is missing`); } })();
  if (!roots.some((root) => inside(root, canonical)) && !approved.includes(canonical)) fail(`Compose ${kind} path escapes the confirmed environment repositories`);
  const st = lstatSync(canonical);
  if (!st.isFile() && !st.isDirectory()) fail(`Compose ${kind} path must be a regular file or directory`);
  return canonical;
}

function repoRoots(env: Environment): string[] {
  return env.repos.filter((repo) => !repo.removed).map((repo) => {
    if (realpathSync(repo.path) !== repo.path) fail("A confirmed worktree path has moved");
    return repo.path;
  });
}

function composeRoot(recipe: Recipe, env: Environment): string {
  const repo = env.repos.find((item) => item.name === recipe.compose.repository && !item.removed);
  if (!repo) fail("Compose source repository is not attached to this environment");
  return realpathSync(repo!.path);
}

function escapeEnv(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function validateModel(model: Model, selected: string[], shared: { networks: string[]; volumes: string[] }): void {
  if (!object(model.services)) fail("Compose did not produce a service model");
  for (const name of selected) if (!object(model.services[name])) fail("A selected Compose service is missing");
  for (const [name, service] of Object.entries(model.services)) {
    if (service.privileged || service.devices || service.network_mode || [service.pid, service.ipc, service.uts].some((value) => typeof value === "string" && /^(?:host|container:|service:)/.test(value)) || service.volumes_from) fail(`Compose service ${name} requests host access that the environment cannot isolate`);
    if (service.cap_add?.length || service.cgroup_parent || service.userns_mode || service.links?.length || service.runtime || service.use_api_socket ||
        service.cgroup === "host" || service.security_opt?.length || service.gpus || service.device_cgroup_rules?.length || service.mac_address ||
        service.credential_spec || service.post_start?.length || service.pre_stop?.length || service.deploy?.resources?.reservations?.devices?.length) fail(`Compose service ${name} requests host privileges that the environment cannot isolate`);
    if (service.build && (service.build.privileged || service.build.network === "host")) fail(`Compose service ${name} requests a privileged build`);
    const buildKeys = new Set(["context", "dockerfile", "args", "target", "cache_from", "cache_to", "pull", "no_cache", "shm_size", "platform", "tags", "labels"]);
    if (service.build && (Object.keys(service.build).some((key) => !buildKeys.has(key)) || service.build.ssh || service.build.entitlements || service.build.additional_contexts || service.build.dockerfile_inline || service.build.secrets || service.build.network || service.build.cache_to?.length || service.build.cache_from?.length)) fail(`Compose service ${name} uses unsupported build options`);
    if (service.build && !object(service.build.args ?? {})) fail(`Compose service ${name} has invalid build arguments`);
    for (const network of Object.values(object(service.networks) ? service.networks : {})) {
      if (object(network) && ["ipv4_address", "ipv6_address", "link_local_ips", "mac_address", "interface_name"].some((key) => network[key] !== undefined)) fail(`Compose service ${name} sets static network identity`);
    }
    for (const raw of service.volumes ?? []) {
      const mount = object(raw) ? raw : undefined;
      if (!mount || !["bind", "volume", "tmpfs"].includes(mount.type)) fail(`Compose service ${name} uses an unsupported mount type`);
      if (mount?.type === "bind" && (mount.bind?.propagation || mount.bind?.selinux)) fail(`Compose service ${name} uses unsafe bind options`);
      if (mount?.type === "volume" && !mount.source) fail(`Compose service ${name} declares an anonymous volume; use a named volume or tmpfs`);
    }
  }
  for (const [name, volume] of Object.entries(model.volumes ?? {})) {
    if (volume.external && !shared.volumes.includes(String(volume.name ?? name))) fail(`Compose volume ${name} is external but not approved as shared`);
    if (!volume.external && (volume.driver_opts || (volume.driver && volume.driver !== "local"))) fail(`Compose volume ${name} uses driver options that cannot be isolated`);
  }
  for (const [name, network] of Object.entries(model.networks ?? {})) {
    if (network.external && !shared.networks.includes(String(network.name ?? name))) fail(`Compose network ${name} is external but not approved as shared`);
    const ipam = network.ipam;
    const ipamConfig = object(ipam) ? ipam.config : undefined;
    const configuredIpam = Array.isArray(ipamConfig) ? ipamConfig.length > 0 : ipamConfig !== undefined && ipamConfig !== null;
    if (!network.external && (network.driver && network.driver !== "bridge" || network.driver_opts && Object.keys(network.driver_opts).length > 0 || configuredIpam || (object(ipam) && ipam.driver && ipam.driver !== "default") || network.enable_ipv6 === true || network.attachable === true)) fail(`Compose network ${name} uses unsupported network isolation options`);
  }
  for (const [kind, resources] of [["secret", model.secrets], ["config", model.configs]] as const) {
    for (const [name, resource] of Object.entries(resources ?? {})) if (resource.external || !resource.file) fail(`Compose ${kind} ${name} must use a local confirmed file`);
  }
}

function caddyfile(routes: Recipe["routes"]): string {
  const ordered = [...routes].sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  const lines = [":8080 {", "\troute {", "\t\thandle /__devhub_health {", "\t\t\trespond 200", "\t\t}"];
  for (const route of ordered.filter((item) => item.path !== "/")) {
    const matcher = `route_${hash(route.path).slice(0, 8)}`;
    const path = route.path.endsWith("/") ? `${route.path}*` : `${route.path} ${route.path}/*`;
    lines.push(`\t\t@${matcher} path ${path}`, `\t\thandle @${matcher} {`, `\t\t\treverse_proxy ${route.service}-${hash(`${route.path}:${route.service}`).slice(0, 8)}:${route.port}`, "\t\t}");
  }
  const fallback = ordered.find((route) => route.path === "/");
  if (fallback) lines.push("\t\thandle {", `\t\t\treverse_proxy ${fallback.service}-${hash(`${fallback.path}:${fallback.service}`).slice(0, 8)}:${fallback.port}`, "\t\t}");
  else lines.push("\t\thandle {", "\t\t\trespond 404", "\t\t}");
  lines.push("\t}", "}", "");
  return lines.join("\n");
}

function validateRoutes(recipe: Recipe, model: Model): void {
  const seen = new Set<string>();
  for (const route of recipe.routes) {
    if (!route.path.startsWith("/") || route.path.includes("\n") || route.path.includes("\r") || !SERVICE.test(route.service) || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535) fail("A route has an invalid path, service, or port");
    if (route.path === "/__devhub_health") fail("The route path /__devhub_health is reserved for the gateway health check");
    if (seen.has(route.path)) fail("Route paths must be unique");
    seen.add(route.path);
    if (!model.services[route.service]) fail(`Route target service ${route.service} is missing`);
  }
}

function escapeCompose(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("$", "$$");
  if (Array.isArray(value)) return value.map(escapeCompose);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escapeCompose(item)]));
  return value;
}

function unescapeCompose(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("$$", "$" );
  if (Array.isArray(value)) return value.map(unescapeCompose);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unescapeCompose(item)]));
  return value;
}

async function composeConfig(run: Executor, args: string[], cwd: string, flags: string[], final = false): Promise<Model> {
  const result = await run([...args, "config", "--format", "json", ...flags], { cwd, timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.code !== 0) fail(final ? "Final Compose model could not be revalidated" : "Compose configuration could not be normalized");
  try { return JSON.parse(result.stdout) as Model; } catch { return fail(final ? "Final Compose model is invalid" : "Compose returned an invalid normalized model"); }
}

function rebaseResources(model: Model, env: Environment, directory: string, secretFiles: string[]): void {
  const roots = repoRoots(env);
  for (const [name, service] of Object.entries(model.services)) {
    if (service.build) {
      const build = typeof service.build === "string" ? { context: service.build } : service.build;
      if (typeof build.context !== "string") fail("Compose build context is missing");
      build.context = safePath(build.context, roots, "build context");
      if (build.dockerfile) build.dockerfile = safePath(isAbsolute(build.dockerfile) ? build.dockerfile : resolve(build.context, build.dockerfile), roots, "Dockerfile");
      service.build = build;
    }
    for (const raw of service.volumes ?? []) {
      const mount = typeof raw === "string" ? raw : raw;
      if (object(mount) && mount.type === "bind") {
        const generated = name === "devhub-preview" ? [join(directory, "Caddyfile")] : [];
        mount.source = safePath(String(mount.source), roots, "bind", generated);
        mount.bind = { ...(mount.bind ?? {}), create_host_path: false };
      }
    }
    for (const key of ["env_file"] as const) {
      const files = service[key] === undefined ? [] : Array.isArray(service[key]) ? service[key] : [service[key]];
      for (const item of files) {
        const path = typeof item === "string" ? item : object(item) ? item.path : undefined;
        if (typeof path !== "string") fail("Compose env_file entries must be normalized paths");
        const normalized = safePath(path, roots, "env_file");
        if (object(item)) item.path = normalized;
      }
    }
  }
  for (const [kind, resources] of [["secret", model.secrets], ["config", model.configs]] as const) {
    for (const item of Object.values(resources ?? {})) {
      item.file = safePath(String(item.file), roots, kind, kind === "secret" ? secretFiles : []);
      if (!lstatSync(item.file).isFile()) fail(`Compose ${kind} must point to a regular file`);
    }
  }
}

/** Rechecks all filesystem paths consumed by Docker before an environment starts or rebuilds. */
export function verifyComposePaths(env: Environment, directory: string): string {
  const composeFile = join(directory, "compose.json"), model = unescapeCompose(JSON.parse(readFileSync(composeFile, "utf8"))) as Model;
  const pathManifest = JSON.parse(readFileSync(join(directory, "compose.paths.json"), "utf8")) as { secretFiles: string[] };
  rebaseResources(model, env, directory, pathManifest.secretFiles);
  const caddyFile = join(directory, "Caddyfile");
  const fingerprint = hash(`${readFileSync(composeFile, "utf8")}\n${existsSync(caddyFile) ? readFileSync(caddyFile, "utf8") : ""}\n${JSON.stringify(pathManifest)}`);
  if (env.configuration?.fingerprint && env.configuration.fingerprint !== fingerprint) fail("Environment Compose inputs changed since the model was confirmed");
  return fingerprint;
}

export async function renderCompose(run: Executor, recipe: Recipe, env: Environment, directory: string): Promise<{
  fingerprint: string; services: string[]; volumes: string[]; networks: string[]; images: string[]; serviceImages: Record<string, string>;
}> {
  if (!NAME.test(env.id) || !NAME.test(env.composeProject) || !NAME.test(env.slug)) fail("Environment Compose identity is invalid");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outDir = realpathSync(directory), projectRoot = composeRoot(recipe, env), roots = repoRoots(env);
  if (recipe.compose.services.some((name) => !SERVICE.test(name)) || !recipe.compose.profiles.every((name) => SERVICE.test(name))) fail("Compose service or profile selection is invalid");
  const files = recipe.compose.files.map((entry) => {
    const repo = env.repos.find((item) => item.name === entry.repository && !item.removed);
    if (!repo) fail("Compose file repository is not attached to this environment");
    const root = realpathSync(repo!.path), file = safePath(resolve(root, entry.path), [root], "file");
    if (!lstatSync(file).isFile()) fail("Compose file must be a regular file");
    return file;
  });
  if (!files.length || files[0] === undefined) fail("At least one Compose file is required");
  const declarations = new Map<string, string>();
  for (const [index, file] of files.entries()) {
    let source: unknown;
    try { source = parse(readFileSync(file, "utf8")); } catch { fail("Compose source file could not be parsed safely"); }
    if (!object(source) || "include" in source || !object(source.services)) fail("Compose include is not supported by environment recipes");
    for (const [name, service] of Object.entries((source as Record<string, any>).services)) {
      const sourceRepo = recipe.compose.files[index]!.repository;
      const previousRepo = declarations.get(name);
      if (previousRepo && previousRepo !== sourceRepo) fail(`Compose service ${name} is declared in more than one repository`);
      declarations.set(name, sourceRepo);
      if (!object(service)) continue;
      if ("extends" in service || "label_file" in service) fail(`Compose service ${name} uses extends or label_file, which environment recipes do not support`);
      const build = service.build;
      const context = typeof build === "string" ? build : object(build) ? build.context : undefined;
      if (typeof context === "string" && /^(?:https?:|git@)/i.test(context)) fail(`Compose service ${name} uses a remote build context`);
    }
  }
  const varsPath = join(outDir, "compose.vars");
  const secretPaths = Object.values(recipe.compose.secretFiles);
  for (const path of secretPaths) if (realpathSync(path) !== path || !lstatSync(path).isFile()) fail("Compose secret source must be a regular file without symlinks");
  const pathManifest = { secretFiles: secretPaths };
  writeFileSync(join(outDir, "compose.paths.json"), `${JSON.stringify(pathManifest)}\n`, { mode: 0o600 });
  const repoVars = Object.fromEntries(env.repos.filter((repo) => !repo.removed).map((repo) => [`DEVHUB_REPO_${repo.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`, realpathSync(repo.path)]));
  const composeVars = { ...recipe.compose.vars, ...repoVars, ...Object.fromEntries(Object.entries(recipe.compose.secretFiles).map(([key, path]) => [key, realpathSync(path)])) };
  const vars = Object.entries(composeVars).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ["PATH", "HOME", "XDG_RUNTIME_DIR"].includes(key) || typeof value !== "string" || value.includes("\0")) fail("Compose variables contain an invalid entry");
    return `${key}=${escapeEnv(value)}`;
  }).join("\n") + "\n";
  writeFileSync(varsPath, vars, { mode: 0o600 });
  const args = ["docker", "compose", "--project-directory", projectRoot, "--env-file", varsPath, "-p", env.composeProject];
  for (const file of files) args.push("-f", file);
  for (const profile of recipe.compose.profiles) args.push("--profile", profile);
  // Some Compose releases still resolve service env files when interpolating the model.
  const raw = await composeConfig(run, args, projectRoot, ["--no-env-resolution", "--no-interpolate", "--no-normalize", "--no-path-resolution", "--no-consistency"]);
  const envFiles = Object.fromEntries(Object.entries(raw.services ?? {}).filter(([, service]) => service.env_file?.length)
    .map(([name, service]) => [name, [service.env_file].flat()]));
  const envFileServices = Object.keys(envFiles);
  let model: Model;
  if (envFileServices.length) {
    // Interpolate the merged references as extension data while resetting the actual env_file field.
    const temp = mkdtempSync(join(tmpdir(), "devhub-compose-"));
    try {
      const override = join(temp, "env-files.yml");
      const reset = envFileServices.map((name) => `  ${JSON.stringify(name)}:\n    env_file: !reset []`).join("\n");
      writeFileSync(override, `x-devhub-env-files: !override ${JSON.stringify(envFiles)}\nservices:\n${reset}\n`, { mode: 0o600 });
      model = await composeConfig(run, [...args, "-f", override], projectRoot, ["--no-env-resolution"]);
      const references = model["x-devhub-env-files"];
      delete model["x-devhub-env-files"];
      for (const name of envFileServices) {
        const service = model.services[name];
        if (!service) continue;
        const entries = references?.[name];
        if (service.env_file?.length || !Array.isArray(entries) || !entries.length) return fail("Compose could not preserve the service environment file references");
        service.env_file = entries.map((item) => {
          const entry = typeof item === "string" ? { path: item } : item;
          if (!object(entry) || typeof entry.path !== "string" || !entry.path) fail("Compose env_file entries must have a path");
          return { ...entry, path: resolve(projectRoot, entry.path) };
        });
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  } else {
    model = await composeConfig(run, args, projectRoot, ["--no-env-resolution"]);
  }
  const selected = recipe.compose.services.length ? [...recipe.compose.services] : Object.entries(model.services)
    .filter(([, service]) => !Array.isArray(service.profiles) || service.profiles.length === 0 || service.profiles.some((profile: string) => recipe.compose.profiles.includes(profile)))
    .map(([name]) => name);
  if (!selected.length) fail("No Compose services are enabled by the selected profiles");
  validateModel(model, selected, recipe.shared);
  validateRoutes(recipe, model);
  for (const route of recipe.routes) if (!selected.includes(route.service)) fail(`Route target service ${route.service} is not selected`);
  rebaseResources(model, env, outDir, secretPaths);
  for (const service of Object.values(model.services)) { delete service.container_name; delete service.ports; }

  const label = { [OWNER_LABEL]: env.id };
  const networkNames: string[] = [];
  const declared = model.networks ?? {};
  for (const [key, value] of Object.entries(declared)) {
    if (value.external) continue;
    const name = `devhub-net-${hash(`${env.id}:${key}`).slice(0, 20)}`;
    value.name = name; value.labels = { ...(value.labels ?? {}), ...label }; networkNames.push(name);
  }
  model.networks = declared;

  const gatewayNetworks: Record<string, Record<string, unknown>> = {};
  if (recipe.routes.length) {
    // Reuse one feature-owned subnet when all routed services are on it. Otherwise allocate one private ingress subnet.
    const routeNetwork = Object.entries(declared).find(([key, network]) => !network.external && !network.internal &&
      recipe.routes.every(({ service }) => Object.hasOwn(model.services[service]!.networks ?? {}, key)))?.[0];
    const network = routeNetwork ?? "devhub-ingress-" + hash(env.id).slice(0, 20);
    if (!routeNetwork) {
      if (Object.hasOwn(declared, network)) fail("Compose network conflicts with the generated preview network");
      declared[network] = { name: network, labels: label };
      networkNames.push(network);
    }
    for (const route of recipe.routes) {
      const alias = `${route.service}-${hash(`${route.path}:${route.service}`).slice(0, 8)}`;
      const target = model.services[route.service]!;
      const current = object(target.networks) ? target.networks : {};
      target.networks = { ...current, [network]: { ...(current[network] ?? {}), aliases: [...new Set([...(current[network]?.aliases ?? []), alias])] } };
    }
    gatewayNetworks[network] = {};
  }

  for (const name of selected) {
    const service = model.services[name]!;
    const dependencies = object(service.depends_on) ? Object.keys(service.depends_on) : Array.isArray(service.depends_on) ? service.depends_on : [];
    if (dependencies.some((dependency: string) => !selected.includes(dependency))) fail(`Compose service ${name} depends on a service that is not selected`);
  }
  for (const step of recipe.steps) if (!selected.includes(step.service)) fail(`Recipe step ${step.id} uses an unselected service`);
  model.services = Object.fromEntries(selected.map((name) => [name, model.services[name]]));
  const serviceImages: Record<string, string> = {};
  if (Object.hasOwn(model.services, "devhub-preview")) fail("Compose service name devhub-preview is reserved");
  for (const [name, service] of Object.entries(model.services)) {
    service.labels = { ...(service.labels ?? {}), ...label };
    delete service.profiles;
    if (service.restart === "always") service.restart = "unless-stopped";
    if (service.build) {
      const image = `devhub-env-${hash(env.id).slice(0, 12)}-${hash(name).slice(0, 12)}:latest`;
      service.image = image; serviceImages[name] = image;
      service.build.labels = { ...(service.build.labels ?? {}), ...label };
      delete service.build.tags;
      delete service.build.cache_from;
      delete service.build.cache_to;
    } else if (typeof service.image === "string") serviceImages[name] = service.image;
    service.logging = { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } };
    service.deploy = { ...(service.deploy ?? {}), resources: { ...(service.deploy?.resources ?? {}), limits: { ...(service.deploy?.resources?.limits ?? {}), cpus: String(recipe.resources.cpus), memory: `${recipe.resources.memoryMiB}M` } } };
  }

  if (recipe.routes.length) {
    const gatewayName = "devhub-preview";
    const gateway = {
      image: CADDY_IMAGE, restart: "unless-stopped", command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile"],
      ports: [{ target: 8080, host_ip: "127.0.0.1", protocol: "tcp" }],
      volumes: [{ type: "bind", source: join(outDir, "Caddyfile"), target: "/etc/caddy/Caddyfile", read_only: true, bind: { create_host_path: false } }],
      tmpfs: ["/data", "/config"], networks: gatewayNetworks,
      labels: label, logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/__devhub_health"], interval: "5s", timeout: "3s", retries: 12 },
      deploy: { resources: { limits: { cpus: String(recipe.resources.cpus), memory: `${recipe.resources.memoryMiB}M` } } },
    };
    model.services[gatewayName] = gateway;
    serviceImages[gatewayName] = CADDY_IMAGE;
    writeFileSync(join(outDir, "Caddyfile"), caddyfile(recipe.routes), { mode: 0o600 });
  }

  for (const [name, volume] of Object.entries(model.volumes ?? {})) {
    if (!volume.external) {
      volume.name = `devhub-vol-${hash(`${env.id}:${name}`).slice(0, 24)}`;
      volume.labels = { ...(volume.labels ?? {}), ...label };
    }
  }
  const composeFile = join(outDir, "compose.json");
  const json = `${JSON.stringify(escapeCompose(model), null, 2)}\n`;
  writeFileSync(composeFile, json, { mode: 0o600 });
  // Final validation resolves the env files in memory. The on-disk model keeps only their paths.
  const finalArgs = ["docker", "compose", "--project-directory", outDir, "--env-file", "/dev/null", "-p", env.composeProject, "-f", composeFile];
  const verified = await composeConfig(run, finalArgs, outDir, [], true);
  validateModel(verified, Object.keys(model.services), recipe.shared);
  rebaseResources(verified, env, outDir, secretPaths);
  for (const [name, service] of Object.entries(verified.services)) {
    if (service.labels?.[OWNER_LABEL] !== env.id) fail(`Final Compose service ${name} lost its owner label`);
    if (name !== "devhub-preview" && service.ports?.length) fail(`Final Compose service ${name} publishes a host port`);
  }
  for (const [key, network] of Object.entries(verified.networks ?? {})) if (!network.external && network.labels?.[OWNER_LABEL] !== env.id) fail(`Final Compose network ${key} lost its owner label`);
  for (const [key, volume] of Object.entries(verified.volumes ?? {})) if (!volume.external && volume.labels?.[OWNER_LABEL] !== env.id) fail(`Final Compose volume ${key} lost its owner label`);
  const volumeNames = Object.entries(verified.volumes ?? {}).filter(([, value]) => !value.external).map(([key, value]) => String(value.name ?? key));
  const images = Object.entries(serviceImages).filter(([service]) => Boolean(verified.services[service]?.build)).map(([, image]) => image);
  const fingerprint = hash(`${json}\n${recipe.routes.length ? readFileSync(join(outDir, "Caddyfile"), "utf8") : ""}\n${JSON.stringify(pathManifest)}`);
  return { fingerprint, services: Object.keys(verified.services), volumes: volumeNames, networks: networkNames, images, serviceImages };
}
