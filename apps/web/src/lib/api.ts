import { t } from "./i18n";
import type {
  Action,
  ApiError,
  ApiSuccess,
  ContainerInfo,
  VersionReport,
  CreateDraft,
  CreateInput,
  DirectoryListing,
  CreatePlan,
  LogEntry,
  Operation,
  Preset,
  ProjectStatus,
  PublicChange,
  PublicDetection,
  PublicProject,
  PublicSetupPlan,
  RemediationInput,
  Root,
  Scan,
  SetupInput,
  StackDefinition,
} from "../../../../src/contracts";

/**
 * Typed same-origin client for the DevHub V2 HTTP contract. This module is the only
 * place that talks to the network. The session lives in an HttpOnly cookie managed by
 * the browser; nothing credential-shaped is read, stored or logged here.
 */

const BASE = "/api/v1";
const MAX_SSE_BUFFER_CHARS = 1_048_576;

export class ApiRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return t("Something went wrong. Try again.");
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

let unauthorizedListener: (() => void) | undefined;

/** Registers the single handler that runs when any authenticated request is rejected with 401. */
export function setUnauthorizedListener(listener: (() => void) | undefined): void {
  unauthorizedListener = listener;
}

interface RequestOptions {
  signal?: AbortSignal;
  body?: unknown;
  headers?: Record<string, string>;
  /** Pairing failures also answer 401 but must not be treated as a lost session. */
  ignoreUnauthorized?: boolean;
}

async function readFailure(response: Response): Promise<ApiRequestError> {
  let code = "http_error";
  let message = t("The request failed with status {status}.", { status: response.status });
  try {
    const payload = (await response.json()) as Partial<ApiError> | null;
    if (payload && typeof payload === "object" && payload.error && typeof payload.error.message === "string") {
      message = payload.error.message;
      if (typeof payload.error.code === "string") code = payload.error.code;
    }
  } catch {
    // Non-JSON error bodies keep the generic message.
  }
  return new ApiRequestError(message, code, response.status);
}

function networkFailure(error: unknown): unknown {
  if (isAbortError(error) || error instanceof ApiRequestError) return error;
  return new ApiRequestError(t("DevHub could not be reached. Check that the local manager is running."), "network", 0);
}

async function send(method: "GET" | "POST" | "DELETE", path: string, options: RequestOptions, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, ...options.headers };
  const init: RequestInit = { method, credentials: "same-origin", cache: "no-store", signal: options.signal, headers };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (error) {
    throw networkFailure(error);
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    if (failure.status === 401 && !options.ignoreUnauthorized && !options.signal?.aborted) unauthorizedListener?.();
    throw failure;
  }
  return response;
}

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(method, path, options, "application/json");
  try {
    const payload = (await response.json()) as Partial<ApiSuccess<T>> | null;
    if (payload && typeof payload === "object" && "data" in payload) return payload.data as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  throw new ApiRequestError(t("DevHub returned an unexpected response."), "bad_response", response.status);
}

const id = encodeURIComponent;

export interface SessionState { authenticated: boolean }

export type EnvironmentObserved = "creating" | "starting" | "ready" | "degraded" | "error" | "stopping" | "stopped" | "destroying" | "destroyed";
export interface EnvironmentRecipeSummary { id: string }
export interface FeatureEnvironment {
  id: string;
  project: string;
  feature: string;
  observed: EnvironmentObserved;
  desired: "running" | "stopped" | "destroyed";
  observationError?: { code: string; message: string };
  preview?: { url: string; port: number; domainUrl?: string; tunnel?: { remoteHost: string; remotePort: number } };
  operation?: { step: string; error?: { code: string; message: string } };
  configuration?: { services?: string[] };
  resources?: { containers?: { id: string; name: string; service: string; state: string; health?: string }[] };
  [key: string]: unknown;
}

export interface CreateEnvironmentInput {
  project: string;
  feature: string;
  refs?: Record<string, string>;
  branches?: Record<string, string>;
  idempotencyKey?: string;
  build?: boolean;
}

export const getSession = (signal?: AbortSignal) => request<SessionState>("GET", "/session", { signal });
export const pair = (code: string, signal?: AbortSignal) =>
  request<SessionState>("POST", "/pair", { body: { code }, signal, ignoreUnauthorized: true });
export const logout = (signal?: AbortSignal) => request<SessionState>("POST", "/logout", { signal });

export const listEnvironments = (signal?: AbortSignal) => request<FeatureEnvironment[]>("GET", "/environments", { signal });
export const listEnvironmentRecipes = (signal?: AbortSignal) => request<EnvironmentRecipeSummary[]>("GET", "/environments/recipes", { signal });
export const getEnvironment = (environmentId: string, signal?: AbortSignal) => request<FeatureEnvironment>("GET", `/environments/${id(environmentId)}`, { signal });
export const previewEnvironment = (environmentId: string, signal?: AbortSignal) => request<NonNullable<FeatureEnvironment["preview"]>>("POST", `/environments/${id(environmentId)}/preview`, { signal });
export const createEnvironment = (input: CreateEnvironmentInput, signal?: AbortSignal) => request<FeatureEnvironment>("POST", "/environments", { body: input, signal });
export const startEnvironment = (environmentId: string, build?: boolean, signal?: AbortSignal) => request<FeatureEnvironment>("POST", `/environments/${id(environmentId)}/start`, { body: build === undefined ? {} : { build }, signal });
export const stopEnvironment = (environmentId: string, signal?: AbortSignal) => request<FeatureEnvironment>("POST", `/environments/${id(environmentId)}/stop`, { signal });
export const removeEnvironment = (environmentId: string, signal?: AbortSignal) => request<FeatureEnvironment>("DELETE", `/environments/${id(environmentId)}`, { body: {}, signal });

