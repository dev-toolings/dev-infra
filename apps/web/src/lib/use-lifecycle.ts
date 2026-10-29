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
  dismissError: () => void;
}

function outcomeMessage(operation: Operation): string | undefined {
  if (operation.state === "succeeded") return undefined;
  if (operation.error) return operation.error;
  if (operation.state === "unknown") return `The ${operation.action} outcome could not be confirmed. Check the component status.`;
  return `The ${operation.action} operation ${operation.state}.`;
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

  const run = React.useCallback(async (projectId: string, action: Action, componentIds: string[]) => {
    const signal = lifetime();
    const keys = componentIds.map((id) => busyKey(projectId, id));
    if (!signal || keys.length === 0 || keys.some((key) => inFlight.current.has(key))) return;
    keys.forEach((key) => inFlight.current.add(key));
    setBusy(new Set(inFlight.current));
    setError(undefined);
    try {
      const submitted = await submitOperation(projectId, action, componentIds, crypto.randomUUID(), signal);
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

  const busyComponentIds = React.useCallback((projectId: string | undefined) => {
    if (!projectId) return [];
    const prefix = `${projectId}\u001f`;
    return Array.from(busy, (key) => key.startsWith(prefix) ? key.slice(prefix.length) : "").filter(Boolean);
  }, [busy]);

  return { operations, error, busyComponentIds, run, dismissError: () => setError(undefined) };
}
