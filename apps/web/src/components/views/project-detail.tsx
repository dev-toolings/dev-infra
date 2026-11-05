import { t, translate } from "../../lib/i18n";
import { ArrowDown, Check, ChevronRight, ChevronsUpDown, Container, ExternalLink, Play, RotateCcw, Square, SquareTerminal, Stethoscope } from "lucide-react";
import type { Action, ComponentStatus, LogEntry, Operation, ProjectStatus, PublicComponent, PublicProject, State } from "../../../../../src/contracts";
import { plainClick, routePath } from "../../lib/router";
import { useStickToBottom } from "../../lib/use-stick-to-bottom";
import { cn } from "../../lib/utils";
import { ServiceIcon, containerService } from "../service-icon";
import { LogRow } from "./container-logs";
import { ProjectMark, StateBadge, formatDateTime, projectState, safeHttpUrl } from "./shared";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { EmptyState, ErrorState } from "../ui/state";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ProjectDetailSkeleton } from "./skeletons";

const LOG_TAIL = 300;
const OPERATION_ROWS = 10;

export interface ProjectDetailProps {
  project?: PublicProject;
  status?: ProjectStatus;
  /** The first status read is in flight: component badges show a placeholder, not "unavailable". */
  statusLoading?: boolean;
  operations?: Operation[];
  operationsLoading?: boolean;
  logEntries?: LogEntry[];
  logsLoading?: boolean;
  logsError?: string;
  busyComponentIds?: string[];
  loading?: boolean;
  error?: string;
  onAction: (action: Action, componentIds: string[]) => void | Promise<void>;
  onOpenLogs: () => void;
}

const actionLabels: Record<Action, string> = { start: t("Start"), stop: t("Stop"), restart: t("Restart"), check: t("Check") };

function operationStateLabel(operation: Operation): string {
  switch (operation.state) {
    case "queued": return t("Queued");
    case "running": return t("In progress");
    case "succeeded": return t("Completed");
    case "failed": return t("Failed");
    case "unknown": return t("Outcome unknown");
  }
}

const canStart = (state?: State) => state !== "running" && state !== "starting";
const canStop = (state?: State) => state !== "stopped";
const answers = (state?: State) => state === "running" || state === "unhealthy";