export const listRoots = (signal?: AbortSignal) => request<Root[]>("GET", "/roots", { signal });
export const addRoot = (path: string, signal?: AbortSignal) => request<Root>("POST", "/roots", { body: { path }, signal });
export const listDirectories = (path: string | undefined, signal?: AbortSignal) =>
  request<DirectoryListing>("GET", `/directories${path ? `?path=${id(path)}` : ""}`, { signal });
export const getVersions = (signal?: AbortSignal) => request<VersionReport | null>("GET", "/versions", { signal });
export const checkVersions = (signal?: AbortSignal) => request<VersionReport>("POST", "/versions/check", { signal });
export const listStacks = (signal?: AbortSignal) => request<StackDefinition[]>("GET", "/stacks", { signal });
export const previewCreation = (input: CreateInput | CreateDraft, signal?: AbortSignal) =>
  request<CreatePlan>("POST", "/creations/preview", { body: input, signal });
export const createNewProject = (input: CreateInput, signal?: AbortSignal) =>
  request<{ project: PublicProject; operation: Operation; url: string }>("POST", "/creations", { body: input, signal });
export const listPresets = (signal?: AbortSignal) => request<Preset[]>("GET", "/presets", { signal });
export const discover = (path: string, signal?: AbortSignal) =>
  request<PublicDetection[]>("POST", "/discovery", { body: { path }, signal });
export const previewProject = (input: SetupInput, signal?: AbortSignal) =>
  request<PublicSetupPlan>("POST", "/projects/preview", { body: input, signal });
export const createProject = (planId: string, signal?: AbortSignal) =>
  request<PublicProject>("POST", "/projects", { body: { planId }, signal });
export const listProjects = (signal?: AbortSignal) => request<PublicProject[]>("GET", "/projects", { signal });
export const removeProject = (projectId: string, signal?: AbortSignal) =>
  request<{ removed: boolean }>("DELETE", `/projects/${id(projectId)}`, { signal });
export const removeWorktree = (worktreeId: string, force: boolean, signal?: AbortSignal) =>
  request<{ removed: string; keptVolume?: string }>("DELETE", `/worktrees/${id(worktreeId)}`, { body: { force }, signal });
export const getProjectStatus = (projectId: string, signal?: AbortSignal) =>
  request<ProjectStatus>("GET", `/projects/${id(projectId)}/status`, { signal });
export const listProjectOperations = (projectId: string, signal?: AbortSignal) =>
  request<Operation[]>("GET", `/projects/${id(projectId)}/operations`, { signal });

export function submitOperation(projectId: string, action: Action, componentIds: string[], idempotencyKey: string, signal?: AbortSignal) {
  return request<Operation>("POST", `/projects/${id(projectId)}/operations`, {
    body: { action, componentIds },
    headers: { "Idempotency-Key": idempotencyKey },
    signal,
  });
}
export const getOperation = (operationId: string, signal?: AbortSignal) =>
  request<Operation>("GET", `/operations/${id(operationId)}`, { signal });

export interface WaitOptions {
  intervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (operation: Operation) => void;
}

