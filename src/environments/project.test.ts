import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { CatalogPort, Executor, Project } from "../contracts";
import { projectNetwork } from "../services";
import { featureHost, prepareProject, projectRecipe, purgeProjectDatabase } from "./project";
import type { Environment, Recipe } from "./types";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devhub-env-project-")); dirs.push(root);
  const stateDir = join(root, "state"), infraDir = join(root, "infra"), parentRoot = join(root, "demo"), worktree = join(root, "worktrees", "app"), source = join(root, "model", "source");
  const imported = join(stateDir, "imports", "demo");
  for (const dir of [join(imported, "build"), parentRoot, worktree, join(root, "model")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(imported, "build", "entry.sh"), "exec \"$@\"\n");
  writeFileSync(join(imported, "build", "Dockerfile"), "FROM alpine:3\n");
  writeFileSync(join(imported, "app.env"), [
    "APP_URL=http://127.0.0.1:4101", "DEVHUB_DB_PASSWORD=parent-pass", "REDIS_PREFIX=demo:",
    "DATABASE_URL=postgresql://dh_demo:parent-pass@infra-postgres:5432/dh_demo?serverVersion=16", "",
  ].join("\n"));
  writeFileSync(join(imported, "compose.yml"), [
    "services:", "  app:", "    build:", `      context: ${join(imported, "build")}`, "    user: 1000:1000", "    env_file:", `      - ${join(imported, "app.env")}`,
    "    ports:", "      - 127.0.0.1:4101:3000", "    volumes:", `      - ${parentRoot}:/app`, "      - vendor:/app/vendor", `      - ${join(imported, "build", "entry.sh")}:/devhub/entry.sh:ro`,
    "    security_opt:", "      - no-new-privileges:true", "    healthcheck:", "      test: [CMD, true]", "      start_period: 300s", "volumes:", "  vendor: {}", "networks:", "  default:", `    name: ${projectNetwork("demo", ["infra-postgres"])}`, "    external: true", "",
  ].join("\n"));
  const project = {
    id: "demo", name: "Demo", root: parentRoot,
    components: [{ id: "app", name: "app", cwd: parentRoot, url: "http://127.0.0.1:4101", compose: { projectName: "devhub-demo", files: [], profiles: [], services: ["app"], managed: { infra: ["infra-postgres"] } } }],
  } as unknown as Project;
  const catalog = { getProject: () => project, listProjects: () => [project] } as unknown as CatalogPort;
  const commands: string[][] = [];
  const environments: (Record<string, string> | undefined)[] = [];
  let failCopy = false, existing = false;
  const run: Executor = async (argv, options) => {
    commands.push(argv);
    environments.push(options?.env);
    if (argv.includes("printenv")) return { code: 0, stdout: "postgres\n", stderr: "" };
    if (argv.some((arg) => arg.includes("pg_dump"))) return failCopy ? { code: 1, stdout: "", stderr: "disk full" } : { code: 0, stdout: "", stderr: "" };
    if (argv.includes("-tA")) return { code: 0, stdout: existing ? "1\n" : "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const recipe = projectRecipe(project, stateDir);
  const entry = {
    id: "ef-0123456789abcdef0123456789abcdef", slug: "checkout", recipe, bootstrap: {},
    repos: [{ name: "app", source: parentRoot, path: worktree, ref: "HEAD", sha: "a".repeat(40), branch: "devhub/x/app", attach: false, prepared: true }],
  } as unknown as Environment & { recipe: Recipe };
  const options = { catalog, run, stateDir, infraDir };
  return { root, parentRoot, worktree, source, imported, recipe, entry, options, commands, environments, setFailCopy: (value: boolean) => { failCopy = value; }, setExisting: (value: boolean) => { existing = value; } };
}

test("a DevHub project becomes a shared recipe routed to its app port on its project network", () => {
  const f = fixture();
  expect(f.recipe).toMatchObject({
    isolation: "shared", generated: { project: "demo" }, repositories: { app: { path: f.parentRoot, ref: "HEAD" } },
    routes: [{ path: "/", service: "app", port: 3000 }], shared: { networks: [projectNetwork("demo", ["infra-postgres"])], volumes: [] },
    // The project's health check allows 300 s for a first dependency install.
    readySeconds: 330,
  });
});

test("the feature source points at its worktree, its own env file and a private copy of the database", async () => {
  const f = fixture();
  await prepareProject(f.options, f.entry, f.source, () => {});
  const app = parse(readFileSync(join(f.source, "compose.yml"), "utf8")).services.app;
  expect(app.build.context).toBe(join(f.source, "build"));
  expect(app.env_file).toEqual([join(f.source, "app.env")]);
  expect(app.ports).toBeUndefined();
  expect(app.volumes).toEqual([`${f.worktree}:/app`, "vendor:/app/vendor", `${join(f.source, "build", "entry.sh")}:/devhub/entry.sh:ro`]);
  const env = readFileSync(join(f.source, "app.env"), "utf8");
  const database = "dh_ef_0123456789abcdef0123456789abcdef";
  expect(f.entry.database).toBe(database);
  expect(env).toContain(`APP_URL=http://${featureHost(f.entry, "demo")}`);
  expect(env).toContain(`REDIS_PREFIX=${f.entry.id}:`);
  expect(env).toMatch(new RegExp(`DATABASE_URL=postgresql://${database}:[0-9a-f]{48}@infra-postgres:5432/${database}\\?`));
  expect(env).not.toContain("parent-pass");
  expect(f.entry.bootstrap["database-copy"]).toBe("done");
  expect(f.commands.some((argv) => argv.includes("connect") && argv.includes("infra-postgres"))).toBe(true);
  expect(f.commands.find((argv) => argv.some((arg) => arg.includes("pg_dump")))?.slice(-3)).toEqual(["postgres", "dh_demo", database]);
  // The provisioning script runs docker itself: it must reach the same local Engine as the feature.
  const provision = f.commands.findIndex((argv) => argv.includes("provision"));
  expect(f.environments[provision]).toEqual({ DOCKER_HOST: "unix:///var/run/docker.sock" });
});

test("a copy cut short is dropped and made again, a foreign database is never taken over", async () => {
  const f = fixture();
  f.setFailCopy(true);
  await expect(prepareProject(f.options, f.entry, f.source, () => {})).rejects.toThrow("Copying dh_demo");
  expect(f.entry.bootstrap["database-copy"]).toBe("failed");
  f.setFailCopy(false);
  f.setExisting(true);
  await prepareProject(f.options, f.entry, f.source, () => {});
  expect(f.commands.some((argv) => argv.some((arg) => arg.startsWith("DROP DATABASE IF EXISTS \"dh_ef_")))).toBe(true);
  expect(f.entry.bootstrap["database-copy"]).toBe("done");

  const other = fixture();
  other.setExisting(true);
  await expect(prepareProject(other.options, other.entry, other.source, () => {})).rejects.toThrow("DevHub does not take it over");
  expect(other.commands.some((argv) => argv.some((arg) => arg.includes("pg_dump")))).toBe(false);
  // The refused name was recorded but never ours: a purge leaves it alone.
  await purgeProjectDatabase(other.options, other.entry, other.source);
  expect(other.commands.some((argv) => argv.some((arg) => arg.startsWith("DROP DATABASE")))).toBe(false);
});

test("a half-written source from an interrupted run is written again", async () => {
  const f = fixture();
  mkdirSync(f.source, { recursive: true });
  writeFileSync(join(f.source, "compose.yml.tmp"), "services:\n  app:\n    bui");
  await prepareProject(f.options, f.entry, f.source, () => {});
  expect(parse(readFileSync(join(f.source, "compose.yml"), "utf8")).services.app.env_file).toEqual([join(f.source, "app.env")]);
});

test("the app URL keeps the port of a proxy that does not listen on 80", async () => {
  const f = fixture();
  process.env.DEVHUB_FEATURE_PROXY_PORT = "8080";
  try {
    await prepareProject(f.options, f.entry, f.source, () => {});
  } finally { delete process.env.DEVHUB_FEATURE_PROXY_PORT; }
  expect(readFileSync(join(f.source, "app.env"), "utf8")).toContain(`APP_URL=http://${featureHost(f.entry, "demo")}:8080\n`);
});
