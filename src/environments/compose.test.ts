import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../catalog";
import type { Executor } from "../contracts";
import type { Environment, Recipe } from "./types";
import { renderCompose, verifyComposePaths } from "./compose";
import { Environments } from "./index";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devhub-env-compose-")); dirs.push(root);
  const repo = join(root, "repo"), output = join(root, "runtime");
  mkdirSync(join(repo, "app"), { recursive: true }); mkdirSync(output);
  writeFileSync(join(repo, "compose.yml"), "services:\n  api:\n    build: ./app\n    networks: [default]\nnetworks:\n  default: {}\n");
  writeFileSync(join(repo, "app", "Dockerfile"), "FROM alpine:3\n");
  const recipe: Recipe = {
    version: 1, repositories: { app: { path: repo, ref: "main" } },
    compose: { repository: "app", files: [{ repository: "app", path: "compose.yml" }], profiles: [], services: ["api"], vars: { APP_MODE: "test" }, secretFiles: {} },
    routes: [{ path: "/api", service: "api", port: 8080 }, { path: "/", service: "api", port: 8080 }], steps: [], shared: { networks: [], volumes: [] },
    resources: { cpus: 1, memoryMiB: 512 }, idleMinutes: 30, localFiles: [],
  };
  const env: Environment = {
    id: "demo-feature", project: "demo", feature: "feature", slug: "demo-feature", composeProject: "devhub-demo-feature", provider: "docker-compose", host: "local",
    repos: [{ name: "app", source: "local", path: repo, ref: "main", sha: "abc", branch: "main", attach: true, prepared: true }],
    desired: "running", observed: "creating", createdAt: "now", activeAt: "now", idleMinutes: 30, resources: { containers: [], networks: [], volumes: [], images: [] }, bootstrap: {},
  };
  const model: Record<string, any> = {
    services: { api: { build: { context: join(repo, "app"), dockerfile: "Dockerfile" }, networks: { default: {} }, volumes: [] } },
    networks: { default: {} }, volumes: {},
  };
  const commands: string[][] = [];
  const run: Executor = async (argv) => {
    commands.push(argv);
    const input = argv.indexOf("-f");
    const body = argv.includes("/dev/null") && input >= 0 ? readFileSync(argv[input + 1]!, "utf8") : JSON.stringify(model);
    return { code: 0, stdout: body, stderr: "" };
  };
  return { root, repo, output, recipe, env, model, run, commands };
}

test("renders an isolated Compose model and a path preserving gateway", async () => {
  const f = fixture();
  const result = await renderCompose(f.run, f.recipe, f.env, f.output);
  const model = JSON.parse(readFileSync(join(f.output, "compose.json"), "utf8"));
  const caddy = readFileSync(join(f.output, "Caddyfile"), "utf8");
  expect(result.services).toEqual(["api", "devhub-preview"]);
  expect(result.serviceImages.api).toMatch(/^devhub-env-[a-f0-9]{12}-[a-f0-9]{12}:latest$/);
  expect(result.serviceImages["devhub-preview"]).toContain("caddy:2.11.9-alpine@sha256:");
  expect(model.services.api.labels["com.devhub.feature"]).toBe("demo-feature");
  expect(model.services.api.deploy.resources.limits).toEqual({ cpus: "1", memory: "512M" });
  expect(model.services["devhub-preview"].ports).toEqual([{ target: 8080, host_ip: "127.0.0.1", protocol: "tcp" }]);
  expect(result.networks).toHaveLength(1);
  expect(Object.keys(model.services["devhub-preview"].networks)).toEqual(["default"]);
  expect(model.services.api.networks.default.aliases).toHaveLength(2);
  expect(caddy).toContain("path /api /api/*");
  expect(caddy).toContain("reverse_proxy api-");
  expect(caddy.indexOf("handle /__devhub_health")).toBeLessThan(caddy.indexOf("handle @route_"));
  expect(caddy).toContain("respond 200");
  expect(caddy).toContain("handle {");
  expect(f.commands[0]).toContain("--env-file");
  expect(f.commands[0]!.some((arg) => arg.endsWith("/compose.vars"))).toBe(true);
  expect(f.commands.at(-1)).toContain("/dev/null");
  expect(readFileSync(join(f.output, "compose.vars"), "utf8")).toContain("DEVHUB_REPO_APP='");
  expect(model.services.api.ports).toBeUndefined();
  expect(verifyComposePaths(f.env, f.output)).toBe(result.fingerprint);
});