export function isTerminal(operation: Operation): boolean {
  return operation.state === "succeeded" || operation.state === "failed" || operation.state === "unknown";
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls an operation until it reaches a terminal state, with a finite deadline and cancellation. */
export async function waitForOperation(initial: Operation, signal: AbortSignal, options: WaitOptions = {}): Promise<Operation> {
  const { intervalMs = 750, maxIntervalMs = 3000, timeoutMs = 15 * 60_000, onUpdate } = options;
  const deadline = Date.now() + timeoutMs;
  let operation = initial;
  let delay = intervalMs;
  let transientFailures = 0;
  while (!isTerminal(operation)) {
    if (Date.now() >= deadline) {
      throw new ApiRequestError(t("The operation is still running. Refresh the project status to check its outcome."), "poll_timeout", 0);
    }
    await sleep(delay, signal);
    try {
      operation = await getOperation(operation.id, signal);
      transientFailures = 0;
    } catch (error) {
      const retryable = error instanceof ApiRequestError && (error.status === 0 || error.status >= 500);
      if (!retryable || ++transientFailures > 2) throw error;
    }
    onUpdate?.(operation);
    delay = Math.min(Math.round(delay * 1.4), maxIntervalMs);
  }
  return operation;
}

export const listContainers = (signal?: AbortSignal) => request<ContainerInfo[]>("GET", "/containers", { signal });
export const scanImage = (imageId: string, signal?: AbortSignal) =>
  request<Scan>("POST", "/scans", { body: { imageId }, signal });
export const listScans = (signal?: AbortSignal) => request<Scan[]>("GET", "/scans", { signal });
export const listChanges = (signal?: AbortSignal) => request<PublicChange[]>("GET", "/remediation", { signal });
export const previewChange = (input: RemediationInput, signal?: AbortSignal) =>
  request<PublicChange>("POST", "/remediation/preview", { body: input, signal });
export const applyChange = (changeId: string, signal?: AbortSignal) =>
  request<PublicChange>("POST", "/remediation/apply", { body: { changeId }, signal });
export const validateChange = (changeId: string, signal?: AbortSignal) =>
  request<PublicChange>("POST", "/remediation/validate", { body: { changeId }, signal });
export const activateChange = (changeId: string, signal?: AbortSignal) =>
  request<PublicChange>("POST", "/remediation/activate", { body: { changeId }, signal });

export interface LogStreamOptions {
  cursor?: number;
  limit?: number;
  signal: AbortSignal;
  onOpen?: () => void;
  onEntry: (entry: LogEntry) => void;
  /** The server could not honor the cursor. The cursor it reports, if any, replaces ours. */
  onReset: (cursor?: number) => void;
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return Number.isSafeInteger(entry.seq) && typeof entry.time === "string" && typeof entry.projectId === "string"
    && typeof entry.componentId === "string" && (entry.stream === "stdout" || entry.stream === "stderr")
    && typeof entry.message === "string";
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function dispatchEvent(event: string, data: string, options: LogStreamOptions): void {
  if (event === "log") {
    const entry = parseJson(data);
    if (isLogEntry(entry)) options.onEntry(entry);
  } else if (event === "reset") {
    const payload = parseJson(data) as { cursor?: unknown; seq?: unknown } | undefined;
    const cursor = payload && typeof payload === "object" ? (payload.cursor ?? payload.seq) : undefined;
    options.onReset(typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined);
  } else if (event === "error") {
    const payload = parseJson(data) as Partial<ApiError["error"]> | undefined;
    const message = payload && typeof payload.message === "string" ? payload.message : "The log stream reported an error.";
    throw new ApiRequestError(message, typeof payload?.code === "string" ? payload.code : "stream_error", 0);
  }
}

/**
 * Reads one finite server-sent-event log stream. Resolves when the server closes it
 * normally; callers reconnect with the last numeric cursor. Uses fetch rather than
 * EventSource so aborts, 401 handling and the cursor stay under explicit control.
 */
export async function streamLogs(projectId: string, options: LogStreamOptions): Promise<void> {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", String(options.cursor));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const headers: Record<string, string> = {};
  if (options.cursor !== undefined) headers["Last-Event-ID"] = String(options.cursor);
  const suffix = query.size > 0 ? `?${query}` : "";
  const response = await send("GET", `/projects/${id(projectId)}/logs${suffix}`, { signal: options.signal, headers }, "text/event-stream");
  if (!response.body) throw new ApiRequestError(t("The log stream returned no body."), "bad_response", response.status);
  options.onOpen?.();
  await readEventStream(response.body, (event, data) => dispatchEvent(event, data, options));
}

export interface ContainerLogEntry { seq: number; time: string; stream: "stdout" | "stderr"; message: string }

export interface ContainerLogStreamOptions {
  since?: string;
  signal: AbortSignal;
  onOpen?: () => void;
  onEntry: (entry: ContainerLogEntry) => void;
  /** The server skipped this many lines to protect the panel from a very chatty container. */
  onDropped: (count: number) => void;
}

/** Follows one container until the server closes the stream; `since` resumes after a reconnect. */
export async function streamContainerLogs(containerId: string, options: ContainerLogStreamOptions): Promise<void> {
  const suffix = options.since ? `?${new URLSearchParams({ since: options.since })}` : "";
  const response = await send("GET", `/containers/${id(containerId)}/logs${suffix}`, { signal: options.signal }, "text/event-stream");
  if (!response.body) throw new ApiRequestError(t("The log stream returned no body."), "bad_response", response.status);
  options.onOpen?.();
  await readEventStream(response.body, (event, data) => {
    const payload = parseJson(data) as Record<string, unknown> | undefined;
    if (event === "log" && payload && typeof payload.time === "string" && typeof payload.message === "string") options.onEntry(payload as unknown as ContainerLogEntry);
    else if (event === "dropped" && typeof payload?.count === "number") options.onDropped(payload.count);
    else if (event === "error") throw new ApiRequestError(typeof payload?.message === "string" ? payload.message : "The log stream reported an error.", "stream_error", 0);
  });
}

async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const handleLine = (line: string) => {
    if (line === "") {
      if (data.length > 0) onEvent(event, data.join("\n"));
      event = "message";
      data = [];
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw networkFailure(error);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new ApiRequestError(t("The log stream sent an oversized event."), "bad_response", 0);
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      lines.forEach(handleLine);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
