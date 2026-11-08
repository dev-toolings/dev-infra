import { locale, t } from "../../lib/i18n";
import * as React from "react";
import { ArrowDown, ChevronRight } from "lucide-react";
import type { ContainerLogEntry } from "../../lib/api";
import { parseAnsi } from "../../lib/ansi";
import { useContainerLogs } from "../../lib/use-container-logs";
import { useStickToBottom } from "../../lib/use-stick-to-bottom";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState, ErrorState } from "../ui/state";

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function clock(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(locale, { hour12: false });
}

function parseJson(message: string): Record<string, unknown> | unknown[] | undefined {
  if (!/^\s*[{[]/.test(message)) return undefined;
  try {
    const value: unknown = JSON.parse(message);
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function field(value: object, keys: string[]): string | undefined {
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string" && item) return item;
  }
  return undefined;
}

function levelTone(level: string): string {
  const name = level.toLowerCase();
  if (/^(err|crit|alert|emerg|fatal|panic)/.test(name)) return "text-red-400";
  if (name.startsWith("warn")) return "text-amber-400";
  if (name.startsWith("info") || name.startsWith("notice")) return "text-sky-400";
  return "text-log-muted";
}

function pretty(value: unknown, fallback: string): string {
  try { return JSON.stringify(value, null, 2); } catch { return fallback; } // Absurdly deep JSON overflows the stack.
}

function JsonTokens({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    nodes.push(text.slice(last, match.index));
    const token = match[1] ?? match[0];
    const tone = match[2] ? "text-sky-300" : match[1] ? "text-emerald-300" : /^[tfn]/.test(token) ? "text-fuchsia-300" : "text-amber-300";
    nodes.push(<span key={match.index} className={tone}>{token}</span>, match[2] ?? "");
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return <>{nodes}</>;
}

// Memoized so a new batch renders only its own rows, not the 1,000 already on screen.
export const LogRow = React.memo(function LogRow({ entry, source, showStderr = false }: { entry: Pick<ContainerLogEntry, "time" | "stream" | "message">; source?: string; showStderr?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const json = React.useMemo(() => parseJson(entry.message), [entry.message]);
  const level = json && field(json, ["level_name", "level", "severity"]);
  const summary = json && field(json, ["message", "msg"]);
  // On a phone, the extra columns would leave the message a third of the row: it takes its own line.
  const message = source || showStderr ? "max-sm:basis-full" : "";
  return (
    <li title={entry.stream} className="flex min-w-0 flex-wrap gap-x-2 px-3 py-px font-mono text-xs leading-5 hover:bg-log-foreground/5">
      <time dateTime={entry.time} className="tabular shrink-0 text-log-muted">{clock(entry.time)}</time>
      {source ? <span title={source} className="w-16 shrink-0 truncate text-log-muted sm:w-28">{source}</span> : null}
      {showStderr ? <span className="w-12 shrink-0 text-red-400">{entry.stream === "stderr" ? entry.stream : null}</span> : null}
      {json ? (
        <div className={`min-w-0 flex-1 ${message}`}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-log-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight aria-hidden="true" className={`size-3 shrink-0 text-log-muted transition-transform ${expanded ? "rotate-90" : ""}`} />
            {level ? <span className={`shrink-0 font-semibold uppercase ${levelTone(level)}`}>{level}</span> : null}
            <span className="truncate">{summary ?? entry.message}</span>
          </button>
          {expanded ? <pre className="m-0 mt-1 mb-2 min-w-0 whitespace-pre-wrap break-words pl-5 text-log-foreground"><JsonTokens text={pretty(json, entry.message)} /></pre> : null}
        </div>
      ) : (
        <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words pl-5 text-log-foreground ${message}`}>
          {parseAnsi(entry.message).map((segment, index) => <span key={index} style={segment.style}>{segment.text}</span>)}
        </span>
      )}
    </li>
  );
});

export function ContainerLogs({ containerId, live }: { containerId: string; live: boolean }) {
  const { entries, dropped, error, loading } = useContainerLogs(containerId, live);
  const { scroller, list, stuck, onScroll, toBottom } = useStickToBottom(entries.length > 0);

  return (
    <section aria-labelledby="container-logs" className="flex min-h-96 min-w-0 flex-1 flex-col gap-2 lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="container-logs" className="text-sm font-semibold">{t("Logs")}</h3>
        <Badge variant={live ? "outline" : "muted"}>{live ? t("Live") : t("Stopped")}</Badge>
        <span className="tabular text-xs text-muted-foreground">{t("{count} lines", { count: entries.length })}</span>
        {dropped > 0 ? <span className="tabular text-xs text-muted-foreground">{t("{count} skipped, too fast to display", { count: dropped })}</span> : null}
        {!stuck ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={toBottom}>
            {t("Jump to latest")} <ArrowDown aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {error ? <ErrorState description={error} /> : null}
      {!error && !loading && entries.length === 0 ? <EmptyState title={t("No log output")} description={live ? t("This container has written nothing yet.") : t("This container left no logs.")} className="min-h-36" /> : null}
      {entries.length > 0 ? (
        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-log-panel bg-log-panel py-2 [scrollbar-color:var(--log-muted)_transparent] [scrollbar-width:thin]"
        >
          <ol ref={list} role="log" aria-label={t("Container log output")} aria-live="off" className="min-w-0">
            {entries.map((entry) => <LogRow key={`${entry.time}:${entry.seq}`} entry={entry} />)}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
