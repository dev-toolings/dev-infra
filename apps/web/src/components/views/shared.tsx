import { locale, t } from "../../lib/i18n";
import type { ReactNode } from "react";
import type { ProjectStatus, PublicProject, State } from "../../../../../src/contracts";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";

export type ViewTask = void | Promise<void>;

export type ProjectState = State | "partial";

const stateLabels: Record<ProjectState, string> = {
  stopped: t("Stopped"),
  starting: t("Starting"),
  running: t("Running"),
  unhealthy: t("Unhealthy"),
  unknown: t("Unknown"),
  partial: t("Partial"),
};

const stateVariants: Record<ProjectState, "outline" | "up" | "degraded" | "down" | "info"> = {
  stopped: "degraded",
  starting: "info",
  running: "up",
  unhealthy: "down",
  unknown: "outline",
  partial: "degraded",
};

/** Reads the status of each component as one state for the whole project. */
export function projectState(project: PublicProject, status?: ProjectStatus): ProjectState | undefined {
  if (!status || project.components.length === 0) return undefined;
  const byComponent = new Map(status.components.map((item) => [item.componentId, item.state]));
  const states = project.components.map((component) => byComponent.get(component.id) ?? "unknown");
  if (states.includes("unhealthy")) return "unhealthy";
  if (states.includes("starting")) return "starting";
  if (states.every((state) => state === "running")) return "running";
  if (states.every((state) => state === "stopped")) return "stopped";
  return states.includes("running") ? "partial" : "unknown";
}

export function StateBadge({ state, loading = false }: { state?: ProjectState; loading?: boolean }) {
  if (state) return <Badge variant={stateVariants[state]}>{stateLabels[state]}</Badge>;
  if (loading) return <Skeleton role="status" aria-label={t("Loading status")} className="h-5.5 w-16" />;
  return <Badge variant="outline">{t("Unavailable")}</Badge>;
}

/** Stands in for a logo: DevHub does not record the stack of a project. */
export function ProjectMark({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-semibold uppercase", className)}>
      {name.charAt(0)}
    </span>
  );
}

export interface ViewHeadingProps {
  title: string;
  titleId?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function ViewHeading({ title, titleId, description, action, className }: ViewHeadingProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0 space-y-0.5">
        <h2 id={titleId} className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function formatDateTime(value?: string): string {
  if (!value) return t("Unknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
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
