import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogPort, Component, ContainerInfo, ExecOptions, Operation, Project, RuntimePort } from "../contracts";
import { publicChange } from "../public";
import { execCommand } from "../runtime/executor";
import { gitRun } from "../git";

import { Maintenance } from "./index";

const dirs: string[] = [];
const BASE = "sha256:" + "a".repeat(64);
const CANDIDATE = "sha256:" + "b".repeat(64);
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "devhub-security-")); dirs.push(temp);
  const root = join(temp, "project"); const state = join(temp, "state"); mkdirSync(root); mkdirSync(state); chmodSync(state, 0o700);
  writeFileSync(join(root, "Dockerfile"), "FROM alpine:3.20\nCMD [\"true\"]\n");
  writeFileSync(join(root, "compose.yaml"), "services:\n  app:\n    image: local/app:v1\n    build:\n      context: .\n      dockerfile: Dockerfile\n");
  const component: Component = { id: "app", name: "App", kind: "compose", cwd: root, compose: { files: ["compose.yaml"], projectName: "fixture-app", profiles: [], services: ["app"] }, dependsOn: [], sources: [{ file: "Dockerfile", service: "app" }], validation: { argv: ["/bin/true"] } };
  const project: Project = { id: "fixture", name: "Fixture", root, createdAt: new Date(0).toISOString(), components: [component] };
  const records = new Map<string, Map<string, unknown>>(); const operations = new Map<string, Operation>();
  const catalog = {
    assertAllowedPath: (path: string) => path,
    getProject: () => project,
    claimOperation: (projectId: string, action: "check", componentIds: string[]) => {
      const operation: Operation = { id: crypto.randomUUID(), projectId, action, componentIds, state: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      operations.set(operation.id, operation); return { operation, acquired: true };
    },
    updateOperation: (id: string, patch: Partial<Pick<Operation, "state" | "error">>) => { const op = { ...operations.get(id)!, ...patch }; operations.set(id, op); return op; },
    putRecord: <T>(namespace: string, id: string, value: T) => { const bucket = records.get(namespace) ?? new Map(); bucket.set(id, structuredClone(value)); records.set(namespace, bucket); },
    getRecord: <T>(namespace: string, id: string) => records.get(namespace)?.get(id) as T | undefined,
    deleteRecord: (namespace: string, id: string) => { records.get(namespace)?.delete(id); },
    listRecords: <T>(namespace: string) => [...(records.get(namespace)?.values() ?? [])] as T[],
  } as unknown as CatalogPort;
  let activated = false;
  const runtime = {
    inventory: async () => [{ id: activated ? "c".repeat(64) : "d".repeat(64), name: "app", imageId: activated ? CANDIDATE : BASE, image: "local/app:v1", state: "running", projectId: "fixture", componentId: "app", ports: [] } satisfies ContainerInfo],
  } as unknown as RuntimePort;
  const calls: string[][] = [];
  const run = async (argv: string[], options?: ExecOptions) => {
    calls.push(argv);
    if (argv[0] === "git") return execCommand(argv, options);
    const joined = argv.join(" ");
    if (joined.includes("context inspect")) return { code: 0, stdout: JSON.stringify({ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }), stderr: "" };
    if (argv[0] === "trivy" && argv[1] === "--version") return { code: 0, stdout: "Version: 0.60.0\n", stderr: "" };
    if (argv[0] === "trivy") return { code: 0, stdout: JSON.stringify({ ArtifactID: argv.at(-1), Metadata: { UpdatedAt: "2026-10-01T00:00:00Z" }, Results: [{ Target: "alpine", Vulnerabilities: [] }] }), stderr: "" };
    if (joined.includes("compose") && joined.includes(" config ")) { const yaml = readFileSync(join(root, "compose.yaml"), "utf8"); const image = yaml.includes("local/app:v2") ? "local/app:v2" : "local/app:v1"; const app = { image, ...(yaml.includes("build:") ? { build: { context: ".", dockerfile: "Dockerfile" } } : {}) }; return { code: 0, stdout: JSON.stringify({ services: { app } }), stderr: "" }; }
    if (argv[0] === "docker" && argv[1] === "image" && argv.includes("inspect")) return { code: 0, stdout: argv.at(-1) === "local/app:v1" || argv.at(-1) === BASE ? BASE : CANDIDATE, stderr: "" };
    if (argv[0] === "docker" && argv[1] === "build") return { code: 0, stdout: "built", stderr: "" };
    if (argv[0] === "docker" && argv[1] === "run") return { code: 0, stdout: "ok", stderr: "" };
    if (joined.includes("compose") && joined.includes(" up ")) { activated = true; return { code: 0, stdout: "", stderr: "" }; }
    if (joined.includes("compose") && joined.includes(" ps -q ")) return { code: 0, stdout: `${"c".repeat(64)}\n`, stderr: "" };
    if (argv[0] === "docker" && argv[1] === "inspect") return { code: 0, stdout: JSON.stringify([{ Image: CANDIDATE, Mounts: [] }]), stderr: "" };
    throw new Error(`Unexpected injected command: ${joined}`);
  };
  const maintenance = new Maintenance({ catalog, runtime, run, stateDir: state });
  return { temp, root, state, catalog, project, component, records, operations, maintenance, run, calls };
}
async function initGit(f: ReturnType<typeof fixture>) {
  expect((await gitRun(execCommand, ["-C", f.root, "init"])).code).toBe(0);
  expect((await gitRun(execCommand, ["-C", f.root, "config", "user.name", "Fixture"])).code).toBe(0);
  expect((await gitRun(execCommand, ["-C", f.root, "config", "user.email", "fixture@example.invalid"])).code).toBe(0);
  expect((await gitRun(execCommand, ["-C", f.root, "add", "Dockerfile", "compose.yaml"])).code).toBe(0);
  expect((await gitRun(execCommand, ["-C", f.root, "commit", "-m", "fixture"])).code).toBe(0);
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("scanner failure is recorded as failed without inventing findings", async () => {
  const f = fixture();
  const run = async (argv: string[]) => argv[0] === "docker" && argv[1] === "context" ? { code: 0, stdout: JSON.stringify({ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }), stderr: "" } : argv[0] === "docker" ? { code: 0, stdout: BASE, stderr: "" } : argv[1] === "--version" ? { code: 0, stdout: "Trivy 0.60", stderr: "" } : { code: 2, stdout: "", stderr: "db unavailable" };
  const m = new Maintenance({ catalog: f.catalog, runtime: {} as RuntimePort, run, stateDir: f.state });
  const scan = await m.scan(BASE);
  expect(scan).toMatchObject({ state: "failed", imageId: BASE, findings: [] });
  expect(m.getScan(scan.id)).toEqual(scan);
});

test("missing scanner, malformed JSON and remote Docker context remain explicit failures", async () => {
  const f = fixture();
  const makeRunner = (mode: "missing" | "invalid" | "remote") => async (argv: string[]) => {
    if (argv[0] === "docker" && argv[1] === "context") return { code: 0, stdout: JSON.stringify({ Endpoints: { docker: { Host: mode === "remote" ? "tcp://docker.example:2376" : "unix:///var/run/docker.sock" } } }), stderr: "" };
    if (argv[0] === "docker") return { code: 0, stdout: BASE, stderr: "" };
    if (argv[1] === "--version") return mode === "missing" ? { code: 127, stdout: "", stderr: "missing" } : { code: 0, stdout: "Trivy 0.60", stderr: "" };
    return mode === "invalid" ? { code: 0, stdout: "{invalid", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  };
  for (const mode of ["missing", "invalid", "remote"] as const) {
    const service = new Maintenance({ catalog: f.catalog, runtime: {} as RuntimePort, run: makeRunner(mode), stateDir: f.state });
    const scan = await service.scan(BASE);
    expect(scan.state).toBe("failed");
    expect(scan.findings).toEqual([]);
  }
});

test("Compose preview edits only the mapped service image scalar", async () => {
  const f = fixture();
  f.component.sources = [{ file: "compose.yaml", service: "app" }];
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "compose.yaml", service: "app", replacement: "local/app:v2" });
  expect(change.proposed).toContain("image: local/app:v2");
  expect(change.proposed).toContain("Dockerfile");
  expect(publicChange(change).changedLine).toMatchObject({ before: "local/app:v1", after: "local/app:v2" });
});

