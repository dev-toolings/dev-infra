import * as React from "react";
import { ArrowDown } from "lucide-react";
import type { ContainerLogEntry } from "../../lib/api";
import { useContainerLogs } from "../../lib/use-container-logs";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState, ErrorState } from "../ui/state";

const STICK_THRESHOLD_PX = 48;

function clock(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour12: false });
}

// Memoized so a new batch renders only its own rows, not the 1,000 already on screen.
const LogRow = React.memo(function LogRow({ entry }: { entry: ContainerLogEntry }) {
  return (
    <li className="flex min-w-0 gap-3 px-3 py-px font-mono text-xs leading-5 [contain-intrinsic-size:auto_20px] [content-visibility:auto]">
      <time dateTime={entry.time} className="tabular shrink-0 text-log-muted">{clock(entry.time)}</time>
      <span className={`min-w-0 whitespace-pre-wrap break-words ${entry.stream === "stderr" ? "text-destructive" : "text-log-foreground"}`}>{entry.message}</span>
    </li>
  );
});

export function ContainerLogs({ containerId, live }: { containerId: string; live: boolean }) {
  const { entries, dropped, error, loading } = useContainerLogs(containerId, live);
  const scroller = React.useRef<HTMLOListElement>(null);
  const [stuck, setStuck] = React.useState(true);

  const toBottom = React.useCallback(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    setStuck(true);
  }, []);

  React.useLayoutEffect(() => {
    if (stuck && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries, stuck]);

  const onScroll = (event: React.UIEvent<HTMLOListElement>) => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    setStuck(scrollHeight - scrollTop - clientHeight < STICK_THRESHOLD_PX);
  };

  return (
    <section aria-labelledby="container-logs" className="flex min-h-96 min-w-0 flex-1 flex-col gap-2 lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="container-logs" className="text-sm font-semibold">Logs</h3>
        <Badge variant={live ? "outline" : "muted"}>{live ? "Live" : "Stopped"}</Badge>
        <span className="tabular text-xs text-muted-foreground">{entries.length} lines</span>
        {dropped > 0 ? <span className="tabular text-xs text-muted-foreground">{dropped} skipped, too fast to display</span> : null}
        {!stuck ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={toBottom}>
            Jump to latest <ArrowDown aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {error ? <ErrorState description={error} /> : null}
      {!error && !loading && entries.length === 0 ? <EmptyState title="No log output" description={live ? "This container has written nothing yet." : "This container left no logs."} className="min-h-36" /> : null}
      {entries.length > 0 ? (
        <ol
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label="Container log output"
          aria-live="off"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-log-panel bg-log-panel py-2"
        >
          {entries.map((entry) => <LogRow key={`${entry.time}:${entry.seq}`} entry={entry} />)}
        </ol>
      ) : null}
    </section>
  );
}
