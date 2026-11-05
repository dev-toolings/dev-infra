import { t } from "./i18n";
import * as React from "react";
import type { Action, Operation } from "../../../../src/contracts";
import { errorMessage, isAbortError, submitOperation, waitForOperation } from "./api";
import type { Lifetime } from "./use-lifetime";

const MAX_TRACKED_OPERATIONS = 20;
const busyKey = (projectId: string, componentId: string) => `${projectId}\u001f${componentId}`;

export interface Lifecycle {
  operations: Operation[];
  error: { projectId: string; message: string } | undefined;
  busyComponentIds: (projectId: string | undefined) => string[];
  run: (projectId: string, action: Action, componentIds: string[]) => Promise<void>;
  /** Follows an operation started elsewhere, such as the first start of a new project. */
  follow: (operation: Operation) => Promise<void>;
  dismissError: () => void;
}

function outcomeMessage(operation: Operation): string | undefined {
  if (operation.state === "succeeded") return undefined;
  if (operation.error) return operation.error;
  if (operation.state === "unknown") return t("The outcome could not be confirmed. Check the component status.");
  return t("The operation did not complete.");
}

/**
 * Submits component lifecycle operations and follows them to a terminal state. A component
 * with an operation in flight accepts no second one, so duplicate clicks cannot repeat it.
 */
export function useLifecycle(lifetime: Lifetime, onSettled: (projectId: string) => void): Lifecycle {
  const [operations, setOperations] = React.useState<Operation[]>([]);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const [error, setError] = React.useState<Lifecycle["error"]>();
  const inFlight = React.useRef(new Set<string>());
  const settled = React.useRef(onSettled);
  settled.current = onSettled;

  const track = React.useCallback((operation: Operation) => {
    setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)].slice(0, MAX_TRACKED_OPERATIONS));
  }, []);

  const settle = React.useCallback(async (projectId: string, componentIds: string[], start: (signal: AbortSignal) => Promise<Operation>) => {
    const signal = lifetime();
    const keys = componentIds.map((id) => busyKey(projectId, id));
    if (!signal || keys.length === 0 || keys.some((key) => inFlight.current.has(key))) return;
    keys.forEach((key) => inFlight.current.add(key));
    setBusy(new Set(inFlight.current));
    setError(undefined);
    try {
      const submitted = await start(signal);
      track(submitted);
      const finished = await waitForOperation(submitted, signal, { onUpdate: track });
      track(finished);
      const message = outcomeMessage(finished);
      if (message) setError({ projectId, message });
    } catch (caught) {
      if (!isAbortError(caught)) setError({ projectId, message: errorMessage(caught) });
    } finally {
      keys.forEach((key) => inFlight.current.delete(key));
      if (!signal.aborted) {
        setBusy(new Set(inFlight.current));
        settled.current(projectId);
      }
    }
  }, [lifetime, track]);

  const run = React.useCallback((projectId: string, action: Action, componentIds: string[]) =>
    settle(projectId, componentIds, (signal) => submitOperation(projectId, action, componentIds, crypto.randomUUID(), signal)), [settle]);
  const follow = React.useCallback((operation: Operation) =>
    settle(operation.projectId, operation.componentIds, async () => operation), [settle]);

  const busyComponentIds = React.useCallback((projectId: string | undefined) => {
    if (!projectId) return [];
    const prefix = `${projectId}\u001f`;
    return Array.from(busy, (key) => key.startsWith(prefix) ? key.slice(prefix.length) : "").filter(Boolean);
  }, [busy]);

  return { operations, error, busyComponentIds, run, follow, dismissError: () => setError(undefined) };
}
