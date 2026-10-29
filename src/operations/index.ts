import {
  DevHubError,
  type Action,
  type CatalogPort,
  type Component,
  type ContainerInfo,
  type LogEntry,
  type LogOptions,
  type Operation,
  type OperationsPort,
  type Project,
  type ProjectStatus,
  type RuntimePort,
} from "../contracts";
import { resolveSelection } from "./graph";
import { logger as defaultLogger, redactText, type LoggerLike } from "./logger";
import { OperationsLogs } from "./logs";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const MAX_FIXED_DIAGNOSTICS = 256;
const FIXED_PROJECT_CHANGED = "DEVHUB_PROJECT_CHANGED";
const FIXED_STORAGE_FAILED = "DEVHUB_OPERATION_STORAGE_FAILED";

interface LocalJob { promise: Promise<Operation> }

function invalid(message = "Invalid operation request"): never {
  throw new DevHubError(message, "invalid", 400);
}
function sameProject(left: Project, right: Project): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function errorText(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}
function terminal(state: Operation["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "unknown";
}
function fixedFailure(message: string, code: string, status: number): DevHubError {
  const error = new DevHubError(message, code, status);
  Object.defineProperty(error, "cause", { value: message, configurable: false, enumerable: false, writable: false });
  return error;
}

export class Operations implements OperationsPort {
  private readonly catalog: CatalogPort;
  private readonly runtime: RuntimePort;
  private readonly readinessTimeoutMs: number;
  private readonly pollMs: number;
  private readonly logger: LoggerLike;
  private readonly jobs = new Map<string, LocalJob>();
  private readonly fixedDiagnostics = new Map<string, string>();
  private readonly logsStore: OperationsLogs;

  constructor(options: { catalog: CatalogPort; runtime: RuntimePort; readinessTimeoutMs?: number; pollMs?: number; logger?: LoggerLike }) {
    const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 1 || readinessTimeoutMs > 900_000
      || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 10_000) invalid("Invalid operation timing options");
    this.catalog = options.catalog;
    this.runtime = options.runtime;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.pollMs = pollMs;
    this.logger = options.logger ?? defaultLogger;
    this.logsStore = new OperationsLogs(this.catalog, this.runtime);
    this.catalog.recoverOperations();
  }

  submit(projectId: string, action: Action, componentIds?: string[], idempotencyKey?: string): Operation {
    const snapshot = this.validatedProject(projectId, componentIds, action);
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 128)) invalid();
    const selection = resolveSelection(snapshot.components, componentIds);
    const claim = this.catalog.claimOperation(projectId, action, selection.requested, idempotencyKey);
    if (!claim.acquired) return claim.operation;

    let resolveJob!: (operation: Operation) => void;
    let rejectJob!: (error: Error) => void;
    const promise = new Promise<Operation>((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
    void promise.catch(() => undefined);
    this.jobs.set(claim.operation.id, { promise });
    void this.perform(claim.operation, snapshot, selection).then(resolveJob, (error: unknown) => {
      rejectJob(error instanceof Error ? error : new Error(FIXED_STORAGE_FAILED));
    }).finally(() => { this.jobs.delete(claim.operation.id); }).catch(() => undefined);
    return claim.operation;
  }

  async execute(projectId: string, action: Action, componentIds?: string[], idempotencyKey?: string): Promise<Operation> {
    const op = this.submit(projectId, action, componentIds, idempotencyKey);
    const local = this.jobs.get(op.id);
    if (local) return local.promise;
    const diagnostic = this.fixedDiagnostics.get(op.id);
    if (diagnostic) throw fixedFailure(diagnostic, "storage_failed", 500);
    if (terminal(op.state)) {
      if (op.error === FIXED_PROJECT_CHANGED) throw fixedFailure(FIXED_PROJECT_CHANGED, "operation_failed", 409);
      return op;
    }
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      await this.delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
      const latest = this.catalog.getOperation(op.id);
      if (terminal(latest.state)) return latest;
    }
    throw new DevHubError("Operation owner did not finish before the deadline", "timeout", 504);
  }

  async status(projectId: string): Promise<ProjectStatus> {
    const project = this.getValidProject(projectId);
    const components = [...project.components].sort((a, b) => a.id.localeCompare(b.id));
    // Components are probed concurrently; one failing probe reports unknown instead of hiding the others.
    const statuses = await Promise.all(components.map(async (component) => {
      try { return await this.runtime.check(project, component); }
      catch (error) { return { componentId: component.id, state: "unknown" as const, ready: false, detail: errorText(error).slice(0, 300) || "Status unavailable" }; }
    }));
    return { projectId, components: statuses };
  }

  async logs(projectId: string, options: LogOptions = {}): Promise<LogEntry[]> {
    return this.logsStore.read(projectId, options);
  }

  getOperation(id: string): Operation {
    try {
      const operation = this.catalog.getOperation(id);
      const diagnostic = this.fixedDiagnostics.get(id);
      return diagnostic ? { ...operation, error: diagnostic } : operation;
    }
    catch (error) {
      if (error instanceof Error && error.message === FIXED_PROJECT_CHANGED) throw new DevHubError(FIXED_PROJECT_CHANGED, "operation_failed", 409);
      if (error instanceof Error && error.message === FIXED_STORAGE_FAILED) throw new DevHubError(FIXED_STORAGE_FAILED, "storage_failed", 500);
      throw error;
    }
  }

  listOperations(projectId?: string): Operation[] { return this.catalog.listOperations(projectId); }

  async inventory(): Promise<ContainerInfo[]> {
    const projects = this.catalog.listProjects();
    for (const project of projects) this.validateProjectShape(project);
    return this.runtime.inventory(projects);
  }

  private validatedProject(projectId: string, componentIds: string[] | undefined, action: Action): Project {
    if (!["start", "stop", "restart", "check"].includes(action)) invalid();
    if (componentIds !== undefined && (!Array.isArray(componentIds) || componentIds.length === 0)) invalid("Invalid component selection");
    try { return structuredClone(this.getValidProject(projectId)); }
    catch (error) { if (error instanceof DevHubError) throw error; invalid(); }
  }

  private getValidProject(projectId: string): Project {
    let project: Project;
    try { project = this.catalog.getProject(projectId); }
    catch { throw new DevHubError("Project not found", "not_found", 404); }
    this.validateProjectShape(project);
    return project;
  }

  private validateProjectShape(project: Project): void {
    if (!project || typeof project.id !== "string" || !Array.isArray(project.components)) invalid("Invalid project");
    resolveSelection(project.components);
  }

  private async perform(operation: Operation, snapshot: Project, selection: ReturnType<typeof resolveSelection>): Promise<Operation> {
    try {
      this.assertCurrent(snapshot);
      operation = this.persist(operation, { state: "running" });
      if (operation.action === "start") await this.start(snapshot, selection.start);
      else if (operation.action === "stop") await this.stop(snapshot, selection.stop);
      else if (operation.action === "restart") {
        await this.stop(snapshot, selection.stop);
        await this.start(snapshot, selection.start);
      } else await this.check(snapshot, selection.requested);
      return this.persist(operation, { state: "succeeded" });
    } catch (error) {
      if (error instanceof Error && error.message === FIXED_STORAGE_FAILED) throw fixedFailure(FIXED_STORAGE_FAILED, "storage_failed", 500);
      const detail = error instanceof Error && error.message === FIXED_PROJECT_CHANGED ? FIXED_PROJECT_CHANGED : errorText(error).slice(0, 1000) || "Operation failed";
      if (detail === FIXED_PROJECT_CHANGED) this.safeLog("error", FIXED_PROJECT_CHANGED);
      let failed: Operation;
      try { failed = this.persist(operation, { state: "failed", error: detail }); }
      catch {
        throw fixedFailure(FIXED_STORAGE_FAILED, "storage_failed", 500);
      }
      if (detail === FIXED_PROJECT_CHANGED) throw fixedFailure(FIXED_PROJECT_CHANGED, "operation_failed", 409);
      return failed;
    }
  }

  private async start(project: Project, componentIds: string[]): Promise<void> {
    const byId = new Map(project.components.map((component) => [component.id, component]));
    for (const id of componentIds) {
      this.assertCurrent(project);
      const component = byId.get(id)!;
      await this.runtime.start(project, component);
      await this.waitReady(project, component);
    }
  }

  private async stop(project: Project, componentIds: string[]): Promise<void> {
    const byId = new Map(project.components.map((component) => [component.id, component]));
    for (const id of componentIds) {
      this.assertCurrent(project);
      await this.runtime.stop(project, byId.get(id)!);
    }
  }

  private async check(project: Project, componentIds: string[]): Promise<void> {
    const byId = new Map(project.components.map((component) => [component.id, component]));
    for (const id of componentIds) {
      this.assertCurrent(project);
      const status = await this.runtime.check(project, byId.get(id)!);
      if (!status.ready) throw new DevHubError(`Component ${id} is not ready${status.detail ? `: ${status.detail}` : ""}`, "not_ready", 503);
    }
  }

  private async waitReady(project: Project, component: Component): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (true) {
      this.assertCurrent(project);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DevHubError(`Readiness timed out for ${component.id}`, "timeout", 504);
      const checked = this.runtime.check(project, component);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DevHubError(`Readiness timed out for ${component.id}`, "timeout", 504)), remaining);
      });
      let status;
      try { status = await Promise.race([checked, timeout]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      if (status.ready) return;
      const after = deadline - Date.now();
      if (after <= 0) throw new DevHubError(`Readiness timed out for ${component.id}`, "timeout", 504);
      await this.delay(Math.min(this.pollMs, after));
    }
  }

  private assertCurrent(snapshot: Project): void {
    try {
      const current = this.catalog.getProject(snapshot.id);
      if (!sameProject(current, snapshot)) throw new Error(FIXED_PROJECT_CHANGED);
    } catch { throw new Error(FIXED_PROJECT_CHANGED); }
  }

  private persist(operation: Operation, patch: Partial<Pick<Operation, "state" | "error">>): Operation {
    try { return this.catalog.updateOperation(operation.id, patch); }
    catch {
      if (!this.fixedDiagnostics.has(operation.id) && this.fixedDiagnostics.size >= MAX_FIXED_DIAGNOSTICS) {
        const oldest = this.fixedDiagnostics.keys().next().value;
        if (oldest !== undefined) this.fixedDiagnostics.delete(oldest);
      }
      this.fixedDiagnostics.set(operation.id, FIXED_STORAGE_FAILED);
      this.safeLog("error", FIXED_STORAGE_FAILED);
      throw new Error(FIXED_STORAGE_FAILED, { cause: FIXED_STORAGE_FAILED });
    }
  }

  private safeLog(level: "error" | "warn", message: string): void {
    try { this.logger[level]({ code: message }, message); } catch { /* diagnostics must not disrupt operation settlement */ }
  }

  private delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}
