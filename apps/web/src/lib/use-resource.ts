import * as React from "react";
import { errorMessage, isAbortError } from "./api";

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  /** True only until the first result (or failure) for the current key arrives. */
  loading: boolean;
  reload: () => void;
  update: (change: (current: T | undefined) => T) => void;
}

interface Slot<T> { key: string | undefined; data: T | undefined; error: string | undefined }

export interface ResourceOptions {
  /** Re-fetch on this interval while the page is visible. */
  refreshMs?: number;
}

/**
 * Loads one keyed API resource. A key change or unmount aborts the request in flight and
 * drops data that belongs to the previous key; an undefined key disables the resource.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, key: string | undefined, options: ResourceOptions = {}): Resource<T> {
  const [slot, setSlot] = React.useState<Slot<T>>({ key: undefined, data: undefined, error: undefined });
  const [tick, setTick] = React.useState(0);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const loading = React.useRef(false);
  const { refreshMs } = options;

  React.useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    loading.current = true;
    loadRef.current(controller.signal).then(
      (data) => { if (!controller.signal.aborted) { loading.current = false; setSlot({ key, data, error: undefined }); } },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        loading.current = false;
        setSlot((previous) => ({ key, data: previous.key === key ? previous.data : undefined, error: errorMessage(error) }));
      },
    );
    return () => controller.abort();
  }, [key, tick]);

  React.useEffect(() => {
    if (key === undefined || !refreshMs) return;
    // A refresh must not abort a slower read still in flight, or that read would never finish.
    const timer = setInterval(() => { if (document.visibilityState !== "hidden" && !loading.current) setTick((value) => value + 1); }, refreshMs);
    return () => clearInterval(timer);
  }, [key, refreshMs]);

  const current = slot.key === key ? slot : undefined;
  const reload = React.useCallback(() => setTick((value) => value + 1), []);
  const update = React.useCallback((change: (value: T | undefined) => T) => {
    setSlot((previous) => ({ key, data: change(previous.key === key ? previous.data : undefined), error: previous.key === key ? previous.error : undefined }));
  }, [key]);

  return {
    data: current?.data,
    error: current?.error,
    loading: key !== undefined && current === undefined,
    reload,
    update,
  };
}
