import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../catalog";
import type { Executor } from "../contracts";
import { emptyResources } from "./docker";
import { Environments } from "./index";
import { featureLock } from "./lock";
import type { Environment, Recipe } from "./types";

const id = "ef-0123456789abcdef0123456789abcdef";
const composeProject = `devhub-${id}`;
const activeAt = "2026-01-01T00:00:00.000Z";

function fixture(run: Executor, overrides: Partial<Environment> = {}) {
  const root = mkdtempSync(join(tmpdir(), "devhub-env-lifecycle-"));
  const stateDir = join(root, "state"), infraDir = join(root, "infra");
  const catalog = new Catalog({ stateDir, infraDir });
  const recipe: Recipe = {
    version: 1, repositories: {},
    compose: { repository: "app", files: [], profiles: [], services: ["api"], vars: {}, secretFiles: {} },
    routes: [], steps: [], shared: { networks: [], volumes: [] }, isolation: "shared", capabilities: {}, internet: [],
    resources: { cpus: 1, memoryMiB: 512 }, idleMinutes: 30, localFiles: [],
  };
  const hash = (input: string) => createHash("sha256").update(input).digest("hex");
  const entry = {
    id, composeProject, project: "demo", feature: "checkout", slug: "checkout", host: "local", provider: "docker-compose",
    activeAt, createdAt: activeAt, idleMinutes: 30, desired: "running", observed: "ready", repos: [], bootstrap: {},
    resources: emptyResources(), recipe, worktreeRoot: join(root, "worktrees"), copied: [], checksPassed: true,
    keyHash: hash("checkout-1"), requestHash: hash(JSON.stringify({ project: "demo", feature: "checkout", refs: {}, branches: {}, build: false })),
    ...overrides,
  };
  catalog.putRecord("feature_environments", id, entry);
  const environments = new Environments({ catalog, run, stateDir, infraDir });
  return { catalog, entry, environments, stateDir, close() { catalog.close(); rmSync(root, { recursive: true, force: true }); } };
}

test.each([
  { name: "keeps DEBUG=1 visible in operation logs and exec output", variable: "DEBUG=1", output: "debug level 1 enabled", expected: "debug level 1 enabled" },
  { name: "withholds streams containing a three-character DB_PASS", variable: "DB_PASS=7zQ", output: "prefix7zQsuffix", expected: "[redacted]" },
  { name: "redacts long env_file values under ordinary names", variable: "DISPLAY_NAME=app.v2", output: "version app.v2, fallback app-v2", expected: "version [redacted], fallback app-v2" },
  { name: "redacts env_file values overridden by Compose", variable: "DISPLAY_NAME=public-value", fileVariable: '\n# Fixture\nexport DISPLAY_NAME="private-value"', environment: { DISPLAY_NAME: "public-value" }, output: "private-value and public-value", expected: "[redacted] and [redacted]" },
  { name: "redacts long DB_PASS values", variable: "DB_PASS=fixture-db-value", output: "db fixture-db-value", expected: "db [redacted]" },
])("$name", async ({ variable, fileVariable = variable, environment, output, expected }) => {
  const fileSecret = "fixture-mounted-value";
  const f = fixture(async (argv) => {
    const [command, action] = argv.slice(4);
    if (command === "ps") return { code: 0, stdout: "container-1\n", stderr: "" };
    if (command === "container" && action === "inspect") {
      const stdout = argv.includes("{{json .Config.Env}}")
        ? JSON.stringify([variable])
        : `container-1\t/api\tapi\trunning\t\tsha256:image\t${id}\t${composeProject}\n`;
      return { code: 0, stdout, stderr: "" };
    }
    if (command === "exec") return { code: 0, stdout: `file ${fileSecret}\n`, stderr: output };
    return { code: 0, stdout: "", stderr: "" };
  }, { configuration: { fingerprint: "fixture", services: ["api"], volumes: [], networks: [], images: [], serviceImages: {} } });

  try {
    const model = join(f.stateDir, "feature-environments", id);
    mkdirSync(model, { recursive: true });
    const envFile = join(model, "service.env"), secretFile = join(model, "service-secret");
    writeFileSync(envFile, fileVariable + "\n");
    writeFileSync(secretFile, fileSecret + "\n");
    writeFileSync(join(model, "compose.json"), JSON.stringify({ services: { api: { env_file: [{ path: envFile }], environment } } }));
    f.entry.recipe.compose.secretFiles.SERVICE_SECRET = secretFile;
    f.entry.recipe.steps.push({ id: "smoke", phase: "test", service: "api", argv: ["show-fixture-values"] });
    f.catalog.putRecord("feature_environments", id, f.entry);

    expect((await f.environments.test(id)).operation?.state).toBe("succeeded");
    const log = readFileSync(join(model, "operations.log"), "utf8");
    const result = await f.environments.exec(id, "api", ["show-fixture-values"]);
    expect(result.stdout).toBe("file [redacted]\n");
    expect(result.stderr).toBe(expected);
    expect(log).toContain(`file [redacted]\n\n${expected}\n`);
    expect(log).not.toContain(fileSecret);
    if (output !== expected) expect(log).not.toContain(variable.slice(variable.indexOf("=") + 1));
  } finally { f.close(); }
});

