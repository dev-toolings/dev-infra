import * as React from "react";
import { ApiRequestError, errorMessage, isAbortError, isUnauthorized, sleep, streamContainerLogs, type ContainerLogEntry } from "./api";
import { MAX_LOG_ENTRIES } from "./use-log-stream";

const FLUSH_MS = 80;
const RECONNECT_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
// Leaves the first batch time to arrive, so a talkative container never flashes the empty state.
const EMPTY_AFTER_MS = 500;

export interface ContainerLogs {
  entries: ContainerLogEntry[];
  /** Lines the server skipped because the container wrote faster than the panel can follow. */
  dropped: number;
  error: string | undefined;
  loading: boolean;
}

const initial: ContainerLogs = { entries: [], dropped: 0, error: undefined, loading: true };

/**
 * Follows one container while mounted: closing the panel aborts the request, which ends the
 * `docker logs` process on the server. A running container reconnects from its last timestamp;
 * a stopped one is read once.
 */
export function useContainerLogs(containerId: string, live: boolean): ContainerLogs {
  const [logs, setLogs] = React.useState(initial);

  React.useEffect(() => {
    setLogs(initial);
    const controller = new AbortController();
    const { signal } = controller;
    let pending: ContainerLogEntry[] = [];
    let skipped = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled: ReturnType<typeof setTimeout> | undefined;
    let since: string | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (pending.length === 0 && skipped === 0) return;
      const batch = pending, count = skipped;
      pending = []; skipped = 0;
      setLogs((current) => ({ ...current, entries: [...current.entries, ...batch].slice(-MAX_LOG_ENTRIES), dropped: current.dropped + count }));
    };
    const schedule = () => { if (timer === undefined) timer = setTimeout(flush, FLUSH_MS); };

    void (async () => {
      let failures = 0;
      while (!signal.aborted) {
        const after = since;
        try {
          await streamContainerLogs(containerId, {
            since: after,
            signal,
            onOpen: () => {
              setLogs((current) => ({ ...current, error: undefined }));
              settled = setTimeout(() => setLogs((current) => ({ ...current, loading: false })), EMPTY_AFTER_MS);
            },
            onEntry: (entry) => {
              if (after && entry.time <= after) return;
              if (!since || entry.time > since) since = entry.time;
              pending.push(entry);
              schedule();
            },
            onDropped: (count) => { skipped += count; schedule(); },
          });
          failures = 0;
        } catch (caught) {
          if (signal.aborted || isAbortError(caught)) break;
          flush();
          if (isUnauthorized(caught)) break;
          setLogs((current) => ({ ...current, error: errorMessage(caught), loading: false }));
          // Docker refused this container (no logging driver, removed): retrying would only repeat the error.
          if (caught instanceof ApiRequestError && (caught.code === "stream_error" || (caught.status >= 400 && caught.status < 500 && caught.status !== 429))) break;
          failures += 1;
        }
        flush();
        if (!live && failures === 0) break;
        try { await sleep(Math.min(RECONNECT_MS * 2 ** failures, MAX_BACKOFF_MS), signal); } catch { break; }
      }
    })();

    return () => { controller.abort(); clearTimeout(settled); flush(); };
  }, [containerId, live]);

  return logs;
}
