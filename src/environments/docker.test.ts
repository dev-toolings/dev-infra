import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Executor } from "../contracts";
import { FeatureDocker } from "./docker";
import type { Environment, EnvironmentResources, Recipe } from "./types";

const environment: Environment = {
  id: "ef-0123456789abcdef0123456789abcdef",
  project: "shop",
  feature: "checkout",
  slug: "shop-checkout",
  composeProject: "devhub-ef-0123456789abcdef0123456789abcdef",
  provider: "docker-compose",
  host: "local",
  repos: [],
  desired: "running",
  observed: "ready",
  createdAt: "now",
  activeAt: "now",
  idleMinutes: 30,
  configuration: {
    fingerprint: "fingerprint",
    services: ["api"],
    volumes: [],
    networks: [],
    images: [],
    serviceImages: {},
  },
  resources: { containers: [], networks: [], volumes: [], images: [] },
  bootstrap: {},
};

function resourceResult(argv: string[], caseName: string): { code: number; stdout: string; stderr: string } {
  if (argv[1] === "ps" && argv.includes("-aq")) return { code: 0, stdout: caseName === "container" ? "container-1\n" : "", stderr: "" };
  if (argv[1] === "container" && argv[2] === "inspect") return { code: 0, stdout: `container-1\t/api\tapi\trunning\t\tsha256:image\tother-feature\t${environment.composeProject}\n`, stderr: "" };
  if (argv[1] === "volume" && argv[2] === "ls") return { code: 0, stdout: caseName === "volume" ? "shop-data\n" : "", stderr: "" };
  if (argv[1] === "volume" && argv[2] === "inspect") return { code: 0, stdout: `other-feature\t${environment.composeProject}\n`, stderr: "" };
  if (argv[1] === "network" && argv[2] === "ls") return { code: 0, stdout: caseName === "network" ? "feature-net\n" : "", stderr: "" };
  if (argv[1] === "network" && argv[2] === "inspect") return { code: 0, stdout: `network-id\tother-feature\t${environment.composeProject}\n`, stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
}

for (const caseName of ["container", "volume", "network"] as const) {
  test(`inspection rejects a ${caseName} with mismatched feature ownership before it can be removed`, async () => {
    const calls: string[][] = [];
    const run: Executor = async (argv) => { calls.push(argv); return resourceResult(argv, caseName); };
    const candidate: Environment = {
      ...environment,
      configuration: {
        ...environment.configuration!,
        volumes: caseName === "volume" ? ["shop-data"] : [],
        networks: caseName === "network" ? ["feature-net"] : [],
      },
    };
    const docker = new FeatureDocker(run, "/infra");

    await expect((async () => {
      const verified = await docker.inspect(candidate);
      await docker.stop(verified);
      await docker.remove(verified, true);
    })()).rejects.toMatchObject({ code: "ownership_conflict" });
    expect(calls[0]).toContain(`label=com.docker.compose.project=${environment.composeProject}`);
    expect(calls.some((argv) => argv[1] === "rm" || argv[1] === "stop" || argv[1] === "network" && argv[2] === "rm" || argv[1] === "volume" && argv[2] === "rm")).toBe(false);
  });
}

test("remove keeps verified named volumes unless purgeData is explicitly enabled", async () => {
  const calls: string[][] = [];
  const run: Executor = async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; };
  const resources: EnvironmentResources = {
    containers: [{ id: "container-1", name: "api", service: "api", state: "exited", imageId: "sha256:image" }],
    networks: [{ id: "network-1", name: "feature-net" }],
    volumes: [{ name: "shop-data" }],
    images: [],
  };
  const docker = new FeatureDocker(run, "/infra");

  await docker.remove(resources, false);
  expect(calls).toContainEqual(["docker", "rm", "container-1"]);
  expect(calls).toContainEqual(["docker", "network", "rm", "network-1"]);
  expect(calls.some((argv) => argv[1] === "volume" && argv[2] === "rm")).toBe(false);

  calls.length = 0;
  await docker.remove(resources, true);
  expect(calls).toContainEqual(["docker", "volume", "rm", "shop-data"]);
});

test("a failed Caddy reload remains retryable even after removing the route file", async () => {
  const root = mkdtempSync(join(tmpdir(), "devhub-feature-proxy-"));
  try {
    const config = join(root, "data", "caddy");
    const sites = join(config, "sites"), state = join(root, "state");
    mkdirSync(sites, { recursive: true }); mkdirSync(state);
    let reloads = 0;
    let denyReload = false;
    const run: Executor = async (argv) => {
      if (argv[1] === "inspect") return { code: 0, stdout: `running\t${config}\n`, stderr: "" };
      if (argv.includes("reload")) reloads++;
      return { code: denyReload ? 1 : 0, stdout: "", stderr: "" };
    };
    const docker = new FeatureDocker(run, root);
    const recipe = { previewDomain: "dev.example.invalid" } as Recipe;
    const preview = (port: number) => ({ url: `http://127.0.0.1:${port}`, port, tunnel: { remoteHost: "127.0.0.1" as const, remotePort: port } });
    const url = await docker.syncDomain(environment, recipe, state, preview(32001));
    expect(await docker.syncDomain(environment, recipe, state, preview(32002))).toBe(url);
    const route = join(sites, environment.id + ".caddy");
    expect(readFileSync(route, "utf8")).toContain("127.0.0.1:32002");
    denyReload = true;
    await expect(docker.syncDomain(environment, recipe, state)).rejects.toMatchObject({ code: "proxy_reload" });
    expect(existsSync(route)).toBe(false);
    expect(existsSync(join(state, "proxy-reload-pending"))).toBe(true);
    denyReload = false;
    await docker.syncDomain(environment, recipe, state);
    expect(reloads).toBe(4);
    expect(existsSync(join(state, "proxy-reload-pending"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