test("preview refuses database major changes and escaped source paths", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "Dockerfile"), "FROM postgres:15\n");
  await expect(f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "postgres:16" })).rejects.toThrow("Database major-version");
  await expect(f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "../../etc/passwd", service: "app", replacement: "alpine:3.21" })).rejects.toThrow();
});

test("apply refuses stale or dirty sources and restores branch, HEAD and bytes on write failure", async () => {
  const stale = fixture(); const staleChange = await stale.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "alpine:3.21" });
  writeFileSync(join(stale.root, "Dockerfile"), "FROM alpine:3.22\n");
  await expect(stale.maintenance.apply(staleChange.id)).rejects.toThrow("Source changed");

  const dirty = fixture(); await initGit(dirty);
  const dirtyChange = await dirty.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "alpine:3.21" });
  writeFileSync(join(dirty.root, "compose.yaml"), `${readFileSync(join(dirty.root, "compose.yaml"), "utf8")}# dirty\n`);
  await expect(dirty.maintenance.apply(dirtyChange.id)).rejects.toThrow("Tracked Git changes");

  const rollback = fixture(); await initGit(rollback);
  const rollbackChange = await rollback.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "alpine:3.21" });
  const headBefore = (await gitRun(execCommand, ["-C", rollback.root, "rev-parse", "HEAD"])).stdout.trim();
  const originalPut = rollback.catalog.putRecord.bind(rollback.catalog);
  (rollback.catalog as any).putRecord = (namespace: string, id: string, value: any) => { if (namespace === "security-changes" && value.state === "applied") throw new Error("injected persistence failure"); return originalPut(namespace, id, value); };
  await expect(rollback.maintenance.apply(rollbackChange.id)).rejects.toThrow("injected persistence failure");
  expect(readFileSync(join(rollback.root, "Dockerfile"), "utf8")).toBe("FROM alpine:3.20\nCMD [\"true\"]\n");
  expect((await gitRun(execCommand, ["-C", rollback.root, "rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
  expect((await gitRun(execCommand, ["-C", rollback.root, "symbolic-ref", "--short", "HEAD"])).stdout.trim()).not.toContain("maintenance");
  expect((await gitRun(execCommand, ["-C", rollback.root, "status", "--porcelain"])).stdout.trim()).toBe("");
});

test("maintenance respects active project operations and branch collisions", async () => {
  const locked = fixture();
  (locked.catalog as any).claimOperation = () => ({ acquired: false, operation: { id: "active" } });
  await expect(locked.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "alpine:3.21" })).rejects.toThrow("Another project operation");

  const f = fixture(); await initGit(f);
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "alpine:3.21" });
  const branch = `devhub/maintenance-${change.id}`;
  expect((await gitRun(execCommand, ["-C", f.root, "branch", branch])).code).toBe(0);
  await expect(f.maintenance.apply(change.id)).rejects.toThrow("branch already exists");
});

