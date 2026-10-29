import * as React from "react";
import type { PublicChange, RemediationInput, Scan } from "../../../../src/contracts";
import { activateChange, applyChange, errorMessage, isAbortError, listChanges, listScans, previewChange, scanImage, validateChange } from "./api";
import type { Lifetime } from "./use-lifetime";
import { useResource } from "./use-resource";

function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  return [item, ...(list ?? []).filter((existing) => existing.id !== item.id)];
}

/**
 * Scan and remediation state. Every mutation is a separate, explicit call and runs one at a
 * time. Nothing retries or advances to the next step on its own.
 */
export function useMaintenance(lifetime: Lifetime, enabled: boolean) {
  const scans = useResource(listScans, enabled ? "scans" : undefined);
  const changes = useResource(listChanges, enabled ? "changes" : undefined);
  const [selectedChangeId, setSelectedChangeId] = React.useState<string>();
  const [scanningImageId, setScanningImageId] = React.useState<string>();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const busy = React.useRef(false);

  const task = React.useCallback(async (work: (signal: AbortSignal) => Promise<void>, onFailure?: () => void) => {
    const signal = lifetime();
    if (!signal || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await work(signal);
    } catch (caught) {
      if (isAbortError(caught) || signal.aborted) return;
      setError(errorMessage(caught));
      onFailure?.();
    } finally {
      busy.current = false;
      if (!signal.aborted) { setPending(false); setScanningImageId(undefined); }
    }
  }, [lifetime]);

  const transition = (call: (changeId: string, signal: AbortSignal) => Promise<PublicChange>) => (changeId: string) =>
    task(async (signal) => {
      const change = await call(changeId, signal);
      changes.update((current) => upsert(current, change));
      setSelectedChangeId(change.id);
    }, changes.reload);

  return {
    scans: scans.data ?? [],
    changes: changes.data ?? [],
    loading: scans.loading || changes.loading,
    loadError: scans.error ?? changes.error,
    busy: pending,
    scanningImageId,
    selectedChangeId,
    error,
    dismissError: () => setError(undefined),
    selectChange: (changeId: string | undefined) => { setSelectedChangeId(changeId); setError(undefined); },
    scan: (imageId: string) => task(async (signal) => {
      setScanningImageId(imageId);
      const scan: Scan = await scanImage(imageId, signal);
      scans.update((current) => upsert(current, scan));
    }),
    preview: (input: RemediationInput) => task(async (signal) => {
      const change = await previewChange(input, signal);
      changes.update((current) => upsert(current, change));
      setSelectedChangeId(change.id);
    }),
    apply: transition(applyChange),
    validate: transition(validateChange),
    activate: transition(activateChange),
  };
}
