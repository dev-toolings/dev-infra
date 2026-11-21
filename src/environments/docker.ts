import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DevHubError, type ExecOptions, type Executor, type ExecResult } from "../contracts";
import { LOCAL_DOCKER_HOST } from "../runtime/executor";
import type { Environment, EnvironmentResources, Preview, Recipe } from "./types";

export const featureLabel = "com.devhub.feature";
export const gateway = "devhub-preview";
const projectLabel = "com.docker.compose.project";
const localDockerHost = LOCAL_DOCKER_HOST;
const owner = '{{index .Labels "' + featureLabel + '"}}';
const project = '{{index .Labels "' + projectLabel + '"}}';
const containerFormat = '{{.Id}}\t{{.Name}}\t{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.Image}}\t{{index .Config.Labels "' + featureLabel + '"}}\t{{index .Config.Labels "' + projectLabel + '"}}';
const inspectedResources = new WeakMap<EnvironmentResources, { network: Set<string>; volume: Set<string> }>();
const featureRemoval = Symbol("featureRemoval");
type FeatureExecOptions = ExecOptions & { [featureRemoval]?: EnvironmentResources };

export function allowsVerifiedFeatureRemoval(kind: "network" | "volume", targets: string[], options?: FeatureExecOptions): boolean {
  const resources = options?.[featureRemoval];
  const verified = resources && inspectedResources.get(resources)?.[kind];
  return !!verified && targets.length > 0 && targets.every((target) => verified.has(target));
}