function IconAction({ label, icon: Icon, size, disabled, onClick }: { label: string; icon: typeof Play; size: "icon" | "icon-sm"; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline" size={size} disabled={disabled} aria-label={label} onClick={onClick}>
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface ProjectBreadcrumbProps {
  project: PublicProject;
  projects: PublicProject[];
  onList: () => void;
  onSelect: (projectId: string) => void;
}

export function ProjectBreadcrumb({ project, projects, onList, onSelect }: ProjectBreadcrumbProps) {
  return (
    <nav aria-label={t("Breadcrumb")} className="flex min-w-0 items-center gap-1 text-sm">
      <a href={routePath({ view: "projects" })} onClick={(event) => plainClick(event, onList)} className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {t("Projects")}
      </a>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      {projects.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label={t("Switch project, current: {name}", { name: project.name })} className="min-w-0 px-1.5 text-sm font-semibold">
              <span className="truncate">{project.name}</span>
              <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-52">
            {projects.map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => onSelect(item.id)}>
                <span className="truncate">{item.name}</span>
                {item.id === project.id ? <Check aria-hidden="true" className="ml-auto" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : <span aria-current="page" className="truncate font-semibold">{project.name}</span>}
    </nav>
  );
}

function ProjectActions({ project, states, statusLoading, url, busy, onAction }: { project: PublicProject; states: (State | undefined)[]; statusLoading: boolean; url?: string; busy: boolean; onAction: ProjectDetailProps["onAction"] }) {
  const ids = project.components.map((component) => component.id);
  const several = ids.length > 1;
  const startable = !statusLoading && states.some(canStart);
  const stoppable = !statusLoading && states.some(canStop);
  return (
    <div role="group" aria-label={t("Actions for {name}", { name: project.name })} className="flex shrink-0 flex-wrap items-center gap-2">
      {busy ? <span className="text-xs text-muted-foreground">{t("Operation in progress")}</span> : null}
      <IconAction label={t("Check")} icon={Stethoscope} size="icon" disabled={busy} onClick={() => onAction("check", ids)} />
      {stoppable ? (
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onAction("restart", ids)}>
            <RotateCcw aria-hidden="true" />
            {several ? t("Restart all") : t("Restart")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onAction("stop", ids)}>
            <Square aria-hidden="true" />
            {several ? t("Stop all") : t("Stop")}
          </Button>
        </>
      ) : null}
      {url ? (
        <Button asChild variant={startable ? "outline" : "default"}>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            {t("Open app")}
          </a>
        </Button>
      ) : null}
      {startable ? (
        <Button type="button" disabled={busy} onClick={() => onAction("start", ids)}>
          <Play aria-hidden="true" />
          {several ? t("Start all") : t("Start")}
        </Button>
      ) : null}
    </div>
  );
}

function ComponentRow({ component, status, statusLoading, busy, showActions, onAction }: { component: PublicComponent; status?: ComponentStatus; statusLoading: boolean; busy: boolean; showActions: boolean; onAction: ProjectDetailProps["onAction"] }) {
  const state = status?.state;
  const url = safeHttpUrl(component.url ?? status?.url);
  const address = url?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const Icon = component.kind === "native" ? SquareTerminal : Container;
  const act = (action: Action) => () => onAction(action, [component.id]);
  return (
    <li className="grid min-w-0 grid-cols-1 items-center gap-y-2 px-4 py-3 md:col-span-full md:grid-cols-subgrid">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon className="size-4" /></span>
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{component.name}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{component.kind === "native" ? t("Native") : t("Compose")}</span>
            {component.compose ? <code className="break-all">{component.compose.projectName}</code> : null}
            {component.compose?.managed?.infra.map((name) => (
              <span key={name} className="inline-flex items-center gap-1"><ServiceIcon name={containerService(name) ?? name} className="size-3" />{name.replace(/^infra-/, "")}</span>
            ))}
            {component.dependsOn.length > 0 ? <span className="break-words">{t("Depends on: {items}", { items: component.dependsOn.join(", ") })}</span> : null}
          </div>
        </div>
      </div>
      <div className="min-w-0 text-xs">
        {url && answers(state) ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 rounded-sm font-mono underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="truncate">{address}</span>
            <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : url ? <span className="block truncate font-mono text-muted-foreground">{address}</span> : null}
        {!url && (component.url || status?.url) ? <span className="text-muted-foreground">{t("The configured URL cannot be opened safely.")}</span> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 md:justify-end">
        {busy ? <span className="text-xs text-muted-foreground">{t("Operation in progress")}</span> : null}
        {state === "running" && !status?.ready ? <span className="text-xs text-muted-foreground">{t("Not ready")}</span> : null}
        <StateBadge state={state} loading={statusLoading} />
      </div>
      {showActions ? (
        <div role="group" aria-label={t("Actions for {name}", { name: component.name })} className="flex items-center gap-1 md:justify-end">
          {!statusLoading && canStart(state) ? <IconAction label={`${actionLabels.start} ${component.name}`} icon={Play} size="icon-sm" disabled={busy} onClick={act("start")} /> : null}
          {!statusLoading && canStop(state) ? <IconAction label={`${actionLabels.stop} ${component.name}`} icon={Square} size="icon-sm" disabled={busy} onClick={act("stop")} /> : null}
          {!statusLoading && canStop(state) ? <IconAction label={`${actionLabels.restart} ${component.name}`} icon={RotateCcw} size="icon-sm" disabled={busy} onClick={act("restart")} /> : null}
          <IconAction label={`${actionLabels.check} ${component.name}`} icon={Stethoscope} size="icon-sm" disabled={busy} onClick={act("check")} />
        </div>
      ) : null}
      {status?.detail ? <p className="break-words text-xs text-muted-foreground md:col-span-full md:pl-11">{translate(status.detail)}</p> : null}
    </li>
  );
}

function ProjectLogs({ project, entries, loading, error }: { project: PublicProject; entries: LogEntry[]; loading: boolean; error?: string }) {
  const { scroller, list, stuck, onScroll, toBottom } = useStickToBottom(entries.length > 0);
  const names = new Map(project.components.map((component) => [component.id, component.name]));
  const several = project.components.length > 1;
  if (error && entries.length === 0) return <ErrorState description={error} className="min-h-96" />;
  return (
    <div className="relative flex min-h-96 min-w-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 min-w-0 flex-1 basis-0 overflow-y-auto overflow-x-hidden rounded-xl border bg-log-panel py-2 [scrollbar-color:var(--log-muted)_transparent] [scrollbar-width:thin]"
      >
        {entries.length > 0 ? (
          <ol ref={list} role="log" aria-label={t("Recent project log entries")} aria-live="off" className="min-w-0">
            {entries.slice(-LOG_TAIL).map((entry) => <LogRow key={entry.seq} entry={entry} source={several ? names.get(entry.componentId) ?? entry.componentId : undefined} />)}
          </ol>
        ) : <p className="px-3 font-mono text-xs leading-5 text-log-muted">{loading ? t("Connecting to the log stream") : t("No output yet. It appears here as soon as the project writes some.")}</p>}
      </div>
      {!stuck ? (
        <Button type="button" variant="secondary" size="sm" className="absolute right-4 bottom-3 shadow-sm" onClick={toBottom}>
          {t("Jump to latest")} <ArrowDown aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function ProjectOperations({ project, operations, loading }: { project: PublicProject; operations: Operation[]; loading: boolean }) {
  const names = new Map(project.components.map((component) => [component.id, component.name]));
  const recent = operations
    .filter((operation) => operation.projectId === project.id)
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, OPERATION_ROWS);
  const several = project.components.length > 1;
  if (recent.length === 0 && loading) {
    return (
      <div role="status" aria-label={t("Loading operations")} className="space-y-3 rounded-xl border bg-card px-4 py-3 shadow-xs">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (recent.length === 0) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">{t("No operations have been recorded for this project.")}</p>;
  }
  return (
    <ul className="min-w-0 divide-y divide-border rounded-xl border border-border bg-card shadow-xs">
      {recent.map((operation) => (
        <li key={operation.id} className="min-w-0 space-y-1 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium">{actionLabels[operation.action]}</span>
            <Badge variant={operation.state === "failed" ? "down" : operation.state === "succeeded" ? "up" : operation.state === "unknown" ? "outline" : "info"}>
              {operationStateLabel(operation)}
            </Badge>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatDateTime(operation.updatedAt)}</span>
          </div>
          {several ? <p className="truncate text-xs text-muted-foreground">{operation.componentIds.map((id) => names.get(id) ?? id).join(", ")}</p> : null}
          {operation.error ? <p className="break-words text-xs text-status-down">{translate(operation.error)}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function ProjectDetail({ project, status, statusLoading = false, operations = [], operationsLoading = false, logEntries = [], logsLoading = false, logsError, busyComponentIds = [], loading = false, error, onAction, onOpenLogs }: ProjectDetailProps) {
  if (error) return <ErrorState description={error} />;
  if (loading) return <ProjectDetailSkeleton />;
  if (!project) {
    return <EmptyState title={t("Select a project")} description={t("Project components and status appear here.")} />;
  }

  const validStatus = status?.projectId === project.id ? status : undefined;
  const statusByComponent = new Map(validStatus?.components.map((item) => [item.componentId, item]) ?? []);
  const states = project.components.map((component) => statusByComponent.get(component.id)?.state);
  const liveUrl = project.components
    .filter((component) => answers(statusByComponent.get(component.id)?.state))
    .map((component) => safeHttpUrl(component.url ?? statusByComponent.get(component.id)?.url))
    .find(Boolean);
  const several = project.components.length > 1;

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-6" aria-labelledby="project-detail-heading">
      <header className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ProjectMark name={project.name} className="size-11 text-base" />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 id="project-detail-heading" className="break-words text-xl font-semibold tracking-tight">{project.name}</h1>
              {project.components.length > 0 ? <StateBadge state={projectState(project, validStatus)} loading={statusLoading} /> : null}
            </div>
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 text-xs leading-5 text-muted-foreground">
              <code className="break-all">{project.root}</code>
              <span>{t("Added {date}", { date: formatDateTime(project.createdAt) })}</span>
            </p>
          </div>
        </div>
        <ProjectActions project={project} states={states} statusLoading={statusLoading} url={liveUrl} busy={project.components.some((component) => busyComponentIds.includes(component.id))} onAction={onAction} />
      </header>

      <section className="space-y-2" aria-labelledby="components-heading">
        <h2 id="components-heading" className="text-sm font-semibold">{t("Components")}</h2>
        {project.components.length === 0 ? (
          <EmptyState title={t("No components configured")} description={t("This project is registered, but no runnable components are configured.")} className="min-h-36" />
        ) : (
          <ul className={cn("grid min-w-0 grid-cols-1 gap-x-6 divide-y divide-border rounded-xl border border-border bg-card shadow-xs", several ? "md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto_auto]" : "md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto]")}>
            {project.components.map((component) => (
              <ComponentRow
                key={component.id}
                component={component}
                status={statusByComponent.get(component.id)}
                statusLoading={statusLoading}
                busy={busyComponentIds.includes(component.id)}
                showActions={several}
                onAction={onAction}
              />
            ))}
          </ul>
        )}
      </section>

      <Tabs defaultValue="logs" className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <TabsList aria-label={t("Project activity")}>
            <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>
            <TabsTrigger value="operations">{t("Recent operations")}</TabsTrigger>
          </TabsList>
          <Button asChild variant="ghost" size="sm">
            <a href={routePath({ view: "logs", projectId: project.id })} onClick={(event) => plainClick(event, onOpenLogs)}>
              {t("View all logs")} <ChevronRight aria-hidden="true" />
            </a>
          </Button>
        </div>
        <TabsContent value="logs" className="flex min-w-0 flex-col">
          <ProjectLogs project={project} entries={logEntries} loading={logsLoading} error={logsError} />
        </TabsContent>
        <TabsContent value="operations" className="min-w-0">
          <ProjectOperations project={project} operations={operations} loading={operationsLoading} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
