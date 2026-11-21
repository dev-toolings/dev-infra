import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Executor, Project } from "../contracts";

export const proxyHost = (label: string) => `${label.replace(/_/g, "-")}.localhost`;
export type ProxySite = { host: string; upstream: string };

/** A project answers on <id>.localhost; a feature writes its own site (environments/docker.ts syncDomain). */
export function proxySites(projects: Project[]): ProxySite[] {
  return projects.flatMap((project) => {
    const url = project.components.find((component) => component.url)?.url;
    if (!url) return [];
    const { hostname, host } = new URL(url);
    if (hostname !== "127.0.0.1" && hostname !== "localhost") return [];
    return [{ host: proxyHost(project.id), upstream: host }];
  });
}

export function renderSites(sites: ProxySite[]): string {
  return sites.map(({ host, upstream }) => `http://${host} {\n\tbind 127.0.0.1\n\treverse_proxy ${upstream}\n}\n`).join("\n");
}

/** Writes the sites Caddy imports, then reloads it when the proxy profile runs. */
export async function syncProxy(run: Executor, infraDir: string, projects: Project[]): Promise<{ sites: ProxySite[]; reloaded: boolean }> {
  const sites = proxySites(projects);
  writeFileSync(join(infraDir, "data", "caddy", "sites", "devhub.caddy"), renderSites(sites));
  const reload = await run(["docker", "exec", "infra-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile"], { timeoutMs: 30_000, maxOutputBytes: 64_000 });
  return { sites, reloaded: reload.code === 0 };
}