test("keeps env_file and secret contents out of the persisted Compose files", async () => {
  const f = fixture();
  f.env.id = `ef-${"a".repeat(32)}`;
  f.env.composeProject = `devhub-${f.env.id}`;
  const stateDir = join(f.root, "state"), infraDir = join(f.root, "infra");
  const output = join(stateDir, "feature-environments", f.env.id);
  const envFile = join(f.repo, "service.env"), secretFile = join(f.root, "service-secret");
  const sentinel = "fixture-credential-sentinel";
  const secretSentinel = "fixture-secret-file-sentinel";
  writeFileSync(envFile, `API_TOKEN=${sentinel}\n`);
  writeFileSync(secretFile, secretSentinel);
  writeFileSync(join(f.repo, "compose.yml"), "services:\n  api:\n    build: ./app\n    env_file: ${SERVICE_ENV:-service.env}\n");
  f.recipe.compose.secretFiles.SERVICE_SECRET = secretFile;
  f.model.services.api.env_file = [{ path: envFile, required: true }];
  f.model.services.api.environment = { APP_MODE: "test" };
  f.model.services.api.secrets = [{ source: "service_secret" }];
  f.model.secrets = { service_secret: { file: secretFile } };
  const run: Executor = async (argv) => {
    const result = await f.run(argv);
    const model = JSON.parse(result.stdout);
    const override = argv[argv.lastIndexOf("-f") + 1]!;
    if (argv.includes("--no-interpolate")) {
      model.services.api.env_file = [{ path: "${SERVICE_ENV:-service.env}", required: true }];
    } else if (override.endsWith("env-files.yml")) {
      const yaml = readFileSync(override, "utf8");
      expect(yaml).toContain("env_file: !reset []");
      expect(yaml.includes(sentinel)).toBe(false);
      model["x-devhub-env-files"] = { api: [{ path: "service.env", required: true }] };
      delete model.services.api.env_file;
    } else {
      // Some Compose releases still resolve env_file when only --no-env-resolution is set.
      const token = readFileSync(envFile, "utf8").trim().split("=")[1];
      model.services.api.environment.API_TOKEN = token;
      delete model.services.api.env_file;
    }
    return { ...result, stdout: JSON.stringify(model) };
  };

  const catalog = new Catalog({ stateDir, infraDir });
  try {
    const result = await renderCompose(run, f.recipe, f.env, output);
    const model = JSON.parse(readFileSync(join(output, "compose.json"), "utf8"));
    expect(model.services.api.environment).toEqual({ APP_MODE: "test" });
    expect(model.services.api.env_file).toEqual([{ path: envFile, required: true }]);
    expect(model.secrets.service_secret.file).toBe(secretFile);
    expect(verifyComposePaths(f.env, output)).toBe(result.fingerprint);

    f.recipe.steps.push({ id: "smoke", phase: "test", service: "api", argv: ["printenv", "API_TOKEN"] });
    catalog.putRecord("feature_environments", f.env.id, { ...f.env, observed: "ready", configuration: result, recipe: f.recipe });
    const environments = new Environments({ catalog, stateDir, infraDir, run: async (argv) => {
      const [command, action] = argv.slice(4);
      let stdout = "";
      if (command === "ps") stdout = "container-1\n";
      if (command === "container" && action === "inspect") {
        stdout = argv.includes("{{json .Config.Env}}") ? JSON.stringify([`API_TOKEN=${sentinel}`])
          : `container-1\t/api\tapi\trunning\t\tsha256:image\t${f.env.id}\t${f.env.composeProject}\n`;
      }
      if (command === "image" && action === "inspect") stdout = `sha256:image\t${f.env.id}\n`;
      if (command === "exec") stdout = `${sentinel}\n`;
      return { code: 0, stdout, stderr: "" };
    } });
    expect((await environments.test(f.env.id)).operation).toMatchObject({ state: "succeeded" });
    expect(readFileSync(join(output, "operations.log"), "utf8")).toContain("[redacted]");
    for (const file of readdirSync(output)) {
      const contents = readFileSync(join(output, file), "utf8");
      expect(contents.includes(sentinel) || contents.includes(secretSentinel)).toBe(false);
    }
  } finally {
    catalog.close();
  }
});

