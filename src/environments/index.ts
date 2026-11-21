import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DevHubError, type CatalogPort, type Executor, type ExecResult } from "../contracts";
import { gitRun } from "../git";
import { redactLogLine, redactText } from "../operations/logger";
import { emptyResources, FeatureDocker, hostExecutor } from "./docker";
import { featureLock } from "./lock";
import { inside, listRecipes, readRecipe } from "./recipe";
import { renderCompose, verifyComposePaths } from "./compose";
import { installFeatureTimer } from "./timer";
import type { CreateEnvironment, DestroyOptions, Environment, EnvironmentOperation, EnvironmentRepo, Observed, Recipe } from "./types";

const registry = "feature_environments";
const featureId = /^ef-[a-f0-9]{32}$/;
const gitId = /^[a-f0-9]{40,64}$/;
const secretKey = /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const now = () => new Date().toISOString();
const ordered = (data?: Record<string, string>) => Object.fromEntries(Object.entries(data ?? {}).sort(([a], [b]) => a.localeCompare(b)));
type RecordEntry = Environment & { recipe: Recipe; keyHash?: string; requestHash: string; copied: string[]; worktreeRoot: string; checksPassed: boolean };
type OperationAction = EnvironmentOperation["action"];
type Step = Recipe["steps"][number];

function fail(message: string, code: string, status = 409): never { throw new DevHubError(message, code, status); }
function setting(key: string, fallback: number, maximum: number): number {
  const input = process.env[key];
  if (input === undefined) return fallback;
  if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > maximum) fail(`Invalid ${key}`, "invalid_configuration", 400);
  return Number(input);
}
function directory(input: string, create = false): string {
  if (!isAbsolute(input) || resolve(input) !== input || /[\x00-\x1f]/.test(input)) fail("Feature paths must be canonical absolute paths on the Docker host", "unsafe_path", 400);
  if (create && !existsSync(input)) {
    directory(dirname(input), true);
    mkdirSync(input, { recursive: true, mode: 0o700 });
  }
  if (realpathSync(input) !== input || !lstatSync(input).isDirectory()) fail("Feature directories must be real directories without symlinked ancestors", "unsafe_path");
  return input;
}
function composeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return !!match && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 30);
}
function inspectError(error: unknown): { code: string; message: string } {
  return error instanceof DevHubError ? { code: error.code, message: redactText(error.message) } : { code: "feature_failed", message: "Feature operation failed. Check the operation step and host permissions." };
}
function publicly(entry: RecordEntry): Environment {
  const { recipe, keyHash, requestHash, copied, worktreeRoot, checksPassed, ...environment } = entry;
  return environment;
}
function gitPath(directory: string, resolveFrom: string, expected: string): void {
  if (realpathSync(directory) !== expected || !inside(resolveFrom, expected) || expected === resolveFrom) fail("Unverified feature worktree path", "unsafe_path");
}

export class Environments {
  private readonly run: Executor;
  private readonly docker: FeatureDocker;
  private readonly locks: string;
  private readonly models: string;

  constructor(private readonly options: { catalog: CatalogPort; run: Executor; stateDir: string; infraDir: string }) {
    this.run = hostExecutor(options.run);
    this.docker = new FeatureDocker(this.run, options.infraDir);
    this.locks = join(options.stateDir, "feature-locks");
    this.models = join(options.stateDir, "feature-environments");
  }

  private get recipeDirectory(): string {
    const path = process.env.DEVHUB_RECIPE_DIR ?? join(this.options.stateDir, "recipes");
    if (!isAbsolute(path) || resolve(path) !== path) fail("DEVHUB_RECIPE_DIR must be an absolute directory", "invalid_configuration", 400);
    return existsSync(path) ? directory(path) : path;
  }
  recipes() { return listRecipes(this.recipeDirectory); }

  private worktreeRoot(): string {
    const root = process.env.DEVHUB_WORKTREE_ROOT ?? join(homedir(), ".local", "share", "devhub-feature-worktrees");
    if ([this.options.stateDir, this.options.infraDir, homedir()].some((path) => inside(root, path)) ||
        [this.options.stateDir, this.options.infraDir].some((path) => inside(path, root))) fail("Feature worktree root overlaps protected DevHub directories", "unsafe_path");
    const real = directory(root, true);
    const stat = lstatSync(real);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail("The feature worktree root must be owned by this user with mode 0700", "unsafe_path");
    return real;
  }

  private model(entry: Environment): string { return join(this.models, entry.id); }
  private lock<T>(key: string, run: () => T | Promise<T>, wait = 0): Promise<T> {
    return featureLock(this.locks, key, run, wait);
  }
  private entry(id: string): RecordEntry {
    if (!featureId.test(id)) fail("Invalid feature environment ID", "invalid_id", 400);
    return this.options.catalog.getRecord<RecordEntry>(registry, id) ?? fail("Feature environment was not found", "not_found", 404);
  }
  private entries(): RecordEntry[] { return this.options.catalog.listRecords<RecordEntry>(registry); }
  list(): Environment[] { return this.entries().map(publicly); }
  private save(entry: RecordEntry): void { this.options.catalog.putRecord(registry, entry.id, JSON.parse(JSON.stringify(entry))); }

