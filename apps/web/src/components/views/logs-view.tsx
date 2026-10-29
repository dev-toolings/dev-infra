import { Pause, Play, Trash2 } from "lucide-react";
import type { ComponentKind, LogEntry, PublicComponent } from "../../../../../src/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ViewHeading } from "./shared";

type LogComponent = Pick<PublicComponent, "id" | "name" | "kind">;

export interface LogsViewProps {
  entries: LogEntry[];
  componentFilter?: string;
  components?: LogComponent[];
  paused: boolean;
  loading?: boolean;
  error?: string;
  onComponentFilterChange: (componentId: string | undefined) => void | Promise<void>;
  onPausedChange: (paused: boolean) => void | Promise<void>;
  onClear: () => void | Promise<void>;
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function sourceLabel(kind?: ComponentKind): string {
  if (kind === "native") return "Native";
  if (kind === "compose") return "Docker / Compose";
  return "Source unknown";
}

export function LogsView({
  entries,
  componentFilter,
  components = [],
  paused,
  loading = false,
  error,
  onComponentFilterChange,
  onPausedChange,
  onClear,
}: LogsViewProps) {
  const seenIds = new Set(entries.map((entry) => entry.componentId));
  const options = components.length > 0
    ? components
    : Array.from(seenIds, (id) => ({ id, name: id, kind: undefined }));
  const componentById = new Map(options.map((component) => [component.id, component]));
  const filteredEntries = componentFilter ? entries.filter((entry) => entry.componentId === componentFilter) : entries;
  const newestEntries = filteredEntries.slice(-1000);
  const selectValue = componentFilter ? `component:${componentFilter}` : "all";

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="logs-heading">
      <ViewHeading
        title="Project logs"
        titleId="logs-heading"
        description="Merged native and Docker output for the selected project. This view keeps at most the newest 1,000 entries."
        action={(
          <>
            <Button type="button" variant="outline" aria-pressed={paused} onClick={() => onPausedChange(!paused)}>
              {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              {paused ? "Resume updates" : "Pause updates"}
            </Button>
            <Button type="button" variant="outline" disabled={entries.length === 0} onClick={onClear}>
              <Trash2 aria-hidden="true" />
              Clear view
            </Button>
          </>
        )}
      />
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full max-w-sm space-y-2">
          <Label htmlFor="log-component-filter">Component</Label>
          <Select
            value={selectValue}
            onValueChange={(value) => onComponentFilterChange(value === "all" ? undefined : value.slice("component:".length))}
          >
            <SelectTrigger id="log-component-filter" aria-label="Filter logs by component">
              <SelectValue placeholder="All components" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All components</SelectItem>
              {options.map((component) => (
                <SelectItem key={component.id} value={`component:${component.id}`}>{component.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={paused ? "secondary" : "outline"}>{paused ? "Paused" : "Following"}</Badge>
          <span>{newestEntries.length} {newestEntries.length === 1 ? "entry" : "entries"}</span>
          {filteredEntries.length > newestEntries.length ? <span>Showing newest 1,000 of {filteredEntries.length}</span> : null}
        </div>
      </div>

      {error ? <ErrorState description={error} /> : loading ? <LoadingState label="Loading project logs" rows={3} /> : null}
      {!error && !loading && newestEntries.length === 0 ? (
        <EmptyState title="No log entries" description="No entries are available for the current project and component filter." />
      ) : null}

      {!error && !loading && newestEntries.length > 0 ? (
        <ol
          role="log"
          aria-label="Recent project log entries"
          aria-live="off"
          className="max-h-[min(68dvh,48rem)] min-w-0 overflow-y-auto overflow-x-hidden rounded-lg border border-log-panel bg-log-panel px-3 text-log-foreground sm:px-4"
        >
          {newestEntries.map((entry, index) => {
            const component = componentById.get(entry.componentId);
            return (
              <li key={`${entry.seq}:${entry.sourceId ?? "source"}:${index}`} className="min-w-0 border-b border-log-foreground/10 py-2.5 last:border-b-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-log-muted">
                  <time dateTime={entry.time}>{formatLogTime(entry.time)}</time>
                  <Badge variant={entry.stream === "stderr" ? "destructive" : "muted"} className="px-2 py-0.5 text-[11px]">
                    {entry.stream}
                  </Badge>
                  <span className="break-all text-log-foreground">{component?.name ?? entry.componentId}</span>
                  <span>{sourceLabel(component?.kind)}</span>
                </div>
                <pre className="m-0 mt-1 min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-log-foreground">{entry.message}</pre>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
