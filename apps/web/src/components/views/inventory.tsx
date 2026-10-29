import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";

export type Tone = "neutral" | "up" | "degraded" | "down" | "muted";

const toneText: Record<Tone, string> = {
  neutral: "text-foreground",
  up: "text-status-up",
  degraded: "text-status-degraded",
  down: "text-status-down",
  muted: "text-muted-foreground",
};

const toneDot: Record<Tone, string> = {
  neutral: "bg-foreground/40",
  up: "bg-status-up",
  degraded: "bg-status-degraded",
  down: "bg-status-down",
  muted: "bg-status-unknown",
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", toneDot[tone], className)} />;
}

/**
 * Summary tile from the webcops dashboard. When `onSelect` is set it doubles as a filter:
 * the pressed tile is the active filter, and pressing it again clears it.
 */
export function StatTile({ label, value, hint, tone = "neutral", pressed, onSelect }: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  pressed?: boolean;
  onSelect?: () => void;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn("tabular mt-1.5 text-2xl font-semibold leading-none", value === 0 ? "text-muted-foreground" : toneText[tone])}>{value}</span>
      {hint ? <span className="mt-1.5 text-xs text-muted-foreground">{hint}</span> : null}
    </>
  );
  const frame = "flex min-w-0 flex-col rounded-xl border bg-card p-3.5 text-left shadow-xs";
  if (!onSelect) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onSelect}
      className={cn(
        frame,
        "outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        pressed && "border-foreground/25 bg-muted/60",
      )}
    >
      {body}
    </button>
  );
}

export function SearchField({ value, onChange, label, className }: { value: string; onChange: (value: string) => void; label: string; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-7 w-full pl-8 text-[0.8rem] sm:w-64"
      />
    </div>
  );
}

/** Label and value pair for detail sheets. */
export function DetailRow({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-all", mono && "font-mono")}>{children}</dd>
    </div>
  );
}

export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLowerCase().includes(needle));
}
