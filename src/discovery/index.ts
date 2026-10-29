import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { DevHubError, type CatalogPort, type Component, type Detection, type DiscoveryPort, type Executor, type PlannedFile, type Preset, type Project, type ProjectInput, type SetupInput, type SetupPlan } from "../contracts";
import { classifyManifests, parseMakeTargets } from "./manifests";

const PLAN_NS = "discovery-plans";
const PLAN_LIMIT = 100;
const PLAN_TTL_MS = 60 * 60_000;
const FILE_LIMIT = 1024 * 1024;
const SKIP = new Set([".git", ".hg", ".svn", ".idea", ".vscode", "node_modules", "vendor", "build", "dist", "target", "coverage", ".next", ".cache", ".venv"]);
const COMPOSE_NAMES = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"];
const PRESETS: Preset[] = [
  { id: "symfony-docker", name: "Symfony in Docker", description: "Adopt a detected Symfony project and its existing Docker configuration." },
  { id: "laravel-docker", name: "Laravel in Docker", description: "Adopt a detected Laravel project and its existing Docker configuration." },
  { id: "node-docker", name: "Node backend with native frontend", description: "Adopt detected Node and Vite components with existing runtime configuration." },
  { id: "compose-existing", name: "Existing Compose", description: "Adopt services from an existing Compose project." },
  { id: "native", name: "Native", description: "Adopt a project with known local development commands." },
  { id: "custom", name: "Custom", description: "Inspect and adopt supported existing project metadata." },
];
type Snapshot = { path: string; hash: string };
type StoredPlan = { plan: SetupPlan; snapshots: Snapshot[]; inputsHash: string; state: "ready" | "running" | "complete" | "failed"; owner?: string; claimToken?: string; project?: Project };
type ComposeData = { files: string[]; services: string[]; projectName?: string; profiles: string[] };
type ScanContext = { entries: number; warnings: string[]; detections: Detection[]; depth: number };

