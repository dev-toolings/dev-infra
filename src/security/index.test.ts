import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { Catalog } from "../catalog";
import type { CatalogPort, Component, ContainerInfo, ExecOptions, Executor, Operation, Project, RuntimePort } from "../contracts";
import { publicChange } from "../public";
import { Runtime } from "../runtime";
import { execCommand } from "../runtime/executor";
import { gitRun } from "../git";

import { Maintenance } from "./index";
import { approvedOverride, overrideContent, overrideFile, retireOverrides } from "./override";

const dirs: string[] = [];
const catalogs: Catalog[] = [];
const BASE = "sha256:" + "a".repeat(64);
const CANDIDATE = "sha256:" + "b".repeat(64);
const THIRD = "sha256:" + "e".repeat(64);
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
afterEach(() => { for (const catalog of catalogs.splice(0)) catalog.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

test("preview selects a dotted Dockerfile stage name", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "Dockerfile"), "FROM alpine:3.20 AS build.prod\nFROM busybox:1.36\n");
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", stage: "build.prod", replacement: "alpine:3.21" });
  expect(change.proposed).toBe("FROM alpine:3.21 AS build.prod\nFROM busybox:1.36\n");
});

/** Real Catalog and Runtime; only the Docker CLI is simulated, including the config_files label Compose writes. */
async function registered(compose = "services:\n  app:\n    image: local/app:v1\n", sources: Component["sources"] = [{ file: "compose.yaml", service: "app" }]) {
  const temp = mkdtempSync(join(tmpdir(), "devhub-registered-")); dirs.push(temp);
  const roots = join(temp, "roots"), root = join(roots, "project"), state = join(temp, "state"), infra = join(temp, "infra");
  mkdirSync(root, { recursive: true }); mkdirSync(infra);
  writeFileSync(join(root, "Dockerfile"), "FROM alpine:3.20\n"); writeFileSync(join(root, "compose.yaml"), compose);
  const catalog = new Catalog({ stateDir: state, infraDir: infra }); catalogs.push(catalog); catalog.addRoot(roots, "Fixtures");
  const project = catalog.createProject({ id: "fixture", name: "Fixture", root, components: [{ id: "app", name: "App", kind: "compose", cwd: root, compose: { files: ["compose.yaml"], projectName: "fixture-app", profiles: [], services: ["app"] }, dependsOn: [], sources, validation: { argv: ["/bin/true"] } }] });
  const composeFile = join(root, "compose.yaml"), images = new Map([["local/app:v1", BASE], ["local/app:v2", CANDIDATE], ["local/app:v2-rebuilt", CANDIDATE], ["local/app:v3", THIRD]]);
  const docker = { upFails: false, containers: [{ id: "d".repeat(64), image: BASE, service: "app", files: [composeFile] }] };
  const labels = (item: typeof docker.containers[number]) => ({ "com.docker.compose.project": "fixture-app", "com.docker.compose.service": item.service, "com.docker.compose.project.working_dir": root, "com.docker.compose.project.config_files": item.files.join(",") });
  const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
  const run: Executor = async (argv, options) => {
    if (argv[0] === "git") return execCommand(argv, options);
    if (argv[0] === "trivy") return argv[1] === "--version" ? ok("Version: 0.60.0") : ok({ ArtifactID: argv.at(-1), Results: [] });
    if (argv[1] === "context") return ok({ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } });
    if (argv[1] === "image") { const target = argv.at(-1)!; return ok(images.get(target) ?? target); }
    if (argv[1] === "run") return ok("ok");
    if (argv[1] === "ps") return ok(docker.containers.map((item) => ({ ID: item.id, Names: "app", Image: item.image, State: "running" })));
    if (argv[1] === "stats") return ok("");
    if (argv[1] === "inspect") return ok(docker.containers.filter((item) => argv.includes(item.id)).map((item) => ({ Id: item.id, Image: item.image, State: { Status: "running" }, Config: { Labels: labels(item) }, Mounts: [{ Type: "volume", Name: "fixture_data", Destination: "/data" }] })));
    if (argv[1] === "compose" && argv.includes("config")) return ok(parse(readFileSync(composeFile, "utf8")));
    if (argv[1] === "compose" && argv.includes("-q")) return ok(docker.containers.map((item) => item.id).join("\n"));
    if (argv[1] === "compose" && argv.includes("ps")) return ok(docker.containers.map((item) => ({ ID: item.id, State: "running", Labels: labels(item) })));
    if (argv[1] === "compose" && argv.includes("stop")) return ok("");
    if (argv[1] === "compose" && argv.includes("up")) {
      if (docker.upFails) return { code: 1, stdout: "", stderr: "up failed" };
      const files = argv.flatMap((arg, index) => arg.startsWith("--file=") ? [arg.slice(7)] : arg === "--file" ? [argv[index + 1]!] : []);
      const image = /image: (\S+)/.exec(readFileSync(files.at(-1)!, "utf8"))![1]!;
      docker.containers = [{ id: image.slice(7), image, service: "app", files }];
      return ok("");
    }
    throw new Error(`Unexpected injected command: ${argv.join(" ")}`);
  };
  const runtime = new Runtime({ run, stateDir: state, assertAllowedPath: catalog.assertAllowedPath.bind(catalog) });
  const maintenance = new Maintenance({ catalog, runtime, run, stateDir: state });
  for (const args of [["init"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "Dockerfile", "compose.yaml"], ["commit", "-m", "fixture"]]) expect((await gitRun(execCommand, ["-C", root, ...args])).code).toBe(0);
  const remediate = async (replacement: string) => {
    const change = await maintenance.preview({ projectId: "fixture", componentId: "app", file: "compose.yaml", service: "app", replacement });
    await maintenance.apply(change.id); return maintenance.validate(change.id);
  };
  const commit = async () => expect((await gitRun(execCommand, ["-C", root, "commit", "-am", "remediation"])).code).toBe(0);
  return { root, state, catalog, project, component: project.components[0]!, runtime, maintenance, docker, composeFile, remediate, commit };
}