const lines = (value: string) => value.split(/\r?\n/).filter(Boolean);
/** The domain alias of a feature preview; the ID part keeps two features with the same name apart. */
export const previewHost = (env: Pick<Environment, "id" | "slug">, domain: string) => `${env.slug}-${env.id.slice(3, 11)}.${domain}`;
/** The HTTP port of the DevHub proxy that serves feature domain aliases. */
export function featureProxyPort(): number {
  const port = Number(process.env.DEVHUB_FEATURE_PROXY_PORT ?? 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DevHubError("Invalid feature proxy port", "proxy_unavailable", 409);
  return port;
}
export const emptyResources = (): EnvironmentResources => ({ containers: [], volumes: [], networks: [], images: [] });

/** Docker operations execute against the local Ubuntu Engine, even when the caller has another context selected. */
export function hostExecutor(run: Executor): Executor {
  return (argv, options) => argv[0] === "docker"
    ? run(["docker", "--config", join(homedir(), ".docker"), "--host=" + localDockerHost, ...argv.slice(1)], { ...options, environment: "isolated" })
    : run(argv, options);
}

export class FeatureDocker {
  constructor(private readonly run: Executor, private readonly infraDir: string) {}

  private async docker(args: string[], code: string, message: string, timeoutMs = 30_000, removal?: EnvironmentResources): Promise<string> {
    const options: FeatureExecOptions = { timeoutMs, maxOutputBytes: 2_097_152, [featureRemoval]: removal };
    const result = await this.run(["docker", ...args], options);
    if (result.code !== 0) throw new DevHubError(message, code, 409);
    return result.stdout;
  }

  compose(env: Environment, directory: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
    return this.run(["docker", "compose", "--ansi", "never", "-p", env.composeProject, "--project-directory", directory,
      "--env-file", "/dev/null", "-f", join(directory, "compose.json"), ...args], { timeoutMs, maxOutputBytes: 2_097_152 });
  }

  async inspect(env: Environment): Promise<EnvironmentResources> {
    const expected = env.configuration;
    const projectFilter = "label=" + projectLabel + "=" + env.composeProject;
    const featureFilter = "label=" + featureLabel + "=" + env.id;
    const ids = lines(await this.docker(["ps", "-aq", "--filter", projectFilter], "docker_info", "Could not list feature containers"));
    const result = emptyResources();
    if (ids.length) {
      const output = await this.docker(["container", "inspect", "--format", containerFormat, ...ids], "docker_info", "Could not inspect feature containers");
      for (const line of lines(output)) {
        const [id, name, service, state, health, imageId, ownedBy, composeProject] = line.split("\t");
        if (!id || !name || !service || !state || !imageId || ownedBy !== env.id || composeProject !== env.composeProject || !expected?.services.includes(service)) {
          throw new DevHubError("A container in this Compose project could not be verified as owned by the feature", "ownership_conflict", 409);
        }
        result.containers.push({ id, name: name.replace(/^\//, ""), service, state, ...(health ? { health } : {}), imageId });
      }
    }
    const volumeNames = new Set(lines(await this.docker(["volume", "ls", "--format", "{{.Name}}"], "docker_info", "Could not list Docker volumes")));
    for (const name of expected?.volumes ?? []) {
      if (!volumeNames.has(name)) continue;
      const labels = (await this.docker(["volume", "inspect", "--format", owner + "\t" + project, name], "docker_info", "Could not inspect feature volume")).trim();
      if (labels !== env.id + "\t" + env.composeProject) throw new DevHubError(`Volume ${name} does not belong to this feature`, "ownership_conflict", 409);
      result.volumes.push({ name });
    }
    const networks = new Set(lines(await this.docker(["network", "ls", "--format", "{{.Name}}"], "docker_info", "Could not list Docker networks")));
    for (const name of expected?.networks ?? []) {
      if (!networks.has(name)) continue;
      const [id, ownedBy, composeProject] = (await this.docker(["network", "inspect", "--format", "{{.Id}}\t" + owner + "\t" + project, name], "docker_info", "Could not inspect feature network")).trim().split("\t");
      if (!id || ownedBy !== env.id || composeProject !== env.composeProject) throw new DevHubError(`Network ${name} does not belong to this feature`, "ownership_conflict", 409);
      result.networks.push({ id, name });
    }
    const labeledNetworks = lines(await this.docker(["network", "ls", "--filter", featureFilter, "--format", "{{.Name}}"], "docker_info", "Could not list owned networks"));
    const labeledVolumes = lines(await this.docker(["volume", "ls", "--filter", featureFilter, "--format", "{{.Name}}"], "docker_info", "Could not list owned volumes"));
    if (labeledNetworks.some((name) => !result.networks.some((entry) => entry.name === name)) || labeledVolumes.some((name) => !result.volumes.some((entry) => entry.name === name))) {
      throw new DevHubError("Docker reported a labeled resource outside the recorded configuration", "ownership_conflict", 409);
    }
    for (const reference of expected?.images ?? []) {
      const info = await this.run(["docker", "image", "inspect", "--format", '{{.Id}}\t{{index .Config.Labels "' + featureLabel + '"}}', reference], { timeoutMs: 10_000 });
      if (info.code === 0) {
        const [id, ownedBy] = info.stdout.trim().split("\t");
        if (!id || ownedBy !== env.id) throw new DevHubError(`Image ${reference} does not belong to this feature`, "ownership_conflict", 409);
        result.images.push({ reference, id });
      }
    }
    // Keep the verified targets tied to this inspection. Remove networks by ID so an identically named replacement is never selected.
    inspectedResources.set(result, {
      network: new Set(result.networks.filter(({ id, name }) => /^[a-f0-9]{64}$/.test(id) && /^devhub-(?:net|ingress|publish|egress)-[a-f0-9]{20}$/.test(name)).map(({ id }) => id)),
      volume: new Set(result.volumes.filter(({ name }) => /^devhub-vol-[a-f0-9]{24}$/.test(name)).map(({ name }) => name)),
    });
    return result;
  }

  async ensureImages(env: Environment, directory: string, build: boolean): Promise<void> {
    const config = env.configuration!;
    // Inspect the private model for image-declared volumes to disallow untracked anonymous data.
    const model = JSON.parse(readFileSync(join(directory, "compose.json"), "utf8")) as {
      services: Record<string, { volumes?: { target: string }[]; tmpfs?: string[] }>;
    };
    for (const image of new Set(Object.values(config.serviceImages))) {
      if (config.images.includes(image)) continue;
      const inspect = await this.run(["docker", "image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 10_000 });
      if (inspect.code !== 0) await this.docker(["pull", image], "image_pull", `Could not pull image ${image}`, 600_000);
    }
    if (config.images.length && (build || env.resources.images.length !== config.images.length)) {
      const result = await this.compose(env, directory, ["build"], 600_000);
      if (result.code !== 0) throw new DevHubError("Feature image build failed", "build_failed", 409);
    }
    for (const [service, reference] of Object.entries(config.serviceImages)) {
      const targets = JSON.parse(await this.docker(["image", "inspect", "--format", "{{json .Config.Volumes}}", reference],
        "image_inspect", `Could not inspect image volumes for service ${service}`)) as Record<string, unknown> | null;
      const definition = model.services[service]!;
      const mounts = new Set([...(definition.volumes ?? []).map((item) => item.target), ...(definition.tmpfs ?? []).map((item) => item.split(":")[0])]);
      if (Object.keys(targets ?? {}).some((target) => !mounts.has(target))) {
        throw new DevHubError(`Service ${service} uses an image with anonymous data volumes. Declare a named volume, a feature bind, or a tmpfs for each image volume.`, "anonymous_volume", 409);
      }
    }
  }

  async stop(resources: EnvironmentResources): Promise<void> {
    const ids = resources.containers.filter(({ state }) => state === "running" || state === "restarting").map(({ id }) => id);
    if (ids.length) await this.docker(["stop", "--time", "10", ...ids], "docker_stop", "Could not stop verified feature containers", 120_000);
  }

  async remove(resources: EnvironmentResources, purgeData: boolean): Promise<void> {
    if (resources.containers.length) await this.docker(["rm", ...resources.containers.map(({ id }) => id)], "docker_remove", "Could not remove verified feature containers", 120_000);
    if (resources.networks.length) await this.docker(["network", "rm", ...resources.networks.map(({ id }) => id)], "docker_remove", "Could not remove verified feature networks", 60_000, resources);
    if (purgeData && resources.volumes.length) await this.docker(["volume", "rm", ...resources.volumes.map(({ name }) => name)], "docker_remove", "Could not purge verified feature volumes", 60_000, resources);
  }

  async endpoint(env: Environment): Promise<Preview | undefined> {
    const proxy = env.resources.containers.find((container) => container.service === gateway && container.state === "running");
    if (!proxy) return undefined;
    const output = await this.docker(["port", proxy.id, "8080/tcp"], "preview_port", "Could not inspect the assigned preview port");
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(output);
    const port = Number(match?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DevHubError("The preview did not receive a single loopback publication", "preview_port", 409);
    return { url: `http://127.0.0.1:${port}`, port, tunnel: { remoteHost: "127.0.0.1", remotePort: port } };
  }

  async health(recipe: Recipe, preview?: Preview): Promise<boolean> {
    if (!recipe.routes.length) return true;
    if (!preview) return false;
    const results = await Promise.all(recipe.routes.map(async (route) => {
      try {
        const response = await fetch(preview.url + (route.healthPath ?? route.path), { signal: AbortSignal.timeout(3000), redirect: "manual" });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    }));
    return results.every(Boolean);
  }

  async syncDomain(env: Environment, recipe: Recipe, directory: string, preview?: Preview): Promise<string | undefined> {
    if (!recipe.previewDomain) return undefined;
    const host = previewHost(env, recipe.previewDomain);
    const file = join(this.infraDir, "data", "caddy", "sites", env.id + ".caddy");
    const pending = join(directory, "proxy-reload-pending");
    if (!preview && !existsSync(file) && !existsSync(pending)) return undefined;
    const composePort = featureProxyPort();
    const mounts = await this.run(["docker", "inspect", "--format", '{{.State.Status}}\t{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}', "infra-caddy"], { timeoutMs: 5000 });
    const expected = "running\t" + join(this.infraDir, "data", "caddy");
    // The .localhost alias of a DevHub project feature is optional, like the project's own: Caddy reads it when the proxy starts.
    if (preview && !recipe.generated && (mounts.code !== 0 || mounts.stdout.trim() !== expected)) throw new DevHubError("Start the DevHub proxy profile on this Ubuntu host before enabling domain aliases", "proxy_unavailable", 409);
    if (preview) {
      const next = `http://${host} {\n\tbind 127.0.0.1\n\treverse_proxy 127.0.0.1:${preview.port}\n}\n`;
      if (existsSync(file) && readFileSync(file, "utf8") === next && !existsSync(pending)) return `http://${host}${composePort === 80 ? "" : ":" + composePort}`;
      writeFileSync(pending, "", { mode: 0o600 });
      writeFileSync(file + ".tmp", next, { mode: 0o600 });
      renameSync(file + ".tmp", file);
    } else {
      writeFileSync(pending, "", { mode: 0o600 });
      rmSync(file, { force: true });
    }
    if (mounts.code === 0 && mounts.stdout.trim() === expected) {
      const reload = await this.run(["docker", "exec", "infra-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], { timeoutMs: 30_000 });
      if (reload.code !== 0) throw new DevHubError("Caddy rejected the feature route update", "proxy_reload", 409);
    }
    rmSync(pending, { force: true });
    return preview ? `http://${host}${composePort === 80 ? "" : ":" + composePort}` : undefined;
  }

  logs(containerId: string, tail: number): Promise<ExecResult> {
    return this.run(["docker", "logs", "--tail", String(tail), "--timestamps", containerId], { timeoutMs: 15_000, maxOutputBytes: 512_000 });
  }

  async containerEnvironment(containerId: string): Promise<string[]> {
    const output = await this.docker(["container", "inspect", "--format", "{{json .Config.Env}}", containerId], "docker_info", "Could not inspect the feature container environment");
    const variables = JSON.parse(output) ?? [];
    if (!Array.isArray(variables) || variables.some((value) => typeof value !== "string")) throw new DevHubError("Docker returned an invalid container environment", "docker_info", 409);
    return variables;
  }

  exec(containerId: string, argv: string[], timeoutMs: number, cwd?: string): Promise<ExecResult> {
    const seconds = Math.ceil(timeoutMs / 1000);
    return this.run(["docker", "exec", ...(cwd ? ["--workdir", cwd] : []), containerId, "timeout", "-k", "5", String(seconds), ...argv],
      { timeoutMs: timeoutMs + 8000, maxOutputBytes: 512_000 });
  }
}