test("reconcile retries a failed idle stop and records its success", async () => {
  let state = "running", stops = 0;
  const f = fixture(async (argv) => {
    const [command, action] = argv.slice(4);
    let code = 0, stdout = "";
    if (command === "ps") stdout = "container-1\n";
    if (command === "container" && action === "inspect") stdout = `container-1\t/api\tapi\t${state}\t\tsha256:image\t${id}\t${composeProject}\n`;
    if (command === "stop") {
      if (++stops === 1) code = 1;
      else state = "exited";
    }
    return { code, stdout, stderr: "" };
  }, { configuration: { fingerprint: "fixture", services: ["api"], volumes: [], networks: [], images: [], serviceImages: {} } });

  try {
    const time = Date.parse(activeAt) + 31 * 60_000;
    const [failed] = await f.environments.reconcile(time);
    expect(failed).toMatchObject({ desired: "stopped", operation: { action: "stop", state: "failed", error: { code: "docker_stop" } } });
    const [retried] = await f.environments.reconcile(time + 120_000);
    expect(retried).toMatchObject({ desired: "stopped", observed: "stopped", operation: { action: "stop", state: "succeeded" }, resources: { containers: [{ state: "exited" }] } });
    await f.environments.reconcile(time);
    expect(stops).toBe(2);
  } finally { f.close(); }
});

test("reconcile backs off and reports a permanent idle stop failure after three attempts", async () => {
  let stops = 0;
  const f = fixture(async (argv) => {
    const [command, action] = argv.slice(4);
    if (command === "ps") return { code: 0, stdout: "container-1\n", stderr: "" };
    if (command === "container" && action === "inspect") {
      return { code: 0, stdout: `container-1\t/api\tapi\trunning\t\tsha256:image\t${id}\t${composeProject}\n`, stderr: "" };
    }
    if (command === "stop") {
      stops++;
      return { code: 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }, { configuration: { fingerprint: "fixture", services: ["api"], volumes: [], networks: [], images: [], serviceImages: {} } });

  try {
    const minute = 60_000;
    const time = Date.parse(activeAt) + 31 * minute;
    for (const [elapsed, expectedStops] of [[0, 1], [1, 1], [2, 2], [3, 2], [5, 2], [6, 3], [7, 3], [60, 3]] as const) {
      await f.environments.reconcile(time + elapsed * minute);
      expect(stops).toBe(expectedStops);
    }
    expect(await f.environments.status(id)).toMatchObject({
      desired: "stopped", observed: "error",
      operation: { action: "stop", state: "failed", error: { code: "docker_stop" } },
      observationError: { code: "stop_retry_exhausted" },
    });
    expect((await f.environments.doctor()).checks).toContainEqual({
      name: "stop:" + id, ok: false, detail: "Automatic stop failed after 3 attempts. Retry stop manually.",
    });
  } finally { f.close(); }
});

test("reconcile retries an interrupted third idle stop attempt", async () => {
  let state = "running", stops = 0;
  let interrupted: Environment | undefined;
  const f = fixture(async (argv) => {
    const [command, action] = argv.slice(4);
    if (command === "ps") return { code: 0, stdout: "container-1\n", stderr: "" };
    if (command === "container" && action === "inspect") {
      return { code: 0, stdout: `container-1\t/api\tapi\t${state}\t\tsha256:image\t${id}\t${composeProject}\n`, stderr: "" };
    }
    if (command === "stop") {
      if (stops === 2 && !interrupted) {
        interrupted = f.catalog.getRecord<Environment>("feature_environments", id);
        throw new Error("Simulated interruption before Docker stops the container");
      }
      if (++stops < 3) return { code: 1, stdout: "", stderr: "" };
      state = "exited";
    }
    return { code: 0, stdout: "", stderr: "" };
  }, { configuration: { fingerprint: "fixture", services: ["api"], volumes: [], networks: [], images: [], serviceImages: {} } });

  try {
    const minute = 60_000;
    const time = Date.parse(activeAt) + 31 * minute;
    await f.environments.reconcile(time);
    await f.environments.reconcile(time + 2 * minute);
    await f.environments.reconcile(time + 6 * minute);
    expect(stops).toBe(2);
    expect(interrupted).toMatchObject({ desired: "stopped", operation: { action: "stop", state: "running" } });
    // Restore the last durable record before the stop so the catch path's writes are discarded.
    f.catalog.putRecord("feature_environments", id, interrupted);

    const [retried] = await f.environments.reconcile(time + 6 * minute);
    expect(stops).toBe(3);
    expect(retried).toMatchObject({ observed: "stopped", operation: { state: "succeeded" } });
    expect(retried?.observationError).toBeUndefined();
  } finally { f.close(); }
});

test("create retry reports an interrupted allocation once its environment lock is free", async () => {
  const f = fixture(async () => ({ code: 0, stdout: "", stderr: "" }), { observed: "creating" });
  const input = { project: "demo", feature: "checkout", idempotencyKey: "checkout-1" };
  try {
    await featureLock(join(f.stateDir, "feature-locks"), id, async () => {
      expect(await f.environments.create(input)).toMatchObject({ id, observed: "creating" });
    });
    const interrupted = await f.environments.create(input);
    expect(interrupted).toMatchObject({ id, observed: "error", operation: { action: "create", state: "interrupted", step: "allocation" } });
    expect(f.environments.list()).toEqual([interrupted]);
  } finally { f.close(); }
});