function fail(message: string, code = "invalid", status = 400): never { throw new DevHubError(message, code, status); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function within(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeError(error: unknown): string { return error instanceof DevHubError ? error.message : "Metadata could not be read safely"; }
function regular(path: string): boolean { try { return lstatSync(path).isFile(); } catch { return false; } }
function readBounded(path: string): string {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > FILE_LIMIT) fail("Metadata file is not a bounded regular file", "invalid", 400);
  return readFileSync(path, "utf8");
}
function safeName(value: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "project"; }
function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function yamlData(text: string): Record<string, unknown> {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) fail("Compose metadata contains unsupported YAML", "invalid", 400);
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  let count = 0;
  const walk = (node: unknown, depth: number, seen: Set<object>) => {
    if (depth > 32 || ++count > 20000) fail("Compose metadata exceeds safe structural limits", "invalid", 400);
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) fail("Compose metadata contains a cyclic structure", "invalid", 400);
    seen.add(node);
    for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key], depth + 1, seen);
    seen.delete(node);
  };
  walk(value, 0, new Set());
  if (!plain(value)) fail("Compose metadata must be a YAML mapping", "invalid", 400);
  return value;
}
function validProjectId(id: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id); }
function portFromUrl(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); const n = Number(url.port || (url.protocol === "https:" ? 443 : 80)); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined; } catch { return undefined; }
}
function projectPorts(catalog: CatalogPort): Set<number> {
  const result = new Set<number>();
  const reserved = catalog.getRecord<number[]>("system", "reserved-ports");
  if (Array.isArray(reserved)) for (const value of reserved) if (Number.isInteger(value) && value > 0 && value < 65536) result.add(value);
  for (const project of catalog.listProjects()) for (const component of project.components) { const p = portFromUrl(component.url); if (p) result.add(p); }
  return result;
}
function processOwner(): string {
  try {
    const statText = readFileSync("/proc/self/stat", "utf8");
    const close = statText.lastIndexOf(")");
    const fields = statText.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const namespace = statSync("/proc/self/ns/pid").ino.toString();
    if (close < 0 || !startTime || !/^\d+$/.test(startTime) || !/^[\da-f-]{36}$/i.test(bootId) || !/^\d+$/.test(namespace)) throw new Error();
    return `${process.pid}:${startTime}:${bootId}:${namespace}`;
  } catch { fail("Cannot establish a stable local process identity", "process_identity_unavailable", 503); }
}
function fingerprint(path: string): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return "symlink";
  return st.isDirectory() ? hash(gitKind(dirname(path))) : st.isFile() ? hash(readFileSync(path).toString("base64")) : "other";
}
function parseEnvControls(path: string): void {
  if (!regular(path)) return;
  const text = readBounded(path);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(COMPOSE_[A-Za-z0-9_]+)\s*=/.exec(line);
    if (m && !["COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"].includes(m[1]!)) fail("Project .env contains an unsupported Compose control setting", "unsafe_environment", 409);
  }
}
function validateCommand(argv: string[]): void {
  const exact = (value: string[]) => argv.length === value.length && argv.every((x, i) => x === value[i]);
  if (exact(["docker", "context", "inspect", "--format", "json"]) || exact(["docker", "ps", "-a", "--format", "{{json .}}"] ) || exact(["ss", "-H", "-ltn"])) return;
  if (argv.length >= 3 && argv.length <= 502 && argv[0] === "docker" && argv[1] === "inspect" && argv.slice(2).every((id) => /^[a-fA-F0-9]{12,64}$/.test(id))) return;
  fail("Discovery attempted an unsupported inspection command", "unsafe_command", 403);
}
async function runReadOnly(run: Executor, argv: string[], cwd?: string) {
  validateCommand(argv);
  return run(argv, { cwd, timeoutMs: 5000, maxOutputBytes: 1024 * 1024 });
}
function composeFilesAt(dir: string): string[] { return COMPOSE_NAMES.filter((name) => regular(join(dir, name))).map((name) => join(dir, name)); }
function parseCompose(dir: string): ComposeData | undefined {
  const files = composeFilesAt(dir); if (!files.length) return undefined;
  const services: string[] = []; const profiles = new Set<string>();
  for (const file of files) {
    parseEnvControls(join(dir, ".env"));
    const data = yamlData(readBounded(file));
    if (!plain(data.services)) fail("Compose services metadata is missing or invalid", "invalid", 400);
    for (const [name, raw] of Object.entries(data.services)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name) || !plain(raw)) continue;
      if (!services.includes(name)) services.push(name);
      if (Array.isArray(raw.profiles)) for (const profile of raw.profiles) if (typeof profile === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(profile)) profiles.add(profile);
    }
  }
  if (!services.length) fail("Compose defines no supported services", "invalid", 400);
  return { files, services, profiles: [...profiles].sort() };
}
function gitKind(dir: string): Detection["git"] {
  const dot = join(dir, ".git");
  try {
    const st = lstatSync(dot);
    if (st.isSymbolicLink()) return "none";
    if (st.isDirectory()) return "repository";
    if (!st.isFile() || st.size > 4096) return "none";
    const pointer = readFileSync(dot, "utf8");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer);
    if (!match || !/^(?:\.\.\/)+[^\0]+\/worktrees\/[^/]+$/.test(match[1]!)) return "none";
    // A worktree pointer is sufficient classification evidence. Never follow it.
    return "worktree";
  } catch { return "none"; }
}
function candidateDirectories(root: string, depth: number, ctx: ScanContext): string[] {
  const found: string[] = [];
  const visit = (dir: string, level: number) => {
    if (ctx.entries >= 5000) { if (!ctx.warnings.includes("Scan stopped at 5000 directory entries")) ctx.warnings.push("Scan stopped at 5000 directory entries"); return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { ctx.warnings.push("Some approved paths could not be read"); return; }
    for (const ent of entries) {
      if (++ctx.entries > 5000) { ctx.warnings.push("Scan stopped at 5000 directory entries"); return; }
      if (ent.isSymbolicLink() || SKIP.has(ent.name) || ent.name.startsWith(".")) continue;
      if (!ent.isDirectory()) continue;
      const child = join(dir, ent.name);
      if (isProtected(child)) continue;
      if (level < depth) visit(child, level + 1);
    }
    if (found.length < 100 && (gitKind(dir) !== "none" || ["package.json", "composer.json", "pyproject.toml", "go.mod"].some((f) => regular(join(dir, f))) || composeFilesAt(dir).length)) found.push(dir);
  };
  visit(root, 0);
  if (found.length === 100) ctx.warnings.push("Scan stopped at 100 project detections");
  return found;
}
function isProtected(path: string): boolean {
  const configuredState = process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME)
    ? join(process.env.XDG_STATE_HOME, "devhub") : join(homedir(), ".local", "state", "devhub");
  const candidates = [resolve(import.meta.dir, "../.."), join(homedir(), ".local", "share", "devhub"), process.env.DEVHUB_DIR, configuredState].filter((x): x is string => Boolean(x));
  const target = resolve(path);
  return candidates.some((candidate) => { const protectedPath = resolve(candidate); return target === protectedPath || within(target, protectedPath); });
}
function projectMetadata(dir: string): { stacks: string[]; compose?: ComposeData; makeTargets: string[]; components: Component[] } {
  let pkg: unknown, composer: unknown;
  if (regular(join(dir, "package.json"))) pkg = parseJson(readBounded(join(dir, "package.json")));
  if (regular(join(dir, "composer.json"))) composer = parseJson(readBounded(join(dir, "composer.json")));
  const stacks = classifyManifests(pkg, composer);
  for (const file of ["pyproject.toml", "go.mod"]) if (regular(join(dir, file))) stacks.push(file === "go.mod" ? "go" : "python");
  const compose = parseCompose(dir);
  let makeTargets: string[] = [];
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) if (regular(join(dir, name))) { const parsed = parseMakeTargets(readBounded(join(dir, name))); makeTargets = parsed.targets; break; }
  const components: Component[] = [];
  if (compose) {
    const projectName = undefined;
    components.push({ id: "compose", name: "Compose", kind: "compose", cwd: dir, compose: { files: compose.files.map((f) => relative(dir, f)), projectName: projectName ?? "", profiles: compose.profiles, services: compose.services }, dependsOn: [] });
  }
  if (plain(pkg)) {
    const scripts = plain(pkg.scripts) ? pkg.scripts : {};
    const scriptNames = Object.keys(scripts);
    const vite = stacks.includes("vite");
    const script = vite ? (scriptNames.includes("dev") ? "dev" : undefined) : scriptNames.includes("start") ? "start" : undefined;
    if (script) components.push({ id: vite ? "frontend" : "node", name: vite ? "Frontend" : "Node", kind: "native", cwd: dir, argv: ["bun", "run", script, ...(vite ? ["--", "--port", "${PORT}", "--strictPort"] : [])], dependsOn: [], ...(vite ? { url: "http://127.0.0.1:${PORT}" } : {}) });
  }
  return { stacks: [...new Set(stacks)], compose, makeTargets, components };
}
function stableInput(input: SetupInput): string { return JSON.stringify({ path: input.path, name: input.name, preset: input.preset, id: input.id, composeProjectName: input.composeProjectName }); }

