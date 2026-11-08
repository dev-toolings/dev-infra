import { t } from "../../lib/i18n";
import { ArrowDown, Pause, Play, Trash2 } from "lucide-react";
import type { LogEntry, PublicComponent } from "../../../../../src/contracts";
import { MAX_LOG_ENTRIES } from "../../lib/use-log-stream";
import { useStickToBottom } from "../../lib/use-stick-to-bottom";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState, ErrorState } from "../ui/state";
import { LogRow } from "./container-logs";
import { LogsSkeleton } from "./skeletons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

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
  const names = new Map(options.map((component) => [component.id, component.name]));
  const visibleEntries = componentFilter ? entries.filter((entry) => entry.componentId === componentFilter) : entries;
  const selectValue = componentFilter ? `component:${componentFilter}` : "all";
  const several = options.length > 1;
  const showEntries = !error && !loading && visibleEntries.length > 0;
  const { scroller, list, stuck, onScroll, toBottom } = useStickToBottom(showEntries);

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label={t("Project logs")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {several || componentFilter ? (
          <Select
            value={selectValue}
            onValueChange={(value) => onComponentFilterChange(value === "all" ? undefined : value.slice("component:".length))}
          >
            <SelectTrigger className="sm:w-56" aria-label={t("Filter logs by component")}>
              <SelectValue placeholder={t("All components")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All components")}</SelectItem>
              {options.map((component) => (
                <SelectItem key={component.id} value={`component:${component.id}`}>{component.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {error || loading ? null : (
          <>
            <Badge variant={paused ? "degraded" : "outline"}>{paused ? t("Paused") : t("Following")}</Badge>
            <span className="tabular text-xs text-muted-foreground">
              {visibleEntries.length === 1 ? t("1 entry") : t("{count} entries", { count: visibleEntries.length })}
            </span>
          </>
        )}
        {entries.length >= MAX_LOG_ENTRIES ? <span className="text-xs text-muted-foreground">{t("Older entries are dropped past 1,000")}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" aria-pressed={paused} onClick={() => onPausedChange(!paused)}>
            {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {paused ? t("Resume updates") : t("Pause updates")}
          </Button>
          <Button type="button" variant="outline" disabled={entries.length === 0} onClick={onClear}>
            <Trash2 aria-hidden="true" />
            {t("Clear view")}
          </Button>
        </div>
      </div>

      {error ? <ErrorState description={error} className="min-h-96 flex-1" /> : loading ? <LogsSkeleton /> : null}
      {!error && !loading && visibleEntries.length === 0 ? (
        paused && entries.length === 0
          ? <EmptyState title={t("Updates are paused")} description={t("Resume updates to load the logs of this project.")} className="min-h-96 flex-1" />
          : <EmptyState title={t("No log entries")} description={t("No entries are available for the current project and component filter.")} className="min-h-96 flex-1" />
      ) : null}

      {showEntries ? (
        <div className="relative flex min-h-96 min-w-0 flex-1 flex-col">
          <div
            ref={scroller}
            tabIndex={0}
            onScroll={onScroll}
            className="min-h-0 min-w-0 flex-1 basis-0 overflow-y-auto overflow-x-hidden rounded-xl border bg-log-panel py-2 outline-none [scrollbar-color:var(--log-muted)_transparent] [scrollbar-width:thin] focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ol ref={list} role="log" aria-label={t("Recent project log entries")} aria-live="off" className="min-w-0">
              {visibleEntries.map((entry) => (
                <LogRow
                  key={entry.seq}
                  entry={entry}
                  source={several && !componentFilter ? names.get(entry.componentId) ?? entry.componentId : undefined}
                  showStderr
                />
              ))}
            </ol>
          </div>
          {!stuck ? (
            <Button type="button" variant="secondary" size="sm" className="absolute right-4 bottom-3 shadow-sm" onClick={toBottom}>
              {t("Jump to latest")} <ArrowDown aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