  private step(entry: RecordEntry, step: string): void {
    Object.assign(entry.operation!, { step, updatedAt: now() });
    this.save(entry);
    this.recordLog(entry, step);
  }
  private recordLog(entry: RecordEntry, log: string): void {
    try {
      const model = directory(this.model(entry), true);
      const path = join(model, "operations.log");
      const previous = existsSync(path) ? readFileSync(path, "utf8").slice(-96_000) : "";
      writeFileSync(path, previous + `${now()} ${this.redact(entry, log).slice(0, 16_000)}\n`, { mode: 0o600 });
    } catch { /* The durable operation metadata remains available. */ }
  }
  private redact(entry: RecordEntry, value: string): string {
    for (const file of Object.values(entry.recipe.compose.secretFiles)) {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > 16 * 1024) continue;
        const secret = readFileSync(file, "utf8").trim();
        if (secret) value = value.replaceAll(secret, "[redacted]");
      } catch { /* The existing logger still redacts structured secrets. */ }
    }
    const model = join(this.model(entry), "compose.json");
    if (existsSync(model)) {
      try {
        const configuration = JSON.parse(readFileSync(model, "utf8")) as { services: Record<string, { environment?: Record<string, unknown> }> };
        for (const service of Object.values(configuration.services)) {
          for (const [key, stored] of Object.entries(service.environment ?? {})) {
            if (typeof stored === "string" && stored.length >= 4 && secretKey.test(key)) {
              const secret = stored.replaceAll("$$", "$");
              value = value.replaceAll(secret, "[redacted]");
            }
          }
        }
      } catch { /* Structured output still uses the existing logger's rules. */ }
    }
    return value.split(/\r?\n/).map(redactLogLine).join("\n");
  }

  private async redactContainerOutput(entry: RecordEntry, container: Environment["resources"]["containers"][number], result: ExecResult): Promise<ExecResult> {
    let { code, stdout, stderr } = result;
    if (!stdout && !stderr) return result;
    try {
      const path = join(this.model(entry), "compose.json");
      const model = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
      // File-backed secrets are absent from the snapshot. Redact them from command output using the running container's values.
      if (model?.services[container.service]?.env_file?.length) {
        for (const variable of await this.docker.containerEnvironment(container.id)) {
          const separator = variable.indexOf("=");
          const secret = variable.slice(separator + 1);
          if (separator > 0 && secret.length >= 4 && secretKey.test(variable.slice(0, separator))) {
            stdout = stdout.replaceAll(secret, "[redacted]");
            stderr = stderr.replaceAll(secret, "[redacted]");
          }
        }
      }
    } catch {
      return { code, stdout: "", stderr: "Container output withheld because its environment could not be verified" };
    }
    return { code, stdout: this.redact(entry, stdout), stderr: this.redact(entry, stderr) };
  }

  private hasCapacity(id?: string): void {
    const limit = setting("DEVHUB_FEATURE_MAX_ACTIVE", 5, 100);
    const reserved = this.entries().filter((entry) => entry.id !== id && ((entry.desired === "running" && ["creating", "starting", "ready"].includes(entry.observed)) ||
      entry.observed === "stopping" || entry.observed === "destroying" ||
      entry.resources.containers.some((container) => container.state === "running" || container.state === "restarting")));
    if (reserved.length >= limit) fail(`The active feature limit (${limit}) has been reached. Stop a feature before starting another.`, "capacity_active", 503);
  }

  private async assertDisk(worktreeRoot: string): Promise<void> {
    const minimum = setting("DEVHUB_FEATURE_MIN_FREE_MIB", 2048, 1_048_576);
    const docker = await this.run(["docker", "info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 10_000, maxOutputBytes: 16_000 });
    const dockerRoot = docker.stdout.trim();
    if (docker.code !== 0 || !isAbsolute(dockerRoot)) fail("The local Docker Engine is unavailable", "docker_unavailable", 503);
    const targets = new Set([worktreeRoot, this.options.stateDir, dockerRoot]);
    for (const path of targets) {
      let fs;
      try { fs = statfsSync(path); }
      catch { fail("Could not measure free space on the worktree, state or Docker filesystem", "capacity_disk", 503); }
      if (fs.bavail * fs.bsize < minimum * 1024 * 1024) fail(`The host needs at least ${minimum} MiB free on the worktree, state and Docker filesystems`, "capacity_disk", 503);
    }
  }

  private async buildSlot<T>(operation: () => Promise<T>): Promise<T> {
    const limit = setting("DEVHUB_FEATURE_MAX_BUILDS", 2, 32);
    for (let slot = 0; slot < limit; slot++) {
      let acquired = false;
      try {
        return await this.lock(`build-${slot}`, () => {
          acquired = true;
          return operation();
        });
      } catch (error) {
        if (acquired || !(error instanceof DevHubError) || error.code !== "operation_busy") throw error;
      }
    }
    fail(`The host is already building or bootstrapping ${limit} features. Retry start when a slot is available.`, "capacity_build", 503);
  }

  private async git(path: string, args: string[]): Promise<ExecResult> {
    return gitRun(this.run, ["-C", path, ...args], { timeoutMs: 120_000, maxOutputBytes: 1_048_576 });
  }
  private async gitRequired(path: string, args: string[], error: string): Promise<string> {
    const result = await this.git(path, args);
    if (result.code !== 0) fail(error, "git_failed");
    return result.stdout.trim();
  }

  private async resolveRepos(id: string, recipe: Recipe, root: string, input: CreateEnvironment): Promise<EnvironmentRepo[]> {
    const repos: EnvironmentRepo[] = [];
    for (const key of [...Object.keys(input.refs ?? {}).filter((key) => key !== "*"), ...Object.keys(input.branches ?? {})]) {
      if (!Object.hasOwn(recipe.repositories, key)) fail("A ref or branch override names an unknown repository", "invalid_ref", 400);
    }
    for (const [name, specification] of Object.entries(recipe.repositories)) {
      const source = this.options.catalog.assertAllowedPath(specification.path);
      if (inside(root, source) || inside(source, root)) fail("A source repository overlaps the dedicated feature worktree root", "unsafe_path");
      if (await this.gitRequired(source, ["rev-parse", "--show-toplevel"], "Cannot identify source Git checkout") !== source) fail(`Repository ${name} must point to the checkout root`, "invalid_ref");
      const attached = input.branches?.[name];
      if (attached && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(attached)) fail("Invalid existing branch name", "invalid_ref", 400);
      const branch = attached || "devhub/" + id + "/" + name;
      const ref = input.refs?.[name] ?? (attached ? "refs/heads/" + attached : input.refs?.["*"] ?? specification.ref);
      if (typeof ref !== "string" || !ref || ref.length > 4096 || /[\0\r\n]/.test(ref)) fail("Invalid Git reference", "invalid_ref", 400);
      const sha = await this.gitRequired(source, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], `Cannot resolve requested commit for repository ${name}`);
      if (!gitId.test(sha)) fail("Git did not return a commit ID", "git_failed");
      if (attached && sha !== await this.gitRequired(source, ["rev-parse", "--verify", "--end-of-options", "refs/heads/" + attached + "^{commit}"], `Existing branch for ${name} was not found`)) fail("The existing branch and the requested reference resolve to different commits", "branch_conflict");
      repos.push({ name, source, path: join(root, id, name), ref, sha, branch, attach: !!attached, prepared: false });
    }
    return repos;
  }

  async create(input: CreateEnvironment): Promise<Environment> {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(input.project) || typeof input.feature !== "string" ||
        !input.feature.trim() || input.feature.length > 120 || /[\x00-\x1f]/.test(input.feature)) fail("Give a valid recipe ID and a feature name up to 120 characters", "invalid_feature", 400);
    if (input.idempotencyKey !== undefined && !/^[\x21-\x7e]{1,160}$/.test(input.idempotencyKey)) fail("Invalid idempotency key", "invalid_idempotency_key", 400);
    const feature = input.feature.trim();
    const requestHash = sha256(JSON.stringify({ project: input.project, feature, refs: ordered(input.refs), branches: ordered(input.branches), build: input.build === true }));
    const keyHash = input.idempotencyKey ? sha256(input.idempotencyKey) : undefined;
    const findPrevious = () => {
      const previous = keyHash && this.entries().find((entry) => entry.keyHash === keyHash);
      if (previous && requestHash !== previous.requestHash) fail("The idempotency key was used with different create parameters", "idempotency_conflict");
      return previous || undefined;
    };
    const previous = findPrevious();
    if (previous) return this.status(previous.id);

    const id = "ef-" + randomUUID().replaceAll("-", "");
    const result = await this.lock(id, async () => {
      // Publish the allocation only after taking its lock so status can detect a dead owner.
      const entry = await this.lock("allocation", async () => {
        const existing = findPrevious();
        if (existing) return existing;
        this.hasCapacity();
        const recipe = readRecipe(this.recipeDirectory, input.project);
        const root = this.worktreeRoot();
        await this.assertDisk(root);
        const started = now();
        const allocated: RecordEntry = {
          id, composeProject: "devhub-" + id, project: input.project, feature,
          slug: feature.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 27).replace(/-$/, "") || "feature",
          provider: "docker-compose", host: hostname(), createdAt: started, activeAt: started, idleMinutes: recipe.idleMinutes,
          desired: "running", observed: "creating", recipe, keyHash, requestHash, worktreeRoot: root,
          repos: await this.resolveRepos(id, recipe, root, input), copied: [], resources: emptyResources(), bootstrap: {}, checksPassed: false,
        };
        this.save(allocated);
        return allocated;
      }, 25);
      return entry.id === id ? this.mutateLocked(entry, "create", () => this.launch(entry, input.build === true)) : publicly(entry);
    });
    return result.id === id ? result : this.status(result.id);
  }

  private async worktree(entry: RecordEntry, repo: EnvironmentRepo): Promise<string | undefined> {
    const source = this.options.catalog.assertAllowedPath(repo.source);
    const output = await this.gitRequired(source, ["worktree", "list", "--porcelain", "-z"], `Cannot list worktrees for ${repo.name}`);
    const tokens = output.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "worktree " + repo.path) continue;
      let branch: string | undefined;
      for (i++; i < tokens.length && tokens[i]; i++) if (tokens[i]!.startsWith("branch ")) branch = tokens[i]!.slice(7);
      if (branch !== "refs/heads/" + repo.branch) fail(`Worktree ${repo.name} is checked out on an unexpected branch`, "ownership_conflict");
      gitPath(repo.path, entry.worktreeRoot, join(entry.worktreeRoot, entry.id, repo.name));
      return branch;
    }
    if (existsSync(repo.path)) fail(`Worktree path for ${repo.name} exists without matching Git registration`, "ownership_conflict");
    return undefined;
  }

  private async repoLockKey(repo: EnvironmentRepo): Promise<string> {
    const common = await this.gitRequired(repo.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "Cannot identify shared Git directory");
    return "repo-" + sha256(realpathSync(common));
  }
  private async prepare(entry: RecordEntry): Promise<void> {
    const root = directory(entry.worktreeRoot);
    if (lstatSync(root).uid !== process.getuid?.()) fail("Feature worktree root ownership changed", "unsafe_path");
    directory(join(root, entry.id), true);
    for (const repo of entry.repos) {
      if (repo.removed) fail("The worktree was explicitly removed. Create a fresh environment to work on this feature again.", "worktrees_removed");
      this.step(entry, "git:" + repo.name);
      await this.lock(await this.repoLockKey(repo), async () => {
        const present = await this.worktree(entry, repo);
        if (!present) {
          if (repo.prepared && !repo.attach) {
            const branchSha = await this.gitRequired(repo.source, ["rev-parse", "--verify", "refs/heads/" + repo.branch], "The feature branch is missing");
            if (!gitId.test(branchSha)) fail("Cannot verify the retained feature branch", "git_failed");
          }
          if (!repo.prepared && repo.attach) {
            const branchSha = await this.gitRequired(repo.source, ["rev-parse", "--verify", "refs/heads/" + repo.branch], "The attached feature branch is missing");
            if (branchSha !== repo.sha) fail("The attached branch moved after creation. Create an environment using the new commit.", "branch_conflict");
          }
          this.options.catalog.assertAllowedPath(repo.source);
          await this.gitRequired(repo.source, ["worktree", "add", ...(repo.attach || repo.prepared
            ? ["--", repo.path, repo.branch]
            : ["-b", repo.branch, "--", repo.path, repo.sha])],
            `Cannot create the ${repo.name} worktree. Check that the branch is available and is not checked out elsewhere.`);
          await this.worktree(entry, repo);
        }
        if (!repo.prepared && await this.gitRequired(repo.path, ["rev-parse", "HEAD"], "Cannot verify the worktree commit") !== repo.sha) fail("The prepared worktree does not match the recorded starting commit", "branch_conflict");
        repo.prepared = true;
        this.save(entry);
      }, 20);
    }
    for (const item of entry.recipe.localFiles) {
      const repo = entry.repos.find(({ name }) => name === item.repository)!;
      const target = join(repo.path, item.target);
      const key = item.repository + "/" + item.target;
      if (entry.copied.includes(key)) {
        if (!existsSync(target) || !lstatSync(target).isFile() || realpathSync(target) !== target) fail("An explicitly copied local file is missing or has moved", "local_file_missing");
        continue;
      }
      this.step(entry, "local-files:" + item.repository);
      const source = this.options.catalog.assertAllowedPath(item.source);
      const stat = lstatSync(source);
      if (source !== item.source || !stat.isFile() || stat.size > 16 * 1024 * 1024) fail("Local file source must be a regular file up to 16 MiB inside an approved root", "unsafe_path");
      directory(dirname(target), true);
      if (!inside(repo.path, target)) fail("Local file target escapes its worktree", "unsafe_path");
      if (!existsSync(target)) {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        chmodSync(target, 0o600);
      }
      else {
        const targetInfo = lstatSync(target);
        const tracked = await this.git(repo.path, ["ls-files", "--error-unmatch", "--", item.target]);
        if (!targetInfo.isFile() || targetInfo.size !== stat.size || tracked.code === 0 || sha256(readFileSync(target)) !== sha256(readFileSync(source))) {
          fail("Local file target already exists. DevHub preserves existing worktree files.", "local_file_conflict");
        }
      }
      entry.copied.push(key);
      this.save(entry);
    }
  }

  private async launch(entry: RecordEntry, build: boolean, retryStep?: string): Promise<void> {
    await this.assertDisk(entry.worktreeRoot);
    await this.buildSlot(async () => {
      await this.prepare(entry);
      const model = directory(this.model(entry), true);
      if (!entry.configuration) {
        this.step(entry, "compose-config");
        const version = await this.run(["docker", "compose", "version", "--short"], { timeoutMs: 5000, maxOutputBytes: 1024 });
        if (version.code !== 0 || !composeSupported(version.stdout.trim())) fail("Feature environments require Docker Compose 2.30 or later", "compose_version", 503);
        entry.configuration = await renderCompose(this.run, entry.recipe, entry, model);
        this.save(entry);
      }
      await verifyComposePaths(entry, model);
      entry.resources = await this.docker.inspect(entry);
      this.step(entry, "images");
      await this.docker.ensureImages(entry, model, build);
      entry.resources = await this.docker.inspect(entry);
      this.save(entry);
      this.step(entry, "compose-up");
      const result = await this.docker.compose(entry, model, ["up", "-d", "--no-build", "--pull", "never"], 240_000);
      if (result.code !== 0) {
        if (/address pools? (?:have been fully subnetted|exhausted)|available, non-overlapping IPv4 address pool/i.test(result.stderr)) {
          fail("Docker has no free bridge subnet for this feature. Free an unused network or expand the host address pools.", "capacity_network", 503);
        }
        fail("Could not start the isolated Compose project", "compose_up");
      }
      entry.resources = await this.docker.inspect(entry);
      this.save(entry);
      for (const phase of ["install", "migrate", "seed"] as const) {
        for (const step of entry.recipe.steps.filter((item) => item.phase === phase)) {
          if (entry.bootstrap[step.id] === "done") continue;
          if (entry.bootstrap[step.id] && step.retry === "manual" && retryStep !== step.id) fail(`Step ${step.id} may have run partially. Check its effects before using start --retry-step ${step.id}.`, "manual_step_retry");
          this.step(entry, "bootstrap:" + step.id);
          entry.bootstrap[step.id] = "running";
          this.save(entry);
          try {
            await this.runStep(entry, step);
            entry.bootstrap[step.id] = "done";
          } catch (error) {
            entry.bootstrap[step.id] = "failed";
            throw error;
          } finally { this.save(entry); }
        }
      }
    });
    this.step(entry, "readiness");
    const deadline = Date.now() + 90_000;
    do {
      entry.resources = await this.docker.inspect(entry);
      entry.preview = await this.docker.endpoint(entry);
      if (this.servicesReady(entry) && await this.docker.health(entry.recipe, entry.preview)) break;
      if (Date.now() >= deadline) fail("Required services or preview routes did not pass their health checks", "health_failed");
      await Bun.sleep(500);
    } while (true);
    for (const step of entry.recipe.steps.filter((item) => item.phase === "check")) {
      this.step(entry, "check:" + step.id);
      await this.runStep(entry, step);
    }
    this.step(entry, "preview-route");
    await this.syncDomain(entry, entry.preview);
    entry.checksPassed = true;
    entry.observed = "ready";
  }

  private servicesReady(entry: RecordEntry): boolean {
    return !!entry.configuration?.services.length && entry.configuration.services.every((service) => {
      const containers = entry.resources.containers.filter((container) => container.service === service);
      return containers.length > 0 && containers.every((container) => container.state === "running" && (!container.health || container.health === "healthy"));
    });
  }
  private async syncDomain(entry: RecordEntry, preview?: Environment["preview"]): Promise<void> {
    if (!entry.recipe.previewDomain) return;
    const url = await this.lock("caddy", () => this.docker.syncDomain(entry, entry.recipe, this.model(entry), preview), 20);
    if (preview) preview.domainUrl = url;
  }
  private async observe(entry: RecordEntry): Promise<Environment["observationError"]> {
    entry.resources = await this.docker.inspect(entry);
    const active = entry.resources.containers.some(({ state }) => state === "running" || state === "restarting");
    if (entry.desired !== "running") {
      entry.preview = undefined;
      entry.observed = entry.desired === "destroyed" ? (entry.resources.containers.length || entry.resources.networks.length ? "degraded" : "destroyed") : active ? "degraded" : "stopped";
      return;
    }
    const preview = await this.docker.endpoint(entry);
    if (preview && entry.preview?.port === preview.port) preview.domainUrl = entry.preview.domainUrl;
    entry.preview = preview;
    const initialized = entry.recipe.steps.filter(({ phase }) => ["install", "migrate", "seed"].includes(phase)).every(({ id }) => entry.bootstrap[id] === "done");
    if (entry.operation?.state === "interrupted" || (entry.operation?.state === "failed" && ["create", "start"].includes(entry.operation.action))) {
      entry.observed = "error";
      return;
    }
    entry.observed = "degraded";
    if (!entry.checksPassed || !initialized || !this.servicesReady(entry) || !await this.docker.health(entry.recipe, preview)) return;
    for (const step of entry.recipe.steps.filter(({ phase }) => phase === "check")) {
      try { await this.runStep(entry, step, false); }
      catch (error) { return inspectError(error); }
    }
    entry.observed = "ready";
  }
  private markInterrupted(entry: RecordEntry): void {
    if (entry.operation?.state === "running" || (entry.observed === "creating" && !entry.operation)) {
      entry.operation = { ...(entry.operation ?? { id: randomUUID(), action: "create", step: "allocation", startedAt: entry.createdAt }),
        state: "interrupted", updatedAt: now(), error: { code: "interrupted", message: "The previous operation was interrupted. Inspect the feature before retrying." } };
      entry.observed = "error";
    }
  }
  async status(id: string): Promise<Environment> {
    const read = () => this.entry(id);
    read();
    try {
      return await this.lock(id, async () => {
        const entry = read();
        this.markInterrupted(entry);
        try {
          entry.observationError = await this.observe(entry);
        } catch (error) {
          entry.observationError = inspectError(error);
          entry.observed = "error";
          entry.preview = undefined;
        }
        this.save(entry);
        return publicly(entry);
      });
    } catch (error) {
      if (!(error instanceof DevHubError) || error.code !== "operation_busy") throw error;
      return publicly(read());
    }
  }

  private async mutate(id: string, action: OperationAction, execute: (entry: RecordEntry) => Promise<void>): Promise<Environment> {
    this.entry(id);
    return this.lock(id, async () => {
      const entry = this.entry(id);
      this.markInterrupted(entry);
      return this.mutateLocked(entry, action, execute);
    });
  }

  private async mutateLocked(entry: RecordEntry, action: OperationAction, execute: (entry: RecordEntry) => Promise<void>): Promise<Environment> {
    if (entry.desired === "destroyed") {
      if (action === "start") fail("This environment was destroyed. Create a new environment for further development.", "environment_destroyed");
      if (action === "stop") return publicly(entry);
    }
    const started = now();
    entry.operation = { id: randomUUID(), action, state: "running", step: action, startedAt: started, updatedAt: started };
    entry.activeAt = started;
    delete entry.observationError;
    if (action === "start") {
      await this.lock("allocation", () => {
        this.hasCapacity(entry.id);
        entry.desired = "running";
        entry.observed = "starting";
        entry.checksPassed = false;
        this.save(entry);
      }, 25);
    } else {
      if (action === "stop") { entry.desired = "stopped"; entry.observed = "stopping"; }
      this.save(entry);
    }
    try {
      await execute(entry);
      entry.operation.state = "succeeded";
    } catch (error) {
      const detail = inspectError(error);
      entry.operation.state = "failed";
      entry.operation.error = { ...detail, message: this.redact(entry, detail.message) };
      this.recordLog(entry, `${detail.code}: ${detail.message}`);
      if (["create", "start", "stop"].includes(action) || (action === "destroy" && entry.desired === "destroyed")) entry.observed = "error";
      try { entry.resources = await this.docker.inspect(entry); } catch { /* keep the last verified inventory */ }
    }
    entry.activeAt = entry.operation.updatedAt = now();
    this.save(entry);
    return publicly(entry);
  }

  start(id: string, build = false, retryStep?: string): Promise<Environment> {
    return this.mutate(id, "start", (entry) => {
      if (retryStep !== undefined && !entry.recipe.steps.some((step) => step.id === retryStep && step.retry === "manual" &&
          (entry.bootstrap[step.id] === "running" || entry.bootstrap[step.id] === "failed"))) fail("The requested step is not awaiting explicit retry", "invalid_step", 400);
      return this.launch(entry, build, retryStep);
    });
  }
  stop(id: string): Promise<Environment> {
    return this.mutate(id, "stop", async (entry) => this.stopEntry(entry));
  }
  private async stopEntry(entry: RecordEntry): Promise<void> {
    this.step(entry, "remove-preview-route");
    await this.syncDomain(entry);
    this.step(entry, "docker-stop");
    await this.docker.stop(await this.docker.inspect(entry));
    entry.preview = undefined;
    entry.resources = await this.docker.inspect(entry);
    if (entry.desired === "stopped") entry.observed = "stopped";
  }
  destroy(id: string, flags: DestroyOptions = {}): Promise<Environment> {
    if (flags.force && !flags.removeWorktrees) fail("Force requires explicit worktree removal", "invalid_option", 400);
    return this.mutate(id, "destroy", async (entry) => {
      if (flags.removeWorktrees) {
        this.step(entry, "verify-worktrees");
        for (const repo of entry.repos.filter(({ removed }) => !removed)) await this.checkRemoval(entry, repo, flags.force);
      }
      entry.desired = "destroyed";
      entry.observed = "destroying";
      await this.stopEntry(entry);
      this.step(entry, "docker-remove");
      await this.docker.remove(entry.resources, flags.purgeData === true);
      entry.resources = await this.docker.inspect(entry);
      this.save(entry);
      if (flags.removeWorktrees) {
        for (const repo of entry.repos.filter(({ removed }) => !removed)) {
          this.step(entry, "remove-worktree:" + repo.name);
          await this.lock(await this.repoLockKey(repo), async () => {
            if (await this.checkRemoval(entry, repo, flags.force)) {
              await this.gitRequired(repo.source, ["worktree", "remove", ...(flags.force ? ["--force"] : []), "--", repo.path], "Git refused to remove the verified worktree");
            }
            repo.removed = true;
            this.save(entry);
          }, 20);
        }
      }
      if (flags.removeWorktrees && entry.repos.every(({ removed }) => removed)) {
        const worktrees = join(entry.worktreeRoot, entry.id);
        if (existsSync(worktrees)) {
          directory(worktrees);
          try { rmdirSync(worktrees); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
          }
        }
      }
      entry.observed = "destroyed";
    });
  }

  private async checkRemoval(entry: RecordEntry, repo: EnvironmentRepo, force = false): Promise<boolean> {
    if (!await this.worktree(entry, repo)) return false;
    if (force) return true;
    const status = await this.gitRequired(repo.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], "Cannot verify worktree changes");
    if (status || entry.recipe.localFiles.some((item) => item.repository === repo.name && existsSync(join(repo.path, item.target)))) {
      fail(`Worktree ${repo.name} has changed, untracked, ignored or local files. Preserve the files or explicitly use --force with --remove-worktrees.`, "dirty_worktree");
    }
    // gitRun deliberately ignores submodule changes. Prevent recursive deletion of submodule work.
    const objects = await this.gitRequired(repo.path, ["ls-files", "--stage"], "Cannot verify worktree submodules");
    if (/^160000 /m.test(objects)) fail("The worktree contains a submodule. Use explicit force only after preserving its work.", "dirty_worktree");
    return true;
  }

  private async container(entry: RecordEntry, service: string, refresh = true) {
    if (refresh) entry.resources = await this.docker.inspect(entry);
    const matches = entry.resources.containers.filter((item) => item.service === service && item.state === "running");
    if (matches.length !== 1) fail("The selected service must have exactly one running container", "service_unavailable");
    return matches[0]!;
  }
  private async runStep(entry: RecordEntry, step: Step, log = true): Promise<void> {
    const container = await this.container(entry, step.service, log);
    const result = await this.docker.exec(container.id, step.argv, (step.timeoutSeconds ?? 60) * 1000, step.cwd);
    if (log || result.code !== 0) {
      const output = await this.redactContainerOutput(entry, container, result);
      this.recordLog(entry, [step.id, output.stdout, output.stderr].join("\n"));
    }
    if (result.code !== 0) fail(`Step ${step.id} exited with code ${result.code}. Consult the operation log.`, result.code === 124 || result.code === 137 ? "step_timeout" : "step_failed");
  }
  async logs(id: string, service?: string, tail = 100): Promise<{ service: string; stdout: string; stderr: string }[]> {
    const entry = this.entry(id);
    if (!Number.isInteger(tail) || tail < 1 || tail > 1000) fail("Log tail must be between 1 and 1000", "invalid_option", 400);
    const path = join(this.model(entry), "operations.log");
    const operations = [{ service: "operation", stdout: existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-tail - 1).join("\n") : "", stderr: "" }];
    if (service === "operation") return operations;
    const resources = await this.docker.inspect(entry);
    const containers = resources.containers.filter((item) => !service || item.service === service);
    if (service && !containers.length) fail("No container for this feature service", "service_unavailable", 404);
    const result = await Promise.all(containers.map(async (item) => {
      const log = await this.docker.logs(item.id, tail);
      if (log.code !== 0) fail("Could not read feature container logs", "logs_unavailable");
      const { stdout, stderr } = await this.redactContainerOutput(entry, item, log);
      return { service: item.service, stdout, stderr };
    }));
    return service ? result : [...operations, ...result];
  }
  async exec(id: string, service: string, argv: string[], timeout = 60_000): Promise<ExecResult> {
    if (!argv.length || argv.length > 128 || !argv[0] || argv[0].startsWith("-") ||
        argv.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) ||
        !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) fail("Invalid command or timeout", "invalid_command", 400);
    let result: ExecResult | undefined;
    const final = await this.mutate(id, "exec", async (entry) => {
      const container = await this.container(entry, service);
      const raw = await this.docker.exec(container.id, argv, timeout);
      result = await this.redactContainerOutput(entry, container, raw);
      if (raw.code !== 0) fail(`Command exited with code ${raw.code}`, "command_failed");
    });
    if (result) return result;
    const error = final.operation?.error;
    fail(error?.message ?? "Feature command could not run", error?.code ?? "command_failed");
  }
  test(id: string): Promise<Environment> {
    if (!this.entry(id).recipe.steps.some(({ phase }) => phase === "test")) fail("The recipe has no test command", "unsupported", 400);
    return this.mutate(id, "test", async (entry) => {
      for (const step of entry.recipe.steps.filter(({ phase }) => phase === "test")) {
        this.step(entry, "test:" + step.id);
        await this.runStep(entry, step);
      }
    });
  }
  async preview(id: string) {
    const entry = await this.status(id);
    if (!entry.preview || entry.observed !== "ready") fail("The feature has no ready preview. Check its current status and logs.", "preview_unavailable");
    return entry.preview;
  }
  async reconcile(nowMs = Date.now()): Promise<Environment[]> {
    const results: Environment[] = [];
    for (const old of this.entries()) {
      try {
        results.push(await this.lock(old.id, async () => {
          const entry = this.entry(old.id);
          this.markInterrupted(entry);
          try {
            entry.observationError = await this.observe(entry);
            const idle = nowMs - Date.parse(entry.activeAt) >= entry.idleMinutes * 60_000;
            const retryStop = entry.desired === "stopped" && entry.operation?.action === "stop" &&
              (entry.operation.state === "failed" || entry.operation.state === "interrupted");
            if (entry.desired === "destroyed" && entry.observed === "degraded" && entry.operation?.state === "interrupted") {
              await this.stopEntry(entry);
              await this.docker.remove(entry.resources, false);
              entry.resources = await this.docker.inspect(entry);
              entry.observed = "destroyed";
            } else if (retryStop || (entry.desired === "running" && idle)) {
              const time = now();
              entry.desired = "stopped";
              entry.observed = "stopping";
              entry.operation = { id: randomUUID(), action: "stop", state: "running", step: retryStop ? "retry-stop" : "idle-stop", startedAt: time, updatedAt: time };
              this.save(entry);
              await this.stopEntry(entry);
              entry.operation.state = "succeeded";
              entry.operation.updatedAt = now();
            } else {
              await this.syncDomain(entry, entry.observed === "ready" ? entry.preview : undefined);
            }
          } catch (error) {
            entry.observed = "error";
            entry.observationError = inspectError(error);
            if (entry.operation?.state === "running") {
              entry.operation.state = "failed";
              entry.operation.error = entry.observationError;
              entry.operation.updatedAt = now();
            }
          }
          this.save(entry);
          return publicly(entry);
        }));
      } catch (error) {
        if (!(error instanceof DevHubError) || error.code !== "operation_busy") throw error;
        results.push(publicly(this.entry(old.id)));
      }
    }
    return results;
  }
  async doctor() {
    const git = Bun.which("git");
    const commands: [string, string[]][] = [
      ["compose", ["docker", "compose", "version", "--short"]], ["engine", ["docker", "info", "--format", "{{.OSType}}"]],
      ["flock", ["flock", "--version"]], ["timer", ["systemctl", "--user", "is-active", "devhub-feature-reconcile.timer"]],
    ];
    const checks = await Promise.all(commands.map(async ([name, argv]) => {
      try {
        const result = await this.run(argv, { timeoutMs: 5_000, maxOutputBytes: 16_000 });
        const output = result.stdout.trim();
        return { name, ok: result.code === 0 && (name !== "engine" || output === "linux") &&
          (name !== "compose" || composeSupported(output)), detail: output };
      } catch { return { name, ok: false, detail: "Unavailable" }; }
    }));
    return {
      provider: "docker-compose" as const, host: hostname(), checks: [{ name: "git", ok: git !== null, detail: git ?? "Unavailable" }, ...checks],
      capacity: { active: setting("DEVHUB_FEATURE_MAX_ACTIVE", 5, 100), builds: setting("DEVHUB_FEATURE_MAX_BUILDS", 2, 32), minFreeMiB: setting("DEVHUB_FEATURE_MIN_FREE_MIB", 2048, 1_048_576) },
      capabilities: { pause: false, snapshots: false, diskQuotas: false, distributed: false, remoteDocker: false },
    };
  }
  installTimer() { return installFeatureTimer(this.run, this.options.stateDir, this.options.infraDir); }
}
