import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
    routes: [], steps: [], shared: { networks: [], volumes: [] },
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
  return { environments, stateDir, close() { catalog.close(); rmSync(root, { recursive: true, force: true }); } };
}

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
    const [retried] = await f.environments.reconcile(time);
    expect(retried).toMatchObject({ desired: "stopped", observed: "stopped", operation: { action: "stop", state: "succeeded" }, resources: { containers: [{ state: "exited" }] } });
    await f.environments.reconcile(time);
    expect(stops).toBe(2);
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
