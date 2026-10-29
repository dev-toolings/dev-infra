import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ViewTask = void | Promise<void>;

export interface ViewHeadingProps {
  title: string;
  titleId?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function ViewHeading({ title, titleId, description, action, className }: ViewHeadingProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        <h2 id={titleId} className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? <p className="max-w-3xl text-sm leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function formatDateTime(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function safeHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