test("preview, apply, validate and activate use isolated candidate evidence", async () => {
  const f = fixture();
  await initGit(f);
  const baseline = await f.maintenance.scan(BASE);
  if (baseline.state !== "succeeded") throw new Error(baseline.error);
  expect(baseline.state).toBe("succeeded");
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", replacement: "alpine:3.21", service: "app" });
  expect(publicChange(change).changedLine).toMatchObject({ before: "alpine:3.20", after: "alpine:3.21" });
  const applied = await f.maintenance.apply(change.id);
  expect(applied.state).toBe("applied");
  expect(readFileSync(join(f.root, "Dockerfile"), "utf8")).toContain("FROM alpine:3.21");
  const validated = await f.maintenance.validate(change.id);
  expect(validated).toMatchObject({ state: "validated", imageId: CANDIDATE, evidence: { checksPassed: true, candidateImageId: CANDIDATE, findingsImproved: false } });
  const active = await f.maintenance.activate(change.id);
  expect(active.state).toBe("activated");
  const runCalls = f.calls.filter((argv) => argv[0] === "docker" && argv[1] === "run");
  expect(runCalls[0]).toContain("--rm"); expect(runCalls[0]).toContain("--network"); expect(runCalls[0]).toContain("none");
  expect(runCalls[0]!.some((arg) => arg === "-v" || arg === "--volume" || arg === "--mount")).toBe(false);
  const up = f.calls.find((argv) => argv.includes("up"));
  expect(up).toContain("--no-build"); expect(up).toContain("--no-deps"); expect(up).toContain("app");
  expect(up).not.toContain("down"); expect(up).not.toContain("rm");
});

test("Compose image replacement is validated before exact candidate activation", async () => {
  const f = fixture();
  f.component.sources = [{ file: "compose.yaml", service: "app" }];
  writeFileSync(join(f.root, "compose.yaml"), "services:\n  app:\n    image: local/app:v1\n");
  await initGit(f);
  await f.maintenance.scan(BASE);
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "compose.yaml", service: "app", replacement: "local/app:v2" });
  await f.maintenance.apply(change.id);
  const validated = await f.maintenance.validate(change.id);
  expect(validated.evidence?.candidateImageId).toBe(CANDIDATE);
  expect(f.calls.some((argv) => argv[0] === "docker" && argv[1] === "build")).toBe(false);
  expect((await f.maintenance.activate(change.id)).state).toBe("activated");
});

test("preview edits a named Dockerfile stage and keeps its AS suffix", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "Dockerfile"), "FROM alpine:3.20 AS builder\nRUN true\nFROM busybox:1.36\n");
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", stage: "builder", replacement: "alpine:3.21" });
  expect(change.proposed).toBe("FROM alpine:3.21 AS builder\nRUN true\nFROM busybox:1.36\n");
  expect(publicChange(change).changedLine).toMatchObject({ line: 1, before: "alpine:3.20", after: "alpine:3.21" });
});
