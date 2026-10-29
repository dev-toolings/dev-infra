import * as React from "react";
import type { LogEntry } from "../../../../src/contracts";
import { ApiRequestError, errorMessage, isAbortError, isUnauthorized, sleep, streamLogs } from "./api";

export const MAX_LOG_ENTRIES = 1000;
const INITIAL_LIMIT = 500;
const FLUSH_MS = 80;
const IDLE_RECONNECT_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RESETS_WITHOUT_PROGRESS = 3;

interface LogState { projectId: string | undefined; entries: LogEntry[]; lastSeq: number }

type LogAction =
  | { type: "project"; projectId: string | undefined }
  | { type: "append"; projectId: string; entries: LogEntry[] }
  | { type: "reset"; projectId: string; seq: number }
  | { type: "clear"; projectId: string | undefined };

const empty = (projectId: string | undefined): LogState => ({ projectId, entries: [], lastSeq: 0 });

function reducer(state: LogState, action: LogAction): LogState {
  switch (action.type) {
    case "project":
      return state.projectId === action.projectId ? state : empty(action.projectId);
    case "clear":
      return state.projectId === action.projectId ? { ...state, entries: [] } : state;
    case "reset":
      return state.projectId === action.projectId ? { projectId: state.projectId, entries: [], lastSeq: action.seq } : state;
    case "append": {
      if (state.projectId !== action.projectId) return state;
      let lastSeq = state.lastSeq;
      const fresh: LogEntry[] = [];
      for (const entry of action.entries) {
        if (entry.seq <= lastSeq) continue;
        lastSeq = entry.seq;
        fresh.push(entry);
      }
      if (fresh.length === 0) return state;
      return { ...state, lastSeq, entries: [...state.entries, ...fresh].slice(-MAX_LOG_ENTRIES) };
    }
  }
}

export interface LogStream {
  entries: LogEntry[];
  error: string | undefined;
  /** No stream attempt has finished yet for the current project. */
  loading: boolean;
  clear: () => void;
}

/**
 * Follows the finite SSE log stream of one project. Reconnects with the last numeric cursor
 * and exponential backoff, keeps at most 1000 entries, and aborts on pause, project switch
 * or unmount. Entries already seen are never appended twice.
 */
export function useLogStream(projectId: string | undefined, active: boolean): LogStream {
  const [state, dispatch] = React.useReducer(reducer, undefined, () => empty(projectId));
  const [error, setError] = React.useState<{ projectId: string | undefined; message: string }>();
  const [settledProjectId, setSettledProjectId] = React.useState<string>();
  const cursorRef = React.useRef<{ projectId: string | undefined; seq: number | undefined }>({ projectId, seq: undefined });

  React.useEffect(() => {
    dispatch({ type: "project", projectId });
    cursorRef.current = { projectId, seq: undefined };
    setError(undefined);
  }, [projectId]);

  React.useEffect(() => {
    if (!projectId || !active) return;
    const controller = new AbortController();
    const { signal } = controller;
    let pending: LogEntry[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      dispatch({ type: "append", projectId, entries: batch });
    };

    const cursor = cursorRef.current.projectId === projectId ? cursorRef.current : { projectId, seq: undefined };
    cursorRef.current = cursor;

    void (async () => {
      let failures = 0;
      let resetsWithoutProgress = 0;
      while (!signal.aborted) {
        let progressed = false;
        let failed = false;
        try {
          await streamLogs(projectId, {
            cursor: cursor.seq,
            limit: cursor.seq === undefined ? INITIAL_LIMIT : MAX_LOG_ENTRIES,
            signal,
            onOpen: () => {
              setError(undefined);
              setSettledProjectId(projectId);
            },
            onEntry: (entry) => {
              if (cursor.seq !== undefined && entry.seq <= cursor.seq) return;
              cursor.seq = entry.seq;
              progressed = true;
              pending.push(entry);
              if (timer === undefined) timer = setTimeout(flush, FLUSH_MS);
            },
            onReset: (next) => {
              flush();
              cursor.seq = next;
              resetsWithoutProgress += 1;
              dispatch({ type: "reset", projectId, seq: next ?? 0 });
            },
          });
        } catch (caught) {
          if (signal.aborted || isAbortError(caught)) break;
          flush();
          if (isUnauthorized(caught)) break;
          const permanent = caught instanceof ApiRequestError && caught.status >= 400 && caught.status < 500 && caught.status !== 429;
          setError({ projectId, message: errorMessage(caught) });
          if (permanent) break;
          failed = true;
        }
        flush();
        if (!signal.aborted) setSettledProjectId(projectId);
        if (progressed) { failures = 0; resetsWithoutProgress = 0; }
        if (resetsWithoutProgress > MAX_RESETS_WITHOUT_PROGRESS) {
          setError({ projectId, message: "The log stream keeps resetting its cursor, so following was stopped. Switch views to try again." });
          break;
        }
        failures = failed ? failures + 1 : 0;
        const delay = failed ? Math.min(IDLE_RECONNECT_MS * 2 ** failures, MAX_BACKOFF_MS) : IDLE_RECONNECT_MS;
        try { await sleep(delay, signal); } catch { break; }
      }
    })();

    return () => {
      controller.abort();
      flush();
    };
  }, [projectId, active]);

  const clear = React.useCallback(() => dispatch({ type: "clear", projectId }), [projectId]);
  const current = state.projectId === projectId;
  return {
    entries: current ? state.entries : [],
    error: error && error.projectId === projectId ? error.message : undefined,
    loading: Boolean(projectId) && active && settledProjectId !== projectId && !(current && state.entries.length > 0),
    clear,
  };
}