test("removes fixed names and host publications and rejects filesystem paths outside repositories", async () => {
  const fixed = fixture();
  fixed.model.services.api.container_name = "shared-api";
  fixed.model.services.api.ports = [{ target: 8080, published: "8080", host_ip: "0.0.0.0" }];
  await renderCompose(fixed.run, fixed.recipe, fixed.env, fixed.output);
  const fixedModel = JSON.parse(readFileSync(join(fixed.output, "compose.json"), "utf8"));
  expect(fixedModel.services.api.container_name).toBeUndefined();
  expect(fixedModel.services.api.ports).toBeUndefined();

  const path = fixture();
  const outside = mkdtempSync(join(tmpdir(), "devhub-env-outside-")); dirs.push(outside);
  path.model.services.api.volumes = [{ type: "bind", source: outside, target: "/outside" }];
  await expect(renderCompose(path.run, path.recipe, path.env, path.output)).rejects.toThrow("escapes the confirmed environment repositories");
});

test("rejects Compose include and extends before calling Docker", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, "compose.yml"), "include:\n  - other.yml\nservices:\n  api: {}\n");
  await expect(renderCompose(f.run, f.recipe, f.env, f.output)).rejects.toThrow("Compose include is not supported");
  expect(f.commands).toHaveLength(0);
});

test("uses enabled profile services when service selection is implicit and omits the gateway without routes", async () => {
  const f = fixture();
  f.recipe.compose.services = [];
  f.recipe.routes = [];
  f.model.services.hidden = { profiles: ["optional"], image: "alpine:3" };
  const result = await renderCompose(f.run, f.recipe, f.env, f.output);
  expect(result.services).toEqual(["api"]);
  expect(result.images).toEqual([result.serviceImages.api]);
  expect(result.serviceImages["devhub-preview"]).toBeUndefined();
  expect(readFileSync(join(f.output, "compose.json"), "utf8")).not.toContain("devhub-preview");
});

test("an approved Compose secret grants access to only that file", async () => {
  const f = fixture();
  const approved = join(f.root, "approved"), neighbor = join(f.root, "neighbor");
  writeFileSync(approved, "fixture");
  writeFileSync(neighbor, "fixture");
  f.recipe.compose.secretFiles.SECRET_SOURCE = approved;
  f.model.secrets = { configured: { file: approved } };
  await renderCompose(f.run, f.recipe, f.env, f.output);
  f.model.secrets.configured.file = neighbor;
  await expect(renderCompose(f.run, f.recipe, f.env, f.output)).rejects.toThrow("escapes the confirmed environment repositories");
  f.model.secrets.configured.file = approved;
  f.model.services.api.volumes = [{ type: "bind", source: approved, target: "/unapproved" }];
  await expect(renderCompose(f.run, f.recipe, f.env, f.output)).rejects.toThrow("escapes the confirmed environment repositories");
});

test("rejects a Compose-declared anonymous data volume", async () => {
  const f = fixture();
  f.model.services.api.volumes = [{ type: "volume", target: "/var/data" }];
  await expect(renderCompose(f.run, f.recipe, f.env, f.output)).rejects.toThrow("anonymous volume");
});
