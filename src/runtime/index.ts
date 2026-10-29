import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { DevHubError, type CatalogPort, type Component, type ContainerInfo, type Executor, type LogEntry, type Project, type RuntimePort, type ComponentStatus } from "../contracts";

type Options = { run: Executor; stateDir: string; assertAllowedPath: CatalogPort["assertAllowedPath"]; fetch?: (input: string, init?: BunFetchRequestInit) => Promise<Response>; resolveExecutable?: (command: string) => string | null };
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[a-f0-9]{12,64}$/;
const PROTECTED = new Set(["devhub", "dev-infra", "devhub-infra", "dev-shared-net"]);
const TIME = { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 } as const;
const READ = { timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024 } as const;
const within = (path: string, root: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const err = (message: string, code = "invalid", status = 400) => new DevHubError(message, code, status);
const outputJson = (value: string): unknown => { try { return JSON.parse(value); } catch { throw err("Runtime tool returned malformed JSON", "runtime_output", 502); } };
const slug = (value: string, field: string) => { if (!SLUG.test(value) || [...PROTECTED].some((item) => item.toLowerCase() === value.toLowerCase()) || value.toLowerCase().startsWith("infra-")) throw err(`Invalid or protected ${field}`, "unsafe_runtime", 403); return value; };

function componentId(project: Project, component: Component): string { return `${project.id}:${component.id}`; }
function canonical(path: string, mustExist = true): string {
  const abs = resolve(path);
  if (!isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw err("Runtime path must be an absolute canonical path");
  try { return realpathSync(abs); } catch (e) {
    if (mustExist || (e as NodeJS.ErrnoException).code !== "ENOENT") throw err(`Runtime path does not exist: ${abs}`);
    return abs;
  }
}
function parseJsonLines(text: string): Record<string, unknown>[] {
  const s = text.trim(); if (!s) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch {
    try { parsed = s.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
    catch { throw err("Runtime tool returned malformed JSON", "runtime_output", 502); }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (!items.every((x) => x && typeof x === "object" && !Array.isArray(x))) throw err("Runtime tool returned invalid records", "runtime_output", 502);
  return items as Record<string, unknown>[];
}
function labels(record: Record<string, unknown>): Record<string, string> {
  const raw = record.Labels ?? record.labels;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
  if (typeof raw === "string") {
    // docker --format json joins labels with commas, and config_files values contain commas too.
    const out: Record<string, string> = {}; let last: string | undefined;
    for (const part of raw.split(",")) {
      const i = part.indexOf("=");
      if (i > 0 && /^[A-Za-z0-9._/-]+$/.test(part.slice(0, i))) { last = part.slice(0, i); out[last] = part.slice(i + 1); }
      else if (last !== undefined) out[last] += `,${part}`;
    }
    return out;
  }
  return {};
}
function assertLocalBus(): void {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !isAbsolute(runtime) || typeof process.getuid !== "function") throw err("A local systemd user session is required", "runtime_unavailable", 503);
  const info = lstatSync(runtime);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || realpathSync(runtime) !== runtime) throw err("Unsafe user runtime directory", "unsafe_runtime", 403);
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (bus && bus !== `unix:path=${join(runtime, "bus")}` && !new RegExp(`^unix:path=${join(runtime, "bus").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},guid=[a-fA-F0-9]{32}$`).test(bus)) throw err("Only the local user D-Bus session is supported", "unsafe_runtime", 403);
}
function escapeUnit(value: string): string {
  if (/[\0\r\n]/.test(value)) throw err("Newlines and NUL are not valid systemd unit values");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}
function unitPath(value: string): string {
  if (/[\0\r\n]/.test(value) || !isAbsolute(value)) throw err("Unit paths must be absolute single-line values");
  return value.replace(/%/g, "%%");
}
function showProperties(stdout: string): Record<string, string> {
  return Object.fromEntries(stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
function envFileCheck(file: string, root: string): void {
  const path = canonical(file);
  if (!within(path, root)) throw err("Environment file must stay inside the project root", "unsafe_path", 403);
  const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw err("Environment file must be a regular file");
}
function checkEnvControls(cwd: string): void {
  const path = join(cwd, ".env");
  let info; try { info = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || realpathSync(path) !== path) throw err("Compose .env must be a canonical regular file no larger than 1 MiB");
  const text = readFileSync(path, "utf8");
  const execution = new Set(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_DEFAULT_PLATFORM", "DOCKER_BUILDKIT"]);
  for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
    const key = match[1]!;
    if ((key.startsWith("COMPOSE_") && key !== "COMPOSE_PROJECT_NAME" && key !== "COMPOSE_PROFILES") || execution.has(key)) throw err(`Compose .env setting ${key} is not allowed`, "unsafe_environment", 403);
  }
}

export class Runtime implements RuntimePort {
  private readonly run: Executor;
  private readonly stateDir: string;
  private readonly assertAllowedPath: CatalogPort["assertAllowedPath"];
  private readonly fetcher: NonNullable<Options["fetch"]>;
  private readonly resolver: NonNullable<Options["resolveExecutable"]>;
  private seq = 0;

  constructor(options: Options) {
    this.run = options.run; this.stateDir = resolve(options.stateDir); this.assertAllowedPath = options.assertAllowedPath;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init)); this.resolver = options.resolveExecutable ?? ((command) => Bun.which(command));
  }
  private validate(project: Project, component: Component): { root: string; cwd: string } {
    if (!project || !component || !Array.isArray(project.components) || !project.components.some((c) => c.id === component.id)) throw err("Component is not part of this project");
    const root = this.assertAllowedPath(project.root, true);
    const cwd = this.assertAllowedPath(component.cwd, true);
    if (!within(canonical(cwd), canonical(root))) throw err("Component working directory must stay inside project root", "unsafe_path", 403);
    const protectedPaths = [resolve(import.meta.dir, "../.."), this.stateDir, process.env.DEVHUB_DIR, join(resolve(process.env.HOME || homedir()), ".local/share/devhub")].filter((x): x is string => !!x).map((p) => resolve(p));
    for (const p of protectedPaths) if (within(canonical(cwd), canonical(p, false)) || within(canonical(p, false), canonical(cwd))) throw err("Runtime target overlaps protected DevHub data", "unsafe_path", 403);
    if (!SLUG.test(project.id) || !SLUG.test(component.id) || !component.name) throw err("Invalid component identity");
    return { root: canonical(root), cwd: canonical(cwd) };
  }
  private async dockerContext(): Promise<void> {
    const result = await this.run(["docker", "context", "inspect", "--format", "json"], READ);
    if (result.code !== 0) throw err("Unable to verify the local Docker context", "docker_context", 503);
    const items = parseJsonLines(result.stdout);
    if (!items.length || !items.every((x) => { const host = (x.Endpoints as Record<string, unknown> | undefined)?.docker && ((x.Endpoints as Record<string, Record<string, unknown>>).docker.Host); return typeof host === "string" && /^unix:\/\//.test(host) && host.length > 7 && host.slice(7).startsWith("/"); })) throw err("Docker context must use a local Unix socket", "unsafe_runtime", 403);
  }
  private composeBase(project: Project, component: Component, cwd: string): string[] {
    const cfg = component.compose; if (!cfg || !cfg.files.length || !cfg.services.length) throw err("Compose component requires files and explicit services");
    slug(cfg.projectName, "Compose project name");
    const files = cfg.files.map((file) => { const path = this.assertAllowedPath(resolve(cwd, file), true); if (!within(canonical(path), canonical(project.root))) throw err("Compose file must stay inside project root", "unsafe_path", 403); const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink()) throw err("Compose file must be a regular file"); return canonical(path); });
    for (const profile of cfg.profiles) slug(profile, "Compose profile"); for (const service of cfg.services) slug(service, "Compose service");
    checkEnvControls(cwd);
    for (const file of component.envFiles ?? []) envFileCheck(resolve(cwd, file), canonical(project.root));
    return ["docker", "compose", "-p", cfg.projectName, `--project-directory=${cwd}`, ...files.map((f) => `--file=${f}`), ...cfg.profiles.map((p) => `--profile=${p}`)];
  }
  private preflightCompose(project: Project, component: Component, cwd: string): void {
    checkEnvControls(cwd);
    const root = canonical(project.root); let files = 0, bytes = 0; const visited = new Set<string>(), active = new Set<string>();
    const visit = (path: string, depth: number) => {
      if (depth > 8) throw err("Compose include depth exceeds 8", "unsafe_compose", 403);
      const resolved = canonical(path); if (!within(resolved, root)) throw err("Compose references must stay inside project root", "unsafe_path", 403);
      if (active.has(resolved)) throw err("Compose include cycle detected", "unsafe_compose", 403);
      if (visited.has(resolved)) return;
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw err("Compose file must be a regular file no larger than 1 MiB");
      files++; bytes += stat.size; if (files > 100 || bytes > 8 * 1024 * 1024) throw err("Compose document limit exceeded");
      const source = readFileSync(resolved, "utf8"), doc = parseDocument(source, { uniqueKeys: true });
      if (doc.errors.length) throw err("Compose YAML is invalid", "unsafe_compose", 400);
      active.add(resolved); visited.add(resolved);
      const walk = (node: unknown) => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        if ("include" in record) {
          const value = record.include;
          for (const item of (Array.isArray(value) ? value : [value])) {
            const entry = typeof item === "string" ? item : item && typeof item === "object" ? (item as Record<string, unknown>).path : undefined;
            if (typeof entry !== "string" || /^(?:[a-z]+:\/\/|git@)/i.test(entry) || /\$\{[^}]+\}/.test(entry)) throw err("Remote or unresolved Compose include is not allowed", "unsafe_compose", 403);
            visit(resolve(dirname(resolved), entry), depth + 1);
          }
        }
        if ("extends" in record) {
          const value = record.extends;
          if (value && typeof value === "object" && "file" in value) {
            const ext = (value as Record<string, unknown>).file;
            if (typeof ext !== "string" || /^(?:[a-z]+:\/\/|git@)/i.test(ext) || /\$\{[^}]+\}/.test(ext)) throw err("Remote or unresolved Compose extends is not allowed", "unsafe_compose", 403);
            visit(resolve(dirname(resolved), ext), depth + 1);
          }
        }
        for (const key of ["env_file", "label_file"]) if (key in record) {
          const raw = record[key];
          for (const item of (Array.isArray(raw) ? raw : [raw])) {
            const name = typeof item === "string" ? item : item && typeof item === "object" ? (item as Record<string, unknown>).path : undefined;
            if (typeof name !== "string" || /\$\{[^}]+\}/.test(name) || isAbsolute(name)) throw err(`Unresolved or absolute Compose ${key} path`, "unsafe_compose", 403);
            const target = resolve(dirname(resolved), name), real = canonical(target);
            if (!within(real, root) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw err(`Compose ${key} must resolve to a project file`, "unsafe_compose", 403);
          }
        }
        if (record.privileged === true || "devices" in record || record.userns_mode === "host" || record.cgroup_parent || record.cgroup) throw err("Privileged Compose settings are not allowed", "unsafe_compose", 403);
        for (const key of ["network_mode", "ipc", "pid"]) if (typeof record[key] === "string" && /^(?:host|container:)/.test(record[key] as string)) throw err("Host and container namespace sharing is not allowed", "unsafe_compose", 403);
        if ("volumes_from" in record) throw err("Compose volumes_from is not allowed", "unsafe_compose", 403);
        if ("include" in record) { /* Include paths are handled above. */ }
        if ("driver_opts" in record && record.driver_opts && typeof record.driver_opts === "object") {
          const device = (record.driver_opts as Record<string, unknown>).device;
          if (typeof device === "string" && (device.includes("${") || !isAbsolute(device))) throw err("Unresolved Compose driver device path", "unsafe_compose", 403);
        }
        if ("build" in record && typeof record.build === "string" && /^(?:https?:|git@|\$\{)/i.test(record.build)) throw err("Remote Compose build inputs are not allowed", "unsafe_compose", 403);
        if ("network" in record && typeof record.network === "string" && (record.network.toLowerCase().startsWith("infra-") || PROTECTED.has(record.network.toLowerCase()))) throw err("Protected Compose network references are not allowed", "unsafe_compose", 403);
        Object.values(record).forEach(walk);
      };
      walk(doc.toJS()); active.delete(resolved);
    };
    for (const file of component.compose!.files) visit(resolve(cwd, file), 1);
  }
  private async composeRecords(project: Project, component: Component, cwd: string): Promise<Record<string, unknown>[]> {
    const base = this.composeBase(project, component, cwd);
    const result = await this.run([...base, "ps", "-a", "--format", "json"], READ);
    if (result.code !== 0) throw err("Compose ownership check failed", "runtime_ownership", 403);
    const records = parseJsonLines(result.stdout);
    const selected = records.filter((rec) => component.compose!.services.includes(String(labels(rec)["com.docker.compose.service"] ?? "")));
    for (const rec of selected) {
      const l = labels(rec);
      if (String(l["com.docker.compose.project"] ?? "") !== component.compose!.projectName) throw err("Compose found an unmatched container for this project identity", "runtime_ownership", 403);
      const wd = l["com.docker.compose.project.working_dir"], config = l["com.docker.compose.project.config_files"];
      if (!wd || !config || canonical(wd) !== cwd || config.split(",").some((f) => !component.compose!.files.some((known) => canonical(resolve(cwd, known)) === canonical(f)))) throw err("Compose container ownership labels do not match", "runtime_ownership", 403);
    }
    return selected;
  }
  private async nativeUnit(project: Project, component: Component, cwd: string, write: boolean): Promise<{ name: string; path: string; owner: string }> {
    if (!component.argv?.length) throw err("Native component requires a command");
    if (component.limits && ((component.limits.memoryMb !== undefined && (!Number.isFinite(component.limits.memoryMb) || component.limits.memoryMb < 1)) || (component.limits.cpuPercent !== undefined && (!Number.isFinite(component.limits.cpuPercent) || component.limits.cpuPercent <= 0 || component.limits.cpuPercent > 100)) || (component.limits.tasks !== undefined && (!Number.isSafeInteger(component.limits.tasks) || component.limits.tasks < 1)))) throw err("Invalid native resource limits");
    const executable = this.resolver(component.argv[0]!);
    if (!executable || !isAbsolute(executable)) throw err("Native executable could not be resolved", "runtime_executable", 400);
    const args = [executable, ...component.argv.slice(1)];
    const hash = createHash("sha256").update(`${project.id}\0${component.id}`).digest("hex").slice(0, 20);
    const name = `devhub-${hash}.service`, dir = join(this.stateDir, "units"), path = join(dir, name), owner = `${project.id}/${component.id}`;
    if (!write) return { name, path, owner };
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    const ownerMarker = `# DevHub-Owner=${owner}`;
    const lines = [ownerMarker, "[Unit]", `Description=${component.name.replace(/[\0\r\n]/g, " ").replace(/%/g, "%%")}`, "[Service]", "Type=exec", `WorkingDirectory=${unitPath(cwd)}`, `ExecStart=${args.map(escapeUnit).join(" ")}`, "KillMode=control-group", "Restart=on-failure", "RestartSec=3s", "StartLimitIntervalSec=60s", "StartLimitBurst=3"];
    for (const ef of component.envFiles ?? []) { const file = resolve(cwd, ef); envFileCheck(file, canonical(project.root)); lines.push(`EnvironmentFile=${unitPath(canonical(file))}`); }
    if (component.limits?.memoryMb) lines.push(`MemoryMax=${component.limits.memoryMb}M`);
    if (component.limits?.tasks) lines.push(`TasksMax=${component.limits.tasks}`);
    if (component.limits?.cpuPercent) lines.push(`CPUQuota=${component.limits.cpuPercent}%`);
    lines.push("");
    let existing: string | undefined;
    try { const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink()) throw err("Refusing to overwrite an unowned systemd unit", "runtime_ownership", 403); existing = readFileSync(path, "utf8"); }
    catch (error) { if (error instanceof DevHubError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing !== undefined && !existing.startsWith(`${ownerMarker}\n`)) throw err("Refusing to overwrite an unowned systemd unit", "runtime_ownership", 403);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, lines.join("\n"), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    return { name, path, owner };
  }
  private async unitOwned(unit: { name: string; path: string; owner?: string }, allowMissing = false): Promise<boolean> {
    const result = await this.run(["systemctl", "--user", "show", unit.name, "--property=LoadState,FragmentPath,DropInPaths"], READ);
    if (result.code !== 0) return false;
    const props = showProperties(result.stdout);
    const load = props.LoadState ?? "", fragment = props.FragmentPath ?? "", drops = props.DropInPaths ?? "";
    if (load === "not-found" && fragment === "" && (drops === "" || drops === "[]")) return allowMissing;
    const fragmentIsOurs = fragment === unit.path || (() => { try { return realpathSync(fragment) === realpathSync(unit.path); } catch { return false; } })();
    return load === "loaded" && fragmentIsOurs && (drops === "" || drops === "[]") && (() => { try { return readFileSync(unit.path, "utf8").startsWith(`# DevHub-Owner=${unit.owner}\n`); } catch { return false; } })();
  }
  async start(project: Project, component: Component): Promise<void> {
    const { cwd } = this.validate(project, component);
    if (component.kind === "compose") {
      this.preflightCompose(project, component, cwd);
      await this.dockerContext(); await this.composeRecords(project, component, cwd);
      const base = this.composeBase(project, component, cwd);
      const config = await this.run([...base, "config", "--format", "json", "--no-env-resolution", ...component.compose!.services], { timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 });
      if (config.code !== 0) throw err("Compose configuration validation failed", "runtime_config", 400);
      const model = outputJson(config.stdout) as { services?: Record<string, unknown> };
      if (!model.services || component.compose!.services.some((s) => !model.services![s])) throw err("Selected service is absent from the Compose model");
      const up = await this.run([...base, "up", "-d", "--no-deps", ...component.compose!.services], { timeoutMs: 900_000, maxOutputBytes: 8 * 1024 * 1024 });
      if (up.code !== 0) throw err("Compose start failed", "runtime_start", 502);
      return;
    }
    if (component.kind !== "native") throw err("Unsupported runtime kind");
    assertLocalBus();
    const unit = await this.nativeUnit(project, component, cwd, true);
    if (!(await this.unitOwned(unit, true))) throw err("Refusing to overwrite an unowned systemd unit", "runtime_ownership", 403);
    for (const args of [["systemctl", "--user", "link", "--runtime", "--force", unit.path], ["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "start", unit.name]]) {
      const result = await this.run(args, TIME); if (result.code !== 0) throw err("systemd user service start failed", "runtime_start", 502);
    }
  }
  async stop(project: Project, component: Component): Promise<void> {
    const { cwd } = this.validate(project, component);
    if (component.kind === "compose") {
      this.preflightCompose(project, component, cwd);
      await this.dockerContext(); await this.composeRecords(project, component, cwd);
      const result = await this.run([...this.composeBase(project, component, cwd), "stop", ...component.compose!.services], TIME);
      if (result.code !== 0) throw err("Compose stop failed", "runtime_stop", 502); return;
    }
    if (component.kind !== "native") throw err("Unsupported runtime kind");
    assertLocalBus(); const unit = await this.nativeUnit(project, component, cwd, false);
    if (!(await this.unitOwned(unit))) throw err("Refusing to control an unowned systemd unit", "runtime_ownership", 403);
    const result = await this.run(["systemctl", "--user", "stop", unit.name], TIME);
    if (result.code !== 0) throw err("systemd user service stop failed", "runtime_stop", 502);
  }
  async check(project: Project, component: Component): Promise<ComponentStatus> {
    const { cwd } = this.validate(project, component);
    let running = false, detail: string | undefined;
    if (component.kind === "compose") {
      this.preflightCompose(project, component, cwd);
      await this.dockerContext(); const records = await this.composeRecords(project, component, cwd);
      running = component.compose!.services.every((service) => records.some((r) => labels(r)["com.docker.compose.service"] === service && String(r.State ?? r.state).toLowerCase() === "running"));
    } else if (component.kind === "native") {
      assertLocalBus(); const unit = await this.nativeUnit(project, component, cwd, false);
      if (!(await this.unitOwned(unit))) return { componentId: component.id, state: "stopped", ready: false };
      const result = await this.run(["systemctl", "--user", "show", unit.name, "--property=ActiveState,SubState"], READ);
      if (result.code !== 0) throw err("systemd status failed", "runtime_status", 502);
      running = showProperties(result.stdout).ActiveState === "active";
    } else throw err("Unsupported runtime kind");
    let ready = running;
    if (running && component.health?.url) { ready = await this.probe(component.health.url); if (!ready) detail = "Health probe did not return a successful response"; }
    return { componentId: component.id, state: running ? (ready ? "running" : "unhealthy") : "stopped", ready, ...(detail ? { detail } : {}), ...(component.url ? { url: component.url } : {}) };
  }
  private async probe(raw: string): Promise<boolean> {
    let url: URL; try { url = new URL(raw); } catch { throw err("Invalid health URL"); }
    if (!(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password)) throw err("Health checks must use loopback URLs", "unsafe_health_url", 403);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const proxy = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some((key) => !!process.env[key]);
    const np = process.env.no_proxy || process.env.NO_PROXY || "";
    const allowed = np.split(",").map((x) => x.trim()).some((x) => x === "*" || x === hostname);
    if (proxy && !allowed) throw err("Health checks require an exact loopback NO_PROXY entry", "unsafe_health_url", 403);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3_000);
    try { const response = await this.fetcher(url.toString(), { method: "GET", redirect: "manual", signal: controller.signal, proxy: false }); await response.body?.cancel(); return response.status >= 200 && response.status < 300; }
    catch { return false; } finally { clearTimeout(timer); }
  }
  async logs(project: Project, component: Component, limit = 100): Promise<LogEntry[]> {
    const { cwd } = this.validate(project, component); const count = Math.max(1, Math.min(1000, Math.trunc(limit)));
    let result: Awaited<ReturnType<Executor>>;
    if (component.kind === "compose") {
      this.preflightCompose(project, component, cwd);
      await this.dockerContext(); const records = await this.composeRecords(project, component, cwd);
      const ids = records.filter((r) => component.compose!.services.includes(String(labels(r)["com.docker.compose.service"]))).map((r) => String(r.ID ?? r.Id ?? ""));
      if (ids.some((id) => !ID.test(id))) throw err("Invalid container identifier in Compose output", "runtime_output", 502);
      if (!ids.length) return [];
      const outputs: string[] = [];
      for (const id of ids) {
        const one = await this.run(["docker", "logs", "--timestamps", "--tail", String(count), id], READ);
        if (one.code !== 0) throw err("Runtime log read failed", "runtime_logs", 502);
        outputs.push(one.stdout, one.stderr);
      }
      result = { code: 0, stdout: outputs.join("\n"), stderr: "" };
    } else if (component.kind === "native") {
      assertLocalBus(); const unit = await this.nativeUnit(project, component, cwd, false);
      if (!(await this.unitOwned(unit))) throw err("Refusing to read logs for an unowned systemd unit", "runtime_ownership", 403);
      result = await this.run(["journalctl", "--user", "--unit", unit.name, "--no-pager", "--output=json", "--lines", String(count)], READ);
    } else throw err("Unsupported runtime kind");
    if (result.code !== 0) throw err("Runtime log read failed", "runtime_logs", 502);
    const entries: LogEntry[] = [];
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      if (component.kind === "native") {
        const row = outputJson(line) as Record<string, string>;
        const cursor = row.__CURSOR ?? ""; const msg = row.MESSAGE ?? "";
        entries.push({ seq: ++this.seq, time: new Date(Number(row.__REALTIME_TIMESTAMP ?? 0) / 1000).toISOString(), projectId: project.id, componentId: component.id, stream: "stdout", message: msg, sourceId: cursor || `${row.__REALTIME_TIMESTAMP}:${row._BOOT_ID}` });
      } else {
        const match = /^(\S+)\s(.*)$/.exec(line); const time = match?.[1] ?? new Date(0).toISOString();
        entries.push({ seq: ++this.seq, time, projectId: project.id, componentId: component.id, stream: "stdout", message: match?.[2] ?? line, sourceId: `${time}:${createHash("sha256").update(line).digest("hex").slice(0, 12)}` });
      }
    }
    if (component.kind === "compose") entries.sort((a, b) => a.time.localeCompare(b.time));
    return entries.slice(-count);
  }
  async inventory(projects: Project[]): Promise<ContainerInfo[]> {
    await this.dockerContext();
    const ps = await this.run(["docker", "ps", "-a", "--no-trunc", "--format", "json"], READ);
    if (ps.code !== 0) throw err("Docker inventory failed", "runtime_inventory", 502);
    const rows = parseJsonLines(ps.stdout);
    const ids = rows.map((row) => String(row.ID ?? row.Id ?? ""));
    if (ids.some((id) => !ID.test(id))) throw err("Invalid container identifier", "runtime_output", 502);
    if (!ids.length) return [];
    // One inspect and one stats call for the whole set: per-container calls cost seconds each.
    const detail = await this.run(["docker", "inspect", ...ids], READ);
    if (detail.code !== 0) throw err("Docker inspect failed", "runtime_inventory", 502);
    const inspected = new Map(parseJsonLines(detail.stdout).map((item) => [String(item.Id ?? item.ID ?? ""), item]));
    const stats = await this.run(["docker", "stats", "--no-stream", "--no-trunc", "--format", "json", ...ids], READ);
    const usage = new Map<string, { memoryBytes?: number; cpuPercent?: number }>();
    if (stats.code === 0 && stats.stdout.trim()) for (const stat of parseJsonLines(stats.stdout)) {
      const id = String(stat.ID ?? stat.Container ?? ""); const entry: { memoryBytes?: number; cpuPercent?: number } = {};
      const m = /([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)/.exec(String(stat.MemUsage ?? ""));
      if (m) entry.memoryBytes = Math.round(Number(m[1]) * ({ B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3 }[m[2]!] ?? 1));
      const cpu = parseFloat(String(stat.CPUPerc ?? "")); if (Number.isFinite(cpu)) entry.cpuPercent = cpu;
      usage.set(id, entry);
    }
    const sameFile = (a: string, b: string) => { try { return canonical(a) === canonical(b); } catch { return false; } };
    const components = projects.flatMap((p) => p.components.filter((c) => c.kind === "compose" && c.compose).map((c) => ({ p, c })));
    return rows.map((row, index) => {
      const id = ids[index]!;
      const inspect = inspected.get(id) ?? {};
      const state = (inspect.State as Record<string, unknown> | undefined) ?? {};
      const config = (inspect.Config as Record<string, unknown> | undefined) ?? {};
      const l = config.Labels && typeof config.Labels === "object" ? config.Labels as Record<string, string> : labels(row);
      const projectName = l["com.docker.compose.project"], service = l["com.docker.compose.service"], wd = l["com.docker.compose.project.working_dir"], files = l["com.docker.compose.project.config_files"];
      // Association needs an exact label match on a registered component; everything else stays observed only.
      const owner = projectName && service && wd && files ? components.find(({ c }) => c.compose!.projectName === projectName && c.compose!.services.includes(service) && sameFile(wd, c.cwd) && files.split(",").every((f) => c.compose!.files.some((known) => sameFile(resolve(c.cwd, known), f)))) : undefined;
      const health = state.Health && typeof state.Health === "object" ? String((state.Health as Record<string, unknown>).Status ?? "") : undefined;
      return { id, name: String(row.Names ?? row.Name ?? "").replace(/^\//, ""), imageId: String(inspect.Image ?? ""), image: String(row.Image ?? config.Image ?? ""), state: String(state.Status ?? row.State ?? "unknown"),
        ...(health ? { health } : {}), ...(owner ? { projectId: owner.p.id, componentId: owner.c.id } : {}), ...(projectName ? { composeProject: projectName } : {}),
        ports: String(row.Ports ?? "").split(",").map((x) => x.trim()).filter(Boolean), ...usage.get(id) };
    });
  }
}
