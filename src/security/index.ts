import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import { DevHubError, type CatalogPort, type Change, type Component, type ContainerInfo, type Executor, type Finding, type MaintenancePort, type Project, type RemediationInput, type RuntimePort, type Scan, type ValidationEvidence } from "../contracts";
import { gitRun } from "../git";
import { redactText } from "../operations/logger";
import { ensureStateDir } from "../state";
import { assertSharedDataUntouched, type ComposeModel } from "../runtime/mounts";
import { approvedOverride, overrideContent, overrideFile, retireOverrides } from "./override";
import { envFileKeys } from "../guard";

const READ = { timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 } as const;
const DOCKER = { timeoutMs: 900_000, maxOutputBytes: 8 * 1024 * 1024 } as const;
const RECORD_SCAN = "security-scans";
const RECORD_CHANGE = "security-changes";
const RECORD_SNAPSHOT = "security-snapshots";
const RECORD_MAPPING = "security-change-mappings";
const MAX_SCANS = 200;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROTECTED = new Set(["devhub", "dev-infra", "devhub-infra"]);
const within = (path: string, root: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const fail = (message: string, code = "maintenance", status = 400) => new DevHubError(message, code, status);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const stable = (value: unknown) => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const json = (value: string, message: string): unknown => { try { return JSON.parse(value); } catch { throw fail(message, "tool_output", 502); } };

function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw fail("Maintenance paths must be absolute and canonical", "unsafe_path", 403);
  try { return realpathSync(path); } catch { throw fail("Maintenance path does not exist", "unsafe_path", 403); }
}
function validateImageRef(reference: string): void {
  if (typeof reference !== "string" || reference.length > 255 || !reference || /[\0\r\n\s$]/.test(reference) || reference.startsWith("-") || /^(?:sha256:|https?:|docker:)/i.test(reference) || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(reference) || reference.endsWith(":") || reference.includes("//")) throw fail("Invalid or unsupported image reference");
}
function imageParts(ref: string): { family: string; major?: number } {
  const withoutDigest = ref.split("@")[0]!; const slash = withoutDigest.lastIndexOf("/"); const colon = withoutDigest.lastIndexOf(":");
  const hasTag = colon > slash; const name = (hasTag ? withoutDigest.slice(0, colon) : withoutDigest).split("/").at(-1)!.toLowerCase();
  const tag = hasTag ? withoutDigest.slice(colon + 1) : ""; const major = /^v?(\d+)(?:[.-]|$)/i.exec(tag)?.[1];
  return { family: name, ...(major ? { major: Number(major) } : {}) };
}
function databaseImage(ref: string): boolean { return /^(?:postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|mssql|cassandra|oracle)(?:[-_].*)?$/.test(imageParts(ref).family); }
function findReference(line: string): string {
  const from = /^([ \t]*FROM[ \t]+(?:--platform=[^ \t]+[ \t]+)?)([^ \t#]+)((?:[ \t]+AS[ \t]+[A-Za-z0-9_.-]+)?[ \t]*(?:#.*)?)$/i.exec(line);
  if (from) return from[2]!;
  const image = /^([ \t]*image[ \t]*:[ \t]*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^#\s]+))([ \t]*(?:#.*)?)$/.exec(line);
  if (image) return image[2] ?? image[3] ?? image[4]!;
  throw fail("Only a Dockerfile FROM or Compose service.image scalar can be changed", "unsupported_patch", 409);
}
function replaceReference(content: string, source: string, replacement: string, selectedLine?: number): string {
  const lines = content.split(/\r?\n/); const found: number[] = [];
  if (selectedLine !== undefined) found.push(selectedLine);
  else lines.forEach((line, i) => { try { if (findReference(line) === source) found.push(i); } catch {} });
  if (found.length !== 1) throw fail("Source must contain exactly one supported matching image operand", "unsupported_patch", 409);
  const i = found[0]!; const line = lines[i]!;
  if (findReference(line) !== source) throw fail("Selected image operand changed", "stale_source", 409);
  const docker = /^([ \t]*FROM[ \t]+(?:--platform=[^ \t]+[ \t]+)?)([^ \t#]+)((?:[ \t]+AS[ \t]+[A-Za-z0-9_.-]+)?[ \t]*(?:#.*)?)$/i;
  const compose = /^([ \t]*image[ \t]*:[ \t]*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^#\s]+))([ \t]*(?:#.*)?)$/;
  const m = docker.exec(line); const c = compose.exec(line);
  let changed: string;
  if (m) changed = `${m[1]}${replacement}${m[3]}`;
  else if (c) { const q = c[2] !== undefined ? '"' : c[3] !== undefined ? "'" : ""; changed = `${c[1]}${q}${replacement}${q}${c[5]}`; }
  else throw fail("Unsupported image source syntax", "unsupported_patch", 409);
  let start = 0;
  for (let index = 0; index < i; index++) {
    const newline = content.indexOf("\n", start);
    if (newline < 0) throw fail("Selected image operand is outside the source", "stale_source", 409);
    start = newline + 1;
  }
  let end = content.indexOf("\n", start);
  if (end < 0) end = content.length; else if (end > start && content[end - 1] === "\r") end -= 1;
  return content.slice(0, start) + changed + content.slice(end);
}
function normalizeFindings(raw: unknown): Finding[] {
  const root = raw as Record<string, unknown>;
  const results = Array.isArray(root.Results) ? root.Results : Array.isArray(root.results) ? root.results : undefined;
  if (!results || results.length > 5000) throw fail("Scanner JSON has an unsupported schema", "scanner_output", 502);
  const out = new Map<string, Finding>();
  for (const result of results) {
    if (out.size >= 5000) break;
    if (!result || typeof result !== "object") continue;
    const row = result as Record<string, unknown>, target = redactText(String(row.Target ?? row.target ?? "")).slice(0, 512);
    const vulns = row.Vulnerabilities ?? row.vulnerabilities;
    if (vulns === undefined || vulns === null) continue;
    if (!Array.isArray(vulns)) throw fail("Scanner JSON has invalid vulnerabilities", "scanner_output", 502);
    for (const vuln of vulns.slice(0, 5000)) {
      if (!vuln || typeof vuln !== "object") continue;
      const v = vuln as Record<string, unknown>;
      const id = redactText(String(v.VulnerabilityID ?? v.id ?? "")).slice(0, 128);
      const pkg = redactText(String(v.PkgName ?? v.package ?? "")).slice(0, 256);
      if (!id || !pkg) continue;
      const installedVersion = redactText(String(v.InstalledVersion ?? v.installedVersion ?? "unknown")).slice(0, 128);
      const fixed = redactText(String(v.FixedVersion ?? v.fixedVersion ?? "")).slice(0, 128);
      const key = `${target}\0${id}\0${pkg}`;
      out.set(key, { id, package: pkg, installedVersion, ...(fixed ? { fixedVersion: fixed } : {}), severity: redactText(String(v.Severity ?? v.severity ?? "UNKNOWN")).slice(0, 32), title: redactText(String(v.Title ?? v.title ?? id)).slice(0, 512), target });
      if (out.size >= 5000) break;
    }
  }
  return [...out.values()];
}
function sortedFindings(findings: Finding[]) { return findings.map((x) => `${x.target}\0${x.id}\0${x.package}\0${x.fixedVersion ?? ""}`).sort(); }
function composeModel(source: string): Record<string, any> {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw fail("Compose YAML is invalid", "unsafe_compose", 400);
  const value = doc.toJS();
  if (!value || typeof value !== "object" || !value.services || typeof value.services !== "object") throw fail("Compose model has no services", "unsafe_compose", 400);
  return value;
}
function checkProjectEnv(cwd: string): void {
  const path = join(cwd, ".env");
  let stat; try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || canonical(path) !== path) throw fail("Compose .env must be a canonical regular file no larger than 1 MiB", "unsafe_environment", 403);
  const allowed = new Set(["COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"]);
  const protectedKeys = /^(?:COMPOSE_|DOCKER_)/;
  for (const key of envFileKeys(readFileSync(path, "utf8"))) {
    if (protectedKeys.test(key) && !allowed.has(key)) throw fail(`Compose .env setting ${key} is not allowed`, "unsafe_environment", 403);
  }
}
function assertSafeDockerArgv(argv: string[], candidate: boolean): void {
  const forbidden = new Set(["--privileged", "--cap-add", "--pid", "--ipc", "--userns", "--device", "--security-opt", "-v", "--volume", "--mount"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ([...forbidden].some((flag) => arg === flag || arg.startsWith(`${flag}=`)) || /^-[^\s]*v[^\s]*/.test(arg) && arg.startsWith("-v")) throw fail("Unsafe Docker argument refused", "unsafe_docker", 403);
    if ((arg === "--secret" || arg.startsWith("--secret=" ) || arg === "--ssh" || arg.startsWith("--ssh=")) || (arg === "--network" && argv[i + 1] !== (candidate ? "none" : undefined))) throw fail("Unsafe Docker argument refused", "unsafe_docker", 403);
  }
}

export class Maintenance implements MaintenancePort {
  private readonly catalog: CatalogPort;
  private readonly runtime: RuntimePort;
  private readonly run: Executor;
  private readonly stateDir: string;
  constructor(options: { catalog: CatalogPort; runtime: RuntimePort; run: Executor; stateDir: string }) {
    this.catalog = options.catalog; this.runtime = options.runtime; this.run = options.run; this.stateDir = ensureStateDir(options.stateDir);
  }

  private assertUnprotected(path: string): void {
    const target = canonical(path);
    const protectedPaths = [resolve(import.meta.dir, "../.."), this.stateDir, process.env.DEVHUB_DIR, join(resolve(process.env.HOME || homedir()), ".local/share/devhub")].filter((x): x is string => !!x);
    for (const raw of protectedPaths) {
      const protectedPath = resolve(raw);
      if (within(target, protectedPath) || within(protectedPath, target)) throw fail("Maintenance target overlaps protected DevHub data", "unsafe_path", 403);
    }
  }

  private async dockerContext(): Promise<void> {
    const result = await this.run(["docker", "context", "inspect", "--format", "json"], READ);
    if (result.code !== 0) throw fail("Unable to verify the local Docker context", "docker_context", 503);
    const parsed = json(result.stdout, "Docker context returned invalid JSON") as any;
    const contexts = Array.isArray(parsed) ? parsed : [parsed];
    if (!contexts.length || contexts.some((x) => { const host = x?.Endpoints?.docker?.Host; return typeof host !== "string" || !/^unix:\/\//.test(host) || !host.slice(7).startsWith("/"); })) throw fail("Docker context must use a local Unix socket", "unsafe_runtime", 403);
  }
  private projectComponent(projectId: string, componentId: string): { project: Project; component: Component } {
    const project = this.catalog.getProject(projectId); const component = project.components.find((x) => x.id === componentId);
    if (!component) throw fail("Component is not registered to this project", "not_found", 404);
    return { project, component };
  }
  private source(project: Project, component: Component, file: string, service?: string, stage?: string): { path: string; content: string; sourceHash: string; service?: string; stage?: string } {
    const root = canonical(this.catalog.assertAllowedPath(project.root, true));
    const cwd = canonical(this.catalog.assertAllowedPath(component.cwd, true));
    if (!within(cwd, root) || component.kind !== "compose" || !component.compose || !component.sources?.length) throw fail("Maintenance requires a Compose component with explicit approved sources", "unsafe_source", 403);
    this.assertUnprotected(cwd);
    if (!SLUG.test(project.id) || !SLUG.test(component.id)) throw fail("Invalid maintenance project identity", "unsafe_runtime", 403);
    if (PROTECTED.has(component.compose.projectName.toLowerCase()) || component.compose.projectName.toLowerCase().startsWith("infra-") || !SLUG.test(component.compose.projectName)) throw fail("Protected Compose project cannot be maintained", "unsafe_runtime", 403);
    const mappings = component.sources.filter((s) => s.file === file && (service === undefined || s.service === undefined || s.service === service) && (stage === undefined || s.stage === undefined || s.stage === stage));
    if (mappings.length !== 1) throw fail("Source file is not uniquely mapped to this component", "unsafe_source", 403);
    service ??= mappings[0]!.service; stage ??= mappings[0]!.stage;
    const path = canonical(this.catalog.assertAllowedPath(resolve(cwd, file), true));
    if (!within(path, root)) throw fail("Source path escapes the project root", "unsafe_path", 403);
    this.assertUnprotected(path);
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw fail("Source must be a regular file no larger than 1 MiB", "unsafe_source", 403);
    const content = readFileSync(path, "utf8");
    if (/\.ya?ml$/i.test(path)) {
      if (!component.compose.files.some((composeFile) => {
        const lexical = resolve(cwd, composeFile); const composeStat = lstatSync(lexical); const composePath = canonical(lexical);
        return within(composePath, root) && composeStat.isFile() && !composeStat.isSymbolicLink() && composePath === path;
      })) throw fail("Compose remediation source is not an owned Compose file", "unsafe_source", 403);
      const model = composeModel(content); if (!service || !component.compose.services.includes(service) || !model.services[service]) throw fail("Compose source requires a mapped selected service");
      const value = model.services[service].image;
      if (typeof value !== "string" || /\$\{[^}]+\}/.test(value)) throw fail("Compose service.image must be a resolved scalar");
    } else if (!/(?:^|\/)Dockerfile(?:\.[A-Za-z0-9._-]+)?$/i.test(path)) throw fail("Only Dockerfiles and Compose YAML sources are supported");
    else {
      if (!service || !component.compose.services.includes(service)) throw fail("Dockerfile source requires a mapped selected service");
      let ownedBuildSource = false;
      for (const composeFile of component.compose.files) {
        const lexical = resolve(cwd, composeFile); const composeStat = lstatSync(lexical); const composePath = canonical(lexical);
        if (!within(composePath, root) || !composeStat.isFile() || composeStat.isSymbolicLink()) throw fail("Compose files must be regular files inside the project", "unsafe_path", 403);
        const compose = composeModel(readFileSync(composePath, "utf8")); const build = compose.services[service]?.build;
        if (!build) continue;
        const config = typeof build === "string" ? { context: build } : build;
        if (typeof config.context !== "string" || /\$\{|^(?:https?:|git@)/i.test(config.context)) continue;
        const context = resolve(cwd, config.context);
        const dockerfile = typeof config.dockerfile === "string" ? resolve(context, config.dockerfile) : resolve(context, "Dockerfile");
        try { if (canonical(dockerfile) === path) ownedBuildSource = true; } catch { /* A missing build source is not an owner. */ }
      }
      if (!ownedBuildSource) throw fail("Dockerfile is not the selected Compose service build source", "unsafe_source", 403);
    }
    return { path, content, sourceHash: hash(content), ...(service ? { service } : {}), ...(stage ? { stage } : {}) };
  }
  private async claim(projectId: string, componentId: string): Promise<{ operationId: string; release: (error?: unknown) => void }> {
    const claim = this.catalog.claimOperation(projectId, "check", [componentId]);
    if (!claim.acquired) throw fail("Another project operation is active", "operation_conflict", 409);
    // The catalog only allows queued -> running -> succeeded|failed.
    this.catalog.updateOperation(claim.operation.id, { state: "running" });
    let released = false;
    return { operationId: claim.operation.id, release: (error?: unknown) => { if (released) return; released = true; this.catalog.updateOperation(claim.operation.id, { state: error ? "failed" : "succeeded", ...(error ? { error: redactText(error instanceof Error ? error.message : "Maintenance failed").slice(0, 500) } : {}) }); } };
  }
  private async imageExists(imageId: string): Promise<void> {
    if (!IMAGE_ID.test(imageId)) throw fail("A full local image ID is required", "invalid_image", 400);
    await this.dockerContext();
    const result = await this.run(["docker", "image", "inspect", "--format", "{{.Id}}", imageId], READ);
    if (result.code !== 0 || result.stdout.trim() !== imageId) throw fail("Image ID is not present in the verified local Docker context", "image_missing", 404);
  }
  async scan(imageId: string): Promise<Scan> {
    const id = randomUUID(), scannedAt = new Date().toISOString();
    let record: Scan;
    try {
      await this.imageExists(imageId);
      const version = await this.run(["trivy", "--version"], READ);
      if (version.code !== 0) throw fail("Trivy is unavailable", "scanner_missing", 503);
      const scanner = `trivy ${(version.stdout || version.stderr).trim().slice(0, 256) || "version unknown"}`;
      const result = await this.run(["trivy", "image", "--image-src", "docker", "--scanners", "vuln", "--format", "json", imageId], { timeoutMs: 900_000, maxOutputBytes: 16 * 1024 * 1024 });
      if (result.code !== 0) throw fail("Trivy scan failed", "scanner_failed", 502);
      const parsed = json(result.stdout, "Trivy returned invalid JSON") as Record<string, unknown>;
      const metadata = parsed.Metadata && typeof parsed.Metadata === "object" ? parsed.Metadata as Record<string, unknown> : {};
      const report = parsed.ArtifactID;
      if (typeof report === "string" && report !== imageId && !report.endsWith(imageId.slice(7, 19))) throw fail("Trivy scanned a different image", "scanner_mismatch", 502);
      record = { id, imageId, state: "succeeded", scannedAt, scanner, ...(typeof metadata.UpdatedAt === "string" ? { databaseUpdatedAt: metadata.UpdatedAt } : {}), findings: normalizeFindings(parsed) };
    } catch (error) {
      record = { id, imageId, state: "failed", scannedAt, scanner: "trivy (unavailable or failed)", findings: [], error: redactText(error instanceof Error ? error.message : "Scan failed").slice(0, 500) };
    }
    this.pruneScans();
    this.catalog.putRecord(RECORD_SCAN, id, record); return record;
  }
  /** Keep scan history bounded; scans referenced by change evidence are never removed. */
  private pruneScans(): void {
    const scans = this.listScans();
    if (scans.length < MAX_SCANS) return;
    const referenced = new Set(this.listChanges().flatMap((change) => [change.scanId, change.evidence?.baselineScanId, change.evidence?.candidateScanId]).filter((x): x is string => !!x));
    for (const scan of scans.slice(MAX_SCANS - 1)) if (!referenced.has(scan.id)) this.catalog.deleteRecord(RECORD_SCAN, scan.id);
  }
  listScans(): Scan[] { return this.catalog.listRecords<Scan>(RECORD_SCAN).sort((a, b) => b.scannedAt.localeCompare(a.scannedAt)); }
  getScan(id: string): Scan { const scan = this.catalog.getRecord<Scan>(RECORD_SCAN, id); if (!scan) throw fail("Scan not found", "not_found", 404); return scan; }
  listChanges(): Change[] { return this.catalog.listRecords<Change>(RECORD_CHANGE).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private getChange(id: string): Change { const change = this.catalog.getRecord<Change>(RECORD_CHANGE, id); if (!change) throw fail("Change not found", "not_found", 404); return change; }
  private save(change: Change): Change { this.catalog.putRecord(RECORD_CHANGE, change.id, change); return change; }
  async preview(input: RemediationInput): Promise<Change> {
    const { project, component } = this.projectComponent(input.projectId, input.componentId);
    const lock = await this.claim(project.id, component.id); let error: unknown;
    try {
      const source = this.source(project, component, input.file, input.service, input.stage);
      const selectedService = input.service ?? source.service;
      const selectedStage = input.stage ?? source.stage;
      let currentRef: string;
      if (/\.ya?ml$/i.test(source.path)) {
        const model = composeModel(source.content);
        currentRef = model.services[selectedService!].image;
      } else {
        const matching = source.content.split(/\r?\n/).filter((line) => {
          if (!/^\s*FROM\s/i.test(line)) return false;
          if (!selectedStage) return true;
          return new RegExp("\\sAS\\s+([A-Za-z0-9_.-]+)(?:\\s|$)", "i").exec(line)?.[1]?.toLowerCase() === selectedStage.toLowerCase();
        });
        if (matching.length !== 1) throw fail("Dockerfile stage must identify exactly one FROM instruction", "unsupported_patch", 409);
        currentRef = findReference(matching[0]!);
      }
      validateImageRef(input.replacement);
      if (databaseImage(currentRef) || databaseImage(input.replacement)) {
        const before = imageParts(currentRef), after = imageParts(input.replacement);
        if (!databaseImage(currentRef) || !databaseImage(input.replacement) || before.family !== after.family || before.major === undefined || after.major === undefined || before.major !== after.major) throw fail("Database major-version changes require a separate migration plan", "database_migration", 409);
      }
      let proposed: string;
      if (/\.ya?ml$/i.test(source.path)) {
        const doc = parseDocument(source.content, { uniqueKeys: true });
        const node = doc.getIn(["services", selectedService!, "image"], true) as { range?: [number, number, number?] } | null;
        if (!node?.range || node.range[0] < 0) throw fail("Compose service.image scalar must be uniquely editable", "unsupported_patch", 409);
        const imageLine = source.content.slice(0, node.range[0]).split(/\r?\n/).length - 1;
        proposed = replaceReference(source.content, currentRef, input.replacement, imageLine);
      } else {
        const lines = source.content.split(/\r?\n/); const selected = lines.filter((line) => /^\s*FROM\s/i.test(line) && findReference(line) === currentRef && (!selectedStage || new RegExp("\\sAS\\s+([A-Za-z0-9_.-]+)(?:\\s|$)", "i").exec(line)?.[1]?.toLowerCase() === selectedStage.toLowerCase()));
        if (selected.length !== 1) throw fail("Dockerfile FROM operand must be uniquely editable", "unsupported_patch", 409);
        proposed = replaceReference(source.content, currentRef, input.replacement, lines.indexOf(selected[0]!));
      }
      const change: Change = { id: randomUUID(), projectId: project.id, componentId: component.id, file: input.file, sourceHash: source.sourceHash, original: source.content, proposed, replacement: input.replacement, state: "preview", createdAt: new Date().toISOString() };
      this.save(change); this.catalog.putRecord(RECORD_MAPPING, change.id, { ...(selectedService ? { service: selectedService } : {}), ...(selectedStage ? { stage: selectedStage } : {}) }); return change;
    } catch (caught) { error = caught; throw caught; } finally { lock.release(error); }
  }
  private async git(cwd: string, args: string[]) { return gitRun(this.run, ["-C", cwd, ...args], READ); }
  private async gitRoot(cwd: string, projectRoot: string): Promise<string> {
    const result = await this.git(cwd, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) throw fail("Source is not in a Git repository", "unsafe_git", 409);
    const root = canonical(result.stdout.trim()); if (!within(root, projectRoot)) throw fail("Git working tree must be inside project root", "unsafe_git", 403); return root;
  }
  private async assertChangeWorkspace(change: Change, project: Project, sourcePath: string): Promise<void> {
    if (!change.branch) throw fail("Applied change has no maintenance branch", "stale_evidence", 409);
    const root = canonical(project.root); const gitRoot = await this.gitRoot(dirname(sourcePath), root);
    const branch = await this.git(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.code !== 0 || branch.stdout.trim() !== change.branch) throw fail("Maintenance branch changed since apply", "stale_evidence", 409);
    const status = await this.git(gitRoot, ["status", "--porcelain", "--untracked-files=no", "-z"]);
    if (status.code !== 0) throw fail("Cannot verify maintenance worktree", "unsafe_git", 409);
    const changed = status.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
    const target = relative(gitRoot, sourcePath);
    if (changed.some((file) => file !== target)) throw fail("Other tracked files changed since apply", "stale_evidence", 409);
  }
  private async applyInternal(change: Change): Promise<Change> {
    if (change.state !== "preview") throw fail("Only a preview can be applied", "change_state", 409);
    const { project, component } = this.projectComponent(change.projectId, change.componentId);
    const mapping = this.catalog.getRecord<{ service?: string; stage?: string }>(RECORD_MAPPING, change.id);
    const source = this.source(project, component, change.file, mapping?.service, mapping?.stage);
    if (source.sourceHash !== change.sourceHash || source.content !== change.original) throw fail("Source changed since preview", "stale_source", 409);
    const root = canonical(this.catalog.assertAllowedPath(project.root, true)); const gitRoot = await this.gitRoot(dirname(source.path), root);
    const tracked = await this.git(gitRoot, ["ls-files", "--error-unmatch", "--", relative(gitRoot, source.path)]);
    if (tracked.code !== 0) throw fail("Maintenance source must already be tracked", "untracked_source", 409);
    const status = await this.git(gitRoot, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0 || status.stdout.trim()) throw fail("Tracked Git changes must be committed before apply", "dirty_tree", 409);
    const branch = `devhub/maintenance-${change.id}`;
    const existing = await this.git(gitRoot, ["branch", "--list", "--format=%(refname:short)", branch]);
    if (existing.code !== 0) throw fail("Could not verify maintenance branch", "unsafe_git", 409);
    if (existing.stdout.trim()) throw fail("Maintenance branch already exists", "branch_collision", 409);
    const head = await this.git(gitRoot, ["rev-parse", "HEAD"]); const currentBranch = await this.git(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.code !== 0 || currentBranch.code !== 0) throw fail("Maintenance requires a named Git branch", "unsafe_git", 409);
    let switched = false;
    try {
      const checkout = await this.git(gitRoot, ["switch", "-c", branch]); if (checkout.code !== 0) throw fail("Could not create maintenance branch", "git_failed", 409); switched = true;
      writeFileSync(source.path, change.proposed, { encoding: "utf8", mode: lstatSync(source.path).mode & 0o777 });
      change.branch = branch; change.state = "applied"; this.save(change); return change;
    } catch (caught) {
      if (switched) {
        const problems: string[] = [];
        try { writeFileSync(source.path, change.original, "utf8"); } catch { problems.push("source bytes"); }
        if ((await this.git(gitRoot, ["switch", currentBranch.stdout.trim()]).catch(() => ({ code: 1 }))).code !== 0) problems.push("original branch");
        else if ((await this.git(gitRoot, ["branch", "-D", branch]).catch(() => ({ code: 1 }))).code !== 0) problems.push("maintenance branch removal");
        const back = await this.git(gitRoot, ["rev-parse", "HEAD"]).catch(() => ({ code: 1, stdout: "" }));
        if (back.code !== 0 || back.stdout.trim() !== head.stdout.trim()) problems.push("HEAD");
        try { if (readFileSync(source.path, "utf8") !== change.original) problems.push("source bytes"); } catch { problems.push("source bytes"); }
        if (problems.length) throw fail(`Apply failed and rollback is incomplete (${[...new Set(problems)].join(", ")}); inspect the Git checkout before retrying`, "rollback_incomplete", 500);
      }
      throw caught;
    }
  }
  async apply(changeId: string): Promise<Change> {
    const change = this.getChange(changeId), lock = await this.claim(change.projectId, change.componentId); let error: unknown;
    try { return await this.applyInternal(change); } catch (caught) { error = caught; change.state = "failed"; change.error = caught instanceof Error ? caught.message.slice(0, 500) : "Apply failed"; this.save(change); throw caught; } finally { lock.release(error); }
  }
  private async composePreflight(project: Project, component: Component, preferredService?: string): Promise<{ base: string[]; model: Record<string, any>; selected: string }> {
    if (!component.compose || component.kind !== "compose" || !component.validation?.argv?.length) throw fail("Safe validation requires a Compose component and explicit validation argv", "validation_unsupported", 409);
    if (component.validation.argv.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0"))) throw fail("Validation command is invalid", "validation_unsupported", 409);
    assertSafeDockerArgv(["docker", "run", "--rm", "--network", "none", "--entrypoint", component.validation.argv[0]!, "candidate-image", ...component.validation.argv.slice(1)], true);
    const cwd = canonical(this.catalog.assertAllowedPath(component.cwd, true)); const root = canonical(this.catalog.assertAllowedPath(project.root, true));
    if (!within(cwd, root) || !component.sources?.length) throw fail("Compose validation requires mapped sources inside the project", "unsafe_source", 403);
    this.assertUnprotected(cwd);
    checkProjectEnv(cwd);
    if (component.envFiles?.length) throw fail("Validation cannot expose project environment files", "validation_unsupported", 409);
    const files = component.compose.files.map((file) => {
      const lexical = resolve(cwd, file); const stat = lstatSync(lexical); const path = canonical(this.catalog.assertAllowedPath(lexical, true));
      if (!within(path, root) || !stat.isFile() || stat.isSymbolicLink()) throw fail("Compose files must be regular project files", "unsafe_path", 403);
      return path;
    });
    if (!SLUG.test(component.compose.projectName) || PROTECTED.has(component.compose.projectName.toLowerCase()) || component.compose.projectName.toLowerCase().startsWith("infra-") || component.compose.services.some((x) => !SLUG.test(x)) || component.compose.profiles.some((x) => !SLUG.test(x))) throw fail("Invalid or protected Compose identity", "unsafe_runtime", 403);
    const base = ["docker", "compose", "-p", component.compose.projectName, `--project-directory=${cwd}`, ...files.map((file) => `--file=${file}`), ...component.compose.profiles.flatMap((p) => ["--profile", p])];
    assertSafeDockerArgv(base, false);
    const config = await this.run([...base, "config", "--format", "json", "--no-env-resolution"], READ);
    if (config.code !== 0) throw fail("Compose configuration validation failed", "unsafe_compose", 400);
    const model = composeModel(stringify(json(config.stdout, "Compose returned invalid configuration")));
    const buildServices = component.compose.services.filter((service) => model.services[service]?.build);
    if (preferredService && !component.compose.services.includes(preferredService)) throw fail("Mapped service is not selected by the component", "unsafe_source", 403);
    if (!preferredService && buildServices.length !== 1) throw fail("Validation requires one unambiguous selected service", "validation_unsupported", 409);
    const selected = preferredService ?? buildServices[0]!;
    for (const service of component.compose.services) if (!model.services[service]) throw fail("Selected service is absent from Compose configuration");
    assertSharedDataUntouched(model as ComposeModel, component.compose.services, this.stateDir);
    const service = model.services[selected];
    if (service.privileged === true || service.devices || service.userns_mode === "host" || service.cgroup_parent || service.cgroup || service.volumes_from) throw fail("Selected Compose service uses unsupported privileged settings", "unsafe_compose", 403);
    for (const key of ["network_mode", "ipc", "pid"]) if (typeof service[key] === "string" && /^(?:host|container:)/.test(service[key])) throw fail("Selected Compose service shares a host or container namespace", "unsafe_compose", 403);
    for (const mount of Array.isArray(service.volumes) ? service.volumes : []) {
      if (!mount || typeof mount !== "object" || mount.type !== "bind") continue;
      if (typeof mount.source !== "string" || mount.source.includes("${") || !isAbsolute(mount.source)) throw fail("Selected Compose bind mounts must use explicit absolute paths", "unsafe_compose", 403);
      const mountPath = canonical(mount.source); const mountStat = lstatSync(mount.source);
      if (!within(mountPath, root) || mountStat.isSymbolicLink() || (!mountStat.isDirectory() && !mountStat.isFile())) throw fail("Selected Compose bind mounts must stay inside the project", "unsafe_path", 403);
    }
    return { base, model, selected };
  }
  /** Hash .env, component env files and every selected service env_file so activation sees the validated environment. */
  private envInputsHash(component: Component, model: Record<string, any>): string {
    const cwd = canonical(component.cwd);
    const files = new Set<string>([join(cwd, ".env"), ...(component.envFiles ?? []).map((file) => resolve(cwd, file))]);
    for (const service of component.compose?.services ?? []) {
      const entries = model.services?.[service]?.env_file;
      for (const entry of Array.isArray(entries) ? entries : entries === undefined ? [] : [entries]) {
        const path = typeof entry === "string" ? entry : typeof entry?.path === "string" ? entry.path : undefined;
        if (!path || path.includes("${")) throw fail("Service env_file must be a resolved path", "validation_unsupported", 409);
        files.add(resolve(cwd, path));
      }
    }
    const parts = [...files].sort().map((path) => {
      try { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw fail("Environment inputs must be regular files", "unsafe_environment", 403); return `${path}\0${hash(readFileSync(path, "utf8"))}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${path}\0missing`; throw error; }
    });
    return hash(parts.join("\n"));
  }
  private async inspectContainers(project: Project, component: Component): Promise<{ containers: ContainerInfo[]; volumes: ValidationEvidence["volumes"] }> {
    const inventory = await this.runtime.inventory([project]);
    const containers = inventory.filter((item) => item.projectId === project.id && item.componentId === component.id);
    const inspect = containers.length ? await this.run(["docker", "inspect", ...containers.map((x) => x.id)], READ) : { code: 0, stdout: "[]", stderr: "" };
    if (inspect.code !== 0) throw fail("Unable to snapshot selected project containers", "runtime_inventory", 502);
    const items = json(inspect.stdout, "Docker inspect returned invalid JSON") as any[];
    const volumes = new Map<string, string>();
    for (const item of items) for (const mount of item.Mounts ?? []) if (mount.Type === "volume" && typeof mount.Name === "string" && typeof mount.Destination === "string") volumes.set(mount.Name, mount.Destination);
    return { containers, volumes: [...volumes].map(([name, destination]) => ({ name, destination })).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  async validate(changeId: string): Promise<Change> {
    const change = this.getChange(changeId), lock = await this.claim(change.projectId, change.componentId); let failure: unknown;
    try {
      if (change.state !== "applied" || !change.branch) throw fail("Only an applied change can be validated", "change_state", 409);
      const { project, component } = this.projectComponent(change.projectId, change.componentId);
      const mapping = this.catalog.getRecord<{ service?: string; stage?: string }>(RECORD_MAPPING, change.id);
      const source = this.source(project, component, change.file, mapping?.service, mapping?.stage);
      if (source.sourceHash !== hash(change.proposed)) throw fail("Applied source differs from the proposed content", "stale_source", 409);
      await this.assertChangeWorkspace(change, project, source.path);
      await this.dockerContext();
      const { base, model, selected } = await this.composePreflight(project, component, mapping?.service);
      const service = model.services[selected]; const build = typeof service.build === "string" ? { context: service.build } : service.build;
      const root = canonical(project.root); let imageTag: string | undefined;
      let candidateRef: string;
      if (build) {
        if (typeof build.context !== "string" || /\$\{|^(?:https?:|git@)/i.test(build.context) || build.args || build.secrets || build.ssh || build.additional_contexts || build.entitlements || build.network || build.platforms || build.platform) throw fail("Compose build uses unsupported or unsafe inputs", "validation_unsupported", 409);
        if (build.target !== undefined && (typeof build.target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(build.target))) throw fail("Compose build target is invalid", "validation_unsupported", 409);
        const context = canonical(resolve(component.cwd, build.context));
        if (!within(context, root)) throw fail("Build context escapes project root", "unsafe_path", 403);
        const sourceFile = typeof build.dockerfile === "string" ? canonical(resolve(context, build.dockerfile)) : join(context, "Dockerfile");
        if (!within(sourceFile, root) || !lstatSync(sourceFile).isFile()) throw fail("Build Dockerfile is outside the approved project", "unsafe_path", 403);
        const dockerfileText = readFileSync(sourceFile, "utf8");
        if (/^\s*RUN\s+.*--mount\s*=\s*type\s*=?\s*(?:secret|ssh)/im.test(dockerfileText)) throw fail("Dockerfile secret and SSH mounts are not supported", "validation_unsupported", 409);
        imageTag = `devhub-candidate:${change.id.replace(/-/g, "")}`; candidateRef = imageTag;
      } else {
        candidateRef = typeof service.image === "string" ? service.image : "";
        validateImageRef(candidateRef);
      }
      // Baseline: the image the selected service runs now; otherwise the original image reference.
      const running = [...new Set((await this.runtime.inventory([project])).filter((item) => item.projectId === project.id && item.componentId === component.id && IMAGE_ID.test(item.imageId)).map((item) => item.imageId))];
      let baselineImageId: string;
      if (running.length === 1) baselineImageId = running[0]!;
      else {
        const baselineRef = /\.ya?ml$/i.test(source.path) ? composeModel(change.original).services[selected]?.image : service.image;
        if (!baselineRef) throw fail("Start the service once or set its image so a baseline image is known", "validation_unsupported", 409);
        validateImageRef(baselineRef);
        const baselineInspect = await this.run(["docker", "image", "inspect", "--format", "{{.Id}}", baselineRef], READ);
        if (baselineInspect.code !== 0 || !IMAGE_ID.test(baselineInspect.stdout.trim())) throw fail("Baseline image is not present locally", "image_missing", 404);
        baselineImageId = baselineInspect.stdout.trim();
      }
      const baselineScan = this.listScans().filter((x) => x.state === "succeeded" && x.imageId === baselineImageId).sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))[0];
      if (!baselineScan) throw fail("Baseline image must have a successful recorded scan", "scan_required", 409);
      const snap = await this.inspectContainers(project, component);
      const envPath = join(component.cwd, ".env");
      let envHash = "missing"; try { envHash = hash(readFileSync(envPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const runtimeHash = hash(stable({ cwd: component.cwd, compose: component.compose, envFiles: component.envFiles ?? [], envHash, sources: component.sources, validation: component.validation, project: project.id }));
      if (build) {
        const context = canonical(resolve(component.cwd, build.context));
        const dockerfilePath = typeof build.dockerfile === "string" ? resolve(context, build.dockerfile) : join(context, "Dockerfile");
        const dockerfileStat = lstatSync(dockerfilePath);
        if (dockerfileStat.isSymbolicLink() || !dockerfileStat.isFile()) throw fail("Build Dockerfile must be a regular project file", "unsafe_path", 403);
        const sourceFile = canonical(dockerfilePath);
        if (!within(sourceFile, root)) throw fail("Build Dockerfile escapes project root", "unsafe_path", 403);
        const buildArgs = ["docker", "build", "--pull=false", ...(typeof build.target === "string" ? ["--target", build.target] : []), "--tag", imageTag!, "--file", sourceFile, context]; assertSafeDockerArgv(buildArgs, false);
        await this.dockerContext();
        const built = await this.run(buildArgs, DOCKER); if (built.code !== 0) throw fail("Candidate image build failed", "candidate_build", 502);
      }
      const candidateInspect = await this.run(["docker", "image", "inspect", "--format", "{{.Id}}", candidateRef], READ);
      if (candidateInspect.code !== 0 || !IMAGE_ID.test(candidateInspect.stdout.trim())) throw fail("Candidate image ID could not be verified", "candidate_image", 502);
      const candidateImageId = candidateInspect.stdout.trim();
      const checkArgv = ["docker", "run", "--rm", "--network", "none", "--entrypoint", component.validation!.argv[0]!, candidateImageId, ...component.validation!.argv.slice(1)]; assertSafeDockerArgv(checkArgv, true);
      const check = await this.run(checkArgv, { timeoutMs: 300_000, maxOutputBytes: 4 * 1024 * 1024 });
      const candidateScan = await this.scan(candidateImageId);
      const candidateChange: Change = { ...change, imageId: candidateImageId, scanId: candidateScan.id };
      const findingsImproved = candidateScan.state === "succeeded" && sortedFindings(candidateScan.findings).join("\n") !== sortedFindings(baselineScan.findings).join("\n") && candidateScan.findings.length < baselineScan.findings.length;
      const evidence: ValidationEvidence = { baselineImageId, candidateImageId, baselineScanId: baselineScan.id, candidateScanId: candidateScan.id, sourceHash: sourceHashOf(change.proposed), runtimeHash, containerIds: snap.containers.map((x) => x.id).sort(), volumes: snap.volumes, checksPassed: check.code === 0 && candidateScan.state === "succeeded", findingsImproved, validatedAt: new Date().toISOString() };
      this.catalog.putRecord(RECORD_SNAPSHOT, change.id, { evidence, selectedService: selected, ...(imageTag ? { imageTag } : {}), candidateRef, composeHash: hash(stable(model)), envInputsHash: this.envInputsHash(component, model), base });
      candidateChange.evidence = evidence; candidateChange.state = evidence.checksPassed ? "validated" : "failed";
      if (!evidence.checksPassed) candidateChange.error = check.code !== 0 ? "Configured application validation failed" : candidateScan.error ?? "Candidate scan failed";
      this.save(candidateChange); if (!evidence.checksPassed) throw fail(candidateChange.error!, "validation_failed", 409); return candidateChange;
    } catch (caught) { failure = caught; const latest = this.getChange(changeId); if (latest.state !== "validated") { latest.state = "failed"; latest.error = caught instanceof Error ? caught.message.slice(0, 500) : "Validation failed"; this.save(latest); } throw caught; } finally { lock.release(failure); }
  }
  private async freshEvidence(change: Change): Promise<{ project: Project; component: Component; evidence: ValidationEvidence; snapshot: any; sourcePath: string }> {
    const { project, component } = this.projectComponent(change.projectId, change.componentId);
    const evidence = change.evidence, snapshot = this.catalog.getRecord<any>(RECORD_SNAPSHOT, change.id);
    if (change.state !== "validated" || !evidence || !snapshot || !evidence.checksPassed || !IMAGE_ID.test(evidence.candidateImageId)) throw fail("Current successful validation evidence is required", "evidence_required", 409);
    const mapping = this.catalog.getRecord<{ service?: string; stage?: string }>(RECORD_MAPPING, change.id);
    const source = this.source(project, component, change.file, mapping?.service, mapping?.stage);
    if (source.sourceHash !== evidence.sourceHash || hash(source.content) !== evidence.sourceHash) throw fail("Validated source is stale", "stale_source", 409);
    await this.assertChangeWorkspace(change, project, source.path);
    const envPath = join(component.cwd, ".env");
    let envHash = "missing"; try { envHash = hash(readFileSync(envPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const runtimeHash = hash(stable({ cwd: component.cwd, compose: component.compose, envFiles: component.envFiles ?? [], envHash, sources: component.sources, validation: component.validation, project: project.id }));
    if (runtimeHash !== evidence.runtimeHash) throw fail("Runtime configuration changed since validation", "stale_evidence", 409);
    const baseline = this.getScan(evidence.baselineScanId), candidate = this.getScan(evidence.candidateScanId);
    if (baseline.state !== "succeeded" || candidate.state !== "succeeded" || baseline.imageId !== evidence.baselineImageId || candidate.imageId !== evidence.candidateImageId || change.scanId !== candidate.id) throw fail("Validation scans are no longer current", "stale_evidence", 409);
    return { project, component, evidence, snapshot, sourcePath: source.path };
  }
  async activate(changeId: string): Promise<Change> {
    const change = this.getChange(changeId), lock = await this.claim(change.projectId, change.componentId); let failure: unknown;
    try {
      const { project, component, evidence, snapshot } = await this.freshEvidence(change);
      await this.dockerContext();
      const image = await this.run(["docker", "image", "inspect", "--format", "{{.Id}}", evidence.candidateImageId], READ);
      if (image.code !== 0 || image.stdout.trim() !== evidence.candidateImageId) throw fail("Validated candidate image is no longer present locally", "stale_evidence", 409);
      const { base, model, selected } = await this.composePreflight(project, component, snapshot.selectedService);
      if (selected !== snapshot.selectedService || hash(stable(model)) !== snapshot.composeHash) throw fail("Compose service model changed since validation", "stale_evidence", 409);
      if (!snapshot.envInputsHash || this.envInputsHash(component, model) !== snapshot.envInputsHash) throw fail("Environment inputs changed since validation", "stale_evidence", 409);
      const before = await this.inspectContainers(project, component);
      if (stable(before.containers.map((x) => x.id).sort()) !== stable(evidence.containerIds) || stable(before.volumes) !== stable(evidence.volumes)) throw fail("Live container or named-volume identity changed since validation", "stale_evidence", 409);
      const serviceName = snapshot.selectedService;
      const scope = { stateDir: this.stateDir, projectId: project.id, componentId: component.id, service: serviceName };
      const overridePath = overrideFile(scope, evidence.candidateImageId);
      // The same image can be activated twice: reuse its override, and never remove one that live containers name.
      const created = !approvedOverride(scope, overridePath);
      if (created) { mkdirSync(dirname(overridePath), { recursive: true, mode: 0o700 }); writeFileSync(overridePath, overrideContent(serviceName, evidence.candidateImageId), { mode: 0o600, flag: "wx" }); }
      try {
        const argv = [...base, "--file", overridePath, "up", "-d", "--no-build", "--no-deps", serviceName];
        assertSafeDockerArgv(argv, false);
        await this.dockerContext();
        const result = await this.run(argv, DOCKER); if (result.code !== 0) throw fail("Candidate activation failed", "activation_failed", 502);
      } catch (caught) { if (created) try { unlinkSync(overridePath); } catch {} throw caught; }
      retireOverrides(scope, overridePath);
      const after = await this.inspectContainers(project, component);
      const selectedIds = await this.run([...base, "ps", "-q", snapshot.selectedService], READ);
      if (selectedIds.code !== 0) throw fail("Could not inspect activated project service", "activation_unverified", 502);
      const ids = selectedIds.stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
      if (!ids.length || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) throw fail("Activated service returned invalid container IDs", "activation_unverified", 502);
      const details = await this.run(["docker", "inspect", ...ids], READ);
      if (details.code !== 0) throw fail("Could not verify activated candidate containers", "activation_unverified", 502);
      const inspected = json(details.stdout, "Docker inspect returned invalid activation data") as any[];
      if (!inspected.length || inspected.some((item) => item.Image !== evidence.candidateImageId) || stable(after.volumes) !== stable(evidence.volumes)) throw fail("Activation did not preserve the exact candidate image and named volumes", "activation_unverified", 502);
      change.state = "activated"; this.save(change); return change;
    } catch (caught) { failure = caught; const latest = this.getChange(changeId); latest.state = "failed"; latest.error = caught instanceof Error ? caught.message.slice(0, 500) : "Activation failed"; this.save(latest); throw caught; } finally { lock.release(failure); }
  }
}
function sourceHashOf(source: string): string { return hash(source); }