test("a real catalog stores a preview that maps no Dockerfile stage", async () => {
  const f = await registered("services:\n  app:\n    build: .\n", [{ file: "Dockerfile", service: "app" }]);
  const change = await f.maintenance.preview({ projectId: "fixture", componentId: "app", file: "Dockerfile", service: "app", replacement: "alpine:3.21" });
  expect(change.state).toBe("preview");
  expect(f.catalog.getRecord("security-change-mappings", change.id)).toEqual({ service: "app" });
});

test("a real catalog stores validation evidence for an image-only service", async () => {
  const f = await registered();
  await f.maintenance.scan(BASE);
  expect(await f.remediate("local/app:v2")).toMatchObject({ state: "validated", evidence: { candidateImageId: CANDIDATE } });
});

async function activated(replacement = "local/app:v2") {
  const f = await registered();
  await f.maintenance.scan(BASE);
  const change = await f.remediate(replacement);
  expect((await f.maintenance.activate(change.id)).state).toBe("activated");
  return { ...f, change, override: f.docker.containers[0]!.files.at(-1)! };
}
const owned = async (f: Awaited<ReturnType<typeof registered>>) => (await f.runtime.inventory([f.project])).filter((item) => item.componentId === "app").length;

test("an activated container stays owned by its component", async () => {
  const f = await activated();
  expect(f.docker.containers[0]).toMatchObject({ image: CANDIDATE, files: [f.composeFile, f.override] });
  expect(await owned(f)).toBe(1);
  expect(await f.runtime.check(f.project, f.component)).toMatchObject({ state: "running" });
  await f.runtime.stop(f.project, f.component);
});

test("a foreign or altered override stays rejected after activation", async () => {
  const f = await activated();
  const original = readFileSync(f.override, "utf8");
  const refused = async () => {
    expect(await owned(f)).toBe(0);
    await expect(f.runtime.stop(f.project, f.component)).rejects.toThrow("Compose container ownership labels do not match");
  };

  const foreign = join(f.root, "override.yml"); writeFileSync(foreign, original);
  writeFileSync(f.override, original.replace("build: !reset null", "privileged: true")); await refused();
  rmSync(f.override); symlinkSync(foreign, f.override); await refused();
  rmSync(f.override); writeFileSync(f.override, original);

  f.docker.containers[0]!.files = [f.composeFile, foreign]; await refused();
  const sibling = join(dirname(f.override), `${"0".repeat(32)}-${CANDIDATE.slice(7)}.yml`); writeFileSync(sibling, original);
  f.docker.containers[0]!.files = [f.composeFile, sibling]; await refused();

  f.docker.containers[0]!.files = [f.composeFile, f.override];
  f.docker.containers[0]!.service = "other";
  f.project.components[0]!.compose!.services.push("other");
  await refused();
});

test("a later activation retires the superseded override", async () => {
  const f = await activated();
  await f.commit(); await f.maintenance.scan(CANDIDATE);
  const next = await f.remediate("local/app:v3");
  expect((await f.maintenance.activate(next.id)).state).toBe("activated");
  expect(existsSync(f.override)).toBe(false);
  expect(await owned(f)).toBe(1);

  f.docker.containers[0]!.files = [f.composeFile, f.override];
  expect(await owned(f)).toBe(0);
  await expect(f.runtime.stop(f.project, f.component)).rejects.toThrow("Compose container ownership labels do not match");
});

test("a failed activation keeps the running container owned and leaves no new override", async () => {
  const f = await activated();
  await f.commit(); await f.maintenance.scan(CANDIDATE);
  const next = await f.remediate("local/app:v3");
  f.docker.upFails = true;
  await expect(f.maintenance.activate(next.id)).rejects.toThrow("Candidate activation failed");
  expect(readdirSync(dirname(f.override))).toEqual([basename(f.override)]);
  expect(await owned(f)).toBe(1);
});

test("retiring one service's overrides keeps the other services of the component approved", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devhub-override-")); dirs.push(stateDir);
  const app = { stateDir, projectId: "fixture", componentId: "app", service: "app" }, worker = { ...app, service: "worker" };
  const keep = overrideFile(app, CANDIDATE), stale = overrideFile(app, BASE), other = overrideFile(worker, BASE);
  mkdirSync(dirname(keep));
  writeFileSync(keep, overrideContent("app", CANDIDATE)); writeFileSync(stale, overrideContent("app", BASE)); writeFileSync(other, overrideContent("worker", BASE));
  retireOverrides(app, keep);
  expect([approvedOverride(app, keep), approvedOverride(app, stale), approvedOverride(worker, other)]).toEqual([true, false, true]);
});

test("reactivating the running image reuses its override, even when activation fails", async () => {
  const f = await activated();
  await f.commit(); await f.maintenance.scan(CANDIDATE);
  const next = await f.remediate("local/app:v2-rebuilt");
  expect(next.evidence?.candidateImageId).toBe(CANDIDATE);
  f.docker.upFails = true;
  await expect(f.maintenance.activate(next.id)).rejects.toThrow("Candidate activation failed");
  expect(await owned(f)).toBe(1);
});