export class Discovery implements DiscoveryPort {
  constructor(private readonly options: { catalog: CatalogPort; run: Executor }) {}
  private get catalog() { return this.options.catalog; }
  /** Local context check plus one batched inspect of every container's labels. */
  private async containerLabels(): Promise<Array<Record<string, unknown>>> {
    const context = await runReadOnly(this.options.run, ["docker", "context", "inspect", "--format", "json"]);
    let contexts: unknown;
    try { contexts = JSON.parse(context.stdout); } catch { fail("Docker context evidence is unavailable or malformed", "inspection_unavailable", 503); }
    if (context.code !== 0 || !Array.isArray(contexts) || contexts.length === 0 || !contexts.every((c) => plain(c) && plain(c.Endpoints) && plain(c.Endpoints.docker) && typeof c.Endpoints.docker.Host === "string" && c.Endpoints.docker.Host.startsWith("unix:///"))) fail("Docker context must use a local Unix socket", "unsafe_docker_context", 409);
    const ps = await runReadOnly(this.options.run, ["docker", "ps", "-a", "--format", "{{json .}}"]);
    if (ps.code !== 0) fail("Docker container identity inspection failed", "inspection_unavailable", 503);
    const ids: string[] = [];
    for (const line of ps.stdout.split(/\r?\n/).filter(Boolean)) { const row = parseJson(line); if (plain(row) && typeof row.ID === "string" && /^[a-fA-F0-9]{12,64}$/.test(row.ID)) ids.push(row.ID); }
    if (!ids.length) return [];
    const inspected = await runReadOnly(this.options.run, ["docker", "inspect", ...ids.slice(0, 500)]);
    if (inspected.code !== 0) fail("Docker container identity inspection failed", "inspection_unavailable", 503);
    const body = parseJson(inspected.stdout);
    if (!Array.isArray(body)) fail("Docker container identity inspection failed", "inspection_unavailable", 503);
    return body.flatMap((item) => plain(item) && plain(item.Config) && plain(item.Config.Labels) ? [item.Config.Labels] : []);
  }
  private async detect(path: string, listeners?: Set<number>, labelCache?: { value?: Promise<Array<Record<string, unknown>>> }): Promise<Detection> {
    const canonical = this.catalog.assertAllowedPath(path, true);
    const dir = realpathSync(canonical);
    const st = lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) fail("Scan path must be a regular approved directory", "invalid", 400);
    const base = projectMetadata(dir);
    const metadata = { ...base, components: [...base.components], stacks: [...base.stacks], makeTargets: [...base.makeTargets] };
    const warnings: string[] = [];
    const childEntries = readdirSync(dir, { withFileTypes: true });
    if (childEntries.length > 5000) warnings.push("Child project scan stopped at 5000 directory entries");
    const childDirs = childEntries.slice(0, 5000).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !SKIP.has(entry.name)).map((entry) => join(dir, entry.name)).filter((child) => !isProtected(child)).sort();
    for (const child of childDirs) {
      const childData = projectMetadata(child);
      if (!childData.components.length) continue;
      metadata.stacks.push(...childData.stacks);
      metadata.makeTargets.push(...childData.makeTargets);
      for (const component of childData.components) {
        const prefix = safeName(basename(child)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "app";
        metadata.components.push({ ...component, id: `${prefix}-${component.id}`.slice(0, 64), name: `${basename(child)} ${component.name}` });
      }
    }
    metadata.stacks = [...new Set(metadata.stacks)];
    const composeComponents = metadata.components.filter((component) => component.kind === "compose");
    if (composeComponents.length) {
      const cache = labelCache ?? {};
      cache.value ??= this.containerLabels();
      const identities = new Set<string>();
      {
        for (const labels of await cache.value) {
          const workDir = labels["com.docker.compose.project.working_dir"];
          const configFiles = labels["com.docker.compose.project.config_files"];
          const associated = composeComponents.some((component) => {
            const componentDir = resolve(component.cwd);
            return (typeof workDir === "string" && resolve(workDir) === componentDir)
              || (typeof configFiles === "string" && configFiles.split(",").some((file) => component.compose!.files.some((composeFile) => resolve(componentDir, composeFile) === resolve(file))));
          });
          if (!associated) continue;
          const name = labels["com.docker.compose.project"];
          if (typeof name === "string" && ["devhub", "dev-infra", "devhub-infra", "dev-shared-net"].includes(name) || typeof name === "string" && name.startsWith("infra-")) fail("Protected DevHub Compose identity cannot be adopted", "unsafe_identity", 409);
          if (typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) identities.add(name);
        }
      }
      if (identities.size === 1) for (const component of composeComponents) component.compose!.projectName = [...identities][0]!;
      else if (identities.size > 1) warnings.push("Multiple existing Compose identities were found; provide composeProjectName to adopt explicitly");
      else warnings.push("No existing Compose identity was confirmed; provide composeProjectName to adopt explicitly");
      if (listeners) { const result = await runReadOnly(this.options.run, ["ss", "-H", "-ltn"]); if (result.code !== 0) fail("Host listener inventory is unavailable", "inspection_unavailable", 503); for (const m of result.stdout.matchAll(/:(\d+)(?:\s|$)/gm)) listeners.add(Number(m[1])); }
    }
    return { path: dir, name: basename(dir), git: gitKind(dir), stacks: metadata.stacks, composeFiles: composeComponents.flatMap((c) => c.compose!.files.map((f) => relative(dir, resolve(c.cwd, f)))), makeTargets: metadata.makeTargets, components: metadata.components, warnings };
  }
  async scan(path: string, depth = 4): Promise<Detection[]> {
    if (!Number.isInteger(depth) || depth < 0 || depth > 8) fail("Scan depth must be between 0 and 8");
    const root = this.catalog.assertAllowedPath(path, true);
    const canonical = realpathSync(root); const st = lstatSync(canonical);
    if (!st.isDirectory() || st.isSymbolicLink()) fail("Scan path must be an approved directory", "invalid", 400);
    if (isProtected(canonical)) fail("Protected DevHub paths cannot be scanned", "path_denied", 403);
    const context: ScanContext = { entries: 0, warnings: [], detections: [], depth };
    const dirs = candidateDirectories(canonical, depth, context);
    const detections: Detection[] = [];
    const labelCache: { value?: Promise<Array<Record<string, unknown>>> } = {};
    for (const dir of dirs) {
      try { const detection = await this.detect(dir, undefined, labelCache); detections.push(detection); }
      catch (error) {
        try {
          const metadata = projectMetadata(dir);
          detections.push({ path: dir, name: basename(dir), git: gitKind(dir), stacks: metadata.stacks, composeFiles: metadata.compose?.files.map((file) => relative(dir, file)) ?? [], makeTargets: metadata.makeTargets, components: metadata.components, warnings: [safeError(error)] });
        } catch { detections.push({ path: dir, name: basename(dir), git: gitKind(dir), stacks: [], composeFiles: [], makeTargets: [], components: [], warnings: [safeError(error)] }); }
      }
    }
    if (context.warnings.length && detections.length) detections[0]!.warnings.push(...context.warnings);
    return detections;
  }
  async inspect(path: string): Promise<Detection> { return this.detect(path); }
  presets(): Preset[] { return PRESETS.map((preset) => ({ ...preset })); }
  private async listeners(): Promise<Set<number>> {
    const result = await runReadOnly(this.options.run, ["ss", "-H", "-ltn"]);
    if (result.code !== 0) fail("Host listener inventory is unavailable", "inspection_unavailable", 503);
    const ports = new Set<number>();
    for (const match of result.stdout.matchAll(/:(\d+)(?:\s|$)/gm)) { const port = Number(match[1]); if (port > 0 && port < 65536) ports.add(port); }
    return ports;
  }
  async preview(input: SetupInput): Promise<SetupPlan> {
    if (!input || typeof input !== "object" || !PRESETS.some((p) => p.id === input.preset) || typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 128) fail("Invalid setup input");
    const root = this.catalog.assertAllowedPath(input.path, true); const canonical = realpathSync(root);
    if (isProtected(canonical)) fail("Protected DevHub paths cannot be registered", "path_denied", 403);
    const detection = await this.inspect(canonical);
    const id = input.id ?? safeName(input.name).toLowerCase();
    if (!validProjectId(id)) fail("Project ID must contain only letters, numbers, underscores, and hyphens");
    try { this.catalog.getProject(id); fail("Project ID is already registered", "conflict", 409); } catch (error) { if (!(error instanceof DevHubError) || error.code !== "not_found") throw error; }
    const preset = input.preset;
    if (preset === "symfony-docker" && !detection.stacks.includes("symfony")) fail("Symfony metadata was not detected", "unsupported_preset", 409);
    if (preset === "laravel-docker" && !detection.stacks.includes("laravel")) fail("Laravel metadata was not detected", "unsupported_preset", 409);
    if (preset === "node-docker" && !detection.stacks.includes("node")) fail("Node metadata was not detected", "unsupported_preset", 409);
    if (["symfony-docker", "laravel-docker", "node-docker", "compose-existing"].includes(preset) && !detection.composeFiles.length) fail("This preset requires an existing Compose configuration; no files were created", "manual_setup_required", 409);
    if (!detection.components.length) fail("No supported existing command or Compose service was found", "manual_setup_required", 409);
    let composeName = input.composeProjectName;
    const composeComponent = detection.components.find((c) => c.kind === "compose");
    if (composeComponent) {
      composeName ??= composeComponent.compose?.projectName;
      if (!composeName) fail("Compose project identity is ambiguous; provide composeProjectName explicitly", "compose_identity_required", 409);
      if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(composeName) || ["devhub", "dev-infra", "devhub-infra", "dev-shared-net"].includes(composeName) || composeName.startsWith("infra-")) fail("Compose project identity is reserved or invalid", "unsafe_identity", 409);
    }
    const files: PlannedFile[] = [];
    const components = detection.components.map((component) => {
      if (component.kind === "compose") return { ...component, compose: { ...component.compose!, projectName: composeName!, files: [...component.compose!.files] } };
      if (component.argv?.includes("${PORT}")) return component;
      return { ...component };
    });
    const listeners = await this.listeners();
    const reserved = projectPorts(this.catalog);
    const used = new Set([...listeners, ...reserved, 8040, 5175]);
    components.forEach((component, index) => {
      if (!component.argv?.includes("${PORT}")) return;
      let port = 5173;
      while (used.has(port) && port < 65536) port++;
      if (port >= 65536) fail("No available port for the Vite frontend", "port_unavailable", 409);
      used.add(port);
      components[index] = { ...component, argv: component.argv!.map((arg) => arg === "${PORT}" ? String(port) : arg), url: `http://127.0.0.1:${port}` };
    });
    const project: ProjectInput = { id, name: input.name.trim(), root: canonical, components };
    const snapshots = this.snapshot(canonical, detection, files);
    const plan: SetupPlan = { id: randomUUID(), project: structuredClone(project), files: structuredClone(files), warnings: [...detection.warnings], createdAt: new Date().toISOString() };
    this.pruneExpiredPlans();
    if (this.catalog.listRecords<StoredPlan>(PLAN_NS).length >= PLAN_LIMIT) fail("Setup plan storage is full; remove old plans through the catalog before creating another", "plan_storage_full", 507);
    const stored: StoredPlan = { plan: structuredClone(plan), snapshots, inputsHash: hash(stableInput({ ...input, path: canonical })), state: "ready" };
    try { this.catalog.putRecord(PLAN_NS, plan.id, stored); }
    catch { fail("Unable to store setup plan in the catalog", "plan_storage_failed", 507); }
    return structuredClone(plan);
  }
  /** Plans are short-lived approvals: anything not being applied expires after an hour. */
  private pruneExpiredPlans(): void {
    const cutoff = Date.now() - PLAN_TTL_MS;
    for (const stored of this.catalog.listRecords<StoredPlan>(PLAN_NS)) {
      const created = Date.parse(stored?.plan?.createdAt ?? "");
      if (stored?.plan?.id && stored.state !== "running" && (!Number.isFinite(created) || created < cutoff)) {
        try { this.catalog.deleteRecord(PLAN_NS, stored.plan.id); } catch { /* a concurrent writer may have removed it */ }
      }
    }
  }
  private snapshot(root: string, detection: Detection, files: PlannedFile[]): Snapshot[] {
    const paths = new Set<string>();
    const add = (p: string) => paths.add(resolve(root, p));
    const directories = new Set([root, ...detection.components.map((component) => component.cwd)]);
    for (const directory of directories) {
      for (const name of [".git", "package.json", "composer.json", "pyproject.toml", "go.mod", "Makefile", "makefile", "GNUmakefile", ".env", ...COMPOSE_NAMES]) {
        const path = join(directory, name);
        if (existsSync(path)) paths.add(resolve(path));
      }
    }
    for (const file of detection.composeFiles) add(file);
    for (const path of files) add(path.path);
    return [...paths].map((path) => ({ path, hash: existsSync(path) ? fingerprint(path) : "absent" }));
  }
  async apply(planId: string): Promise<Project> {
    const stored = this.catalog.getRecord<StoredPlan>(PLAN_NS, planId);
    if (!stored || stored.plan.id !== planId) fail("Setup plan is unknown or expired", "plan_not_found", 404);
    if (stored.state === "complete" && stored.project) return structuredClone(stored.project);
    if (stored.state !== "ready") fail("Setup plan cannot be replayed after an interrupted or failed apply; create a new preview", "plan_unavailable", 409);
    const owner = processOwner(); const claimToken = randomUUID();
    const claimed = this.catalog.updateRecord<StoredPlan>(PLAN_NS, planId, (current) => {
      if (!current || current.state !== "ready") return current ?? stored;
      return { ...current, state: "running", owner, claimToken };
    });
    if (claimed.state !== "running" || claimed.claimToken !== claimToken) fail("Setup plan is already being applied", "plan_unavailable", 409);
    const current = claimed;
    const root = this.catalog.assertAllowedPath(current.plan.project.root, true);
    for (const file of current.plan.files) {
      const target = resolve(root, file.path);
      if (!within(target, root) || target === root) { this.markFailed(planId, current); fail("Planned file path escapes the approved project root", "unsafe_path", 409); }
      if (existsSync(target)) { this.markFailed(planId, current); fail("A planned file already exists; no files were overwritten", "file_conflict", 409); }
    }
    this.revalidate(current, root);
    const listeners = await this.listeners();
    const reserved = projectPorts(this.catalog);
    for (const component of current.plan.project.components) {
      const port = portFromUrl(component.url);
      if (port && (listeners.has(port) || reserved.has(port))) { this.markFailed(planId, current); fail("A planned project port is no longer available", "port_conflict", 409); }
    }
    let already: Project | undefined;
    try { already = this.catalog.getProject(current.plan.project.id); } catch (error) { if (!(error instanceof DevHubError) || error.code !== "not_found") throw error; }
    if (already) { this.markFailed(planId, current); fail("Project ID is already registered", "conflict", 409); }
    const createdFiles: Array<{ path: string; dev: number; ino: number }> = [];
    const createdDirs: string[] = [];
    try {
      for (const file of current.plan.files) this.createExclusive(root, file, createdFiles, createdDirs);
    } catch (error) {
      this.rollback(createdFiles, createdDirs); this.markFailed(planId, current); throw error;
    }
    let project: Project;
    try { project = this.catalog.createProject(structuredClone(current.plan.project)); }
    catch (error) {
      try {
        const registered = this.catalog.getProject(current.plan.project.id);
        if (registered && registered.id === current.plan.project.id && registered.root === current.plan.project.root
          && registered.name === current.plan.project.name && JSON.stringify(registered.components) === JSON.stringify(current.plan.project.components)) {
          this.markComplete(planId, current, registered); return registered;
        }
      } catch (readError) {
        if (!(readError instanceof DevHubError) || readError.code !== "not_found") {
          this.markUncertain(planId, current);
          fail(`Project registration outcome is uncertain; created files were preserved (${safeError(readError)})`, "registration_uncertain", 503);
        }
      }
      this.rollback(createdFiles, createdDirs); this.markFailed(planId, current); throw error;
    }
    try { this.markComplete(planId, current, project); }
    catch { fail("Project was registered, but plan completion could not be recorded; files were preserved", "registration_uncertain", 503); }
    return structuredClone(project);
  }
  private revalidate(stored: StoredPlan, root: string): void {
    for (const snapshot of stored.snapshots) {
      if (!within(snapshot.path, root)) fail("Setup plan contains a path outside its project root", "stale_plan", 409);
      let actual = "absent";
      try { actual = fingerprint(snapshot.path); if (actual === "symlink") fail("Setup plan path became a symlink", "stale_plan", 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (actual !== snapshot.hash) fail("Setup plan is stale; metadata changed after preview", "stale_plan", 409);
    }
  }
  private createExclusive(root: string, file: PlannedFile, createdFiles: Array<{ path: string; dev: number; ino: number }>, createdDirs: string[]): void {
    const target = resolve(root, file.path);
    if (!within(target, root) || target === root) fail("Planned file path escapes the approved project root", "unsafe_path", 409);
    this.catalog.assertAllowedPath(target, false);
    let parent = dirname(target); const missing: string[] = [];
    while (!existsSync(parent)) { missing.unshift(parent); parent = dirname(parent); if (!within(parent, root)) fail("Planned directory escapes project root", "unsafe_path", 409); }
    for (let cursor = root; within(cursor, parent); cursor = join(cursor, relative(cursor, parent).split(sep)[0] ?? "")) {
      const st = lstatSync(cursor); if (st.isSymbolicLink() || !st.isDirectory()) fail("Planned path has an unsafe ancestor", "unsafe_path", 409);
      if (cursor === parent) break;
    }
    for (const dir of missing) { mkdirSync(dir); createdDirs.push(dir); }
    let fd: number;
    try { fd = openSync(target, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("A planned file already exists; no files were overwritten", "file_conflict", 409); throw error; }
    try { const st = fstatSync(fd); createdFiles.push({ path: target, dev: st.dev, ino: st.ino }); writeFileSync(fd, file.content, "utf8"); }
    finally { closeSync(fd); }
  }
  private rollback(files: Array<{ path: string; dev: number; ino: number }>, dirs: string[]): void {
    for (const file of [...files].reverse()) try { const st = lstatSync(file.path); if (st.isFile() && !st.isSymbolicLink() && st.dev === file.dev && st.ino === file.ino) unlinkSync(file.path); } catch {}
    for (const dir of [...dirs].reverse()) try { if (lstatSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir); } catch {}
  }
  private markFailed(id: string, stored: StoredPlan): void { try { this.catalog.updateRecord<StoredPlan>(PLAN_NS, id, (current) => ({ ...(current ?? stored), state: "failed" })); } catch {} }
  private markUncertain(id: string, stored: StoredPlan): void { try { this.catalog.updateRecord<StoredPlan>(PLAN_NS, id, (current) => ({ ...(current ?? stored), state: "failed" })); } catch {} }
  private markComplete(id: string, stored: StoredPlan, project: Project): void { this.catalog.updateRecord<StoredPlan>(PLAN_NS, id, (current) => ({ ...(current ?? stored), state: "complete", project: structuredClone(project) })); }
}
