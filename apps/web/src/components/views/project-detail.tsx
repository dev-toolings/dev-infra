import { ExternalLink, Play, RotateCcw, Square, Stethoscope } from "lucide-react";
import type { Action, Operation, ProjectStatus, PublicProject, State } from "../../../../../src/contracts";
import { safeHttpUrl, formatDateTime } from "./shared";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export interface ProjectDetailProps {
  project?: PublicProject;
  status?: ProjectStatus;
  operations?: Operation[];
  busyComponentIds?: string[];
  loading?: boolean;
  error?: string;
  onAction: (action: Action, componentIds: string[]) => void | Promise<void>;
}

const stateLabels: Record<State, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};

const componentActions: { action: Action; label: string; icon: typeof Play }[] = [
  { action: "start", label: "Start", icon: Play },
  { action: "stop", label: "Stop", icon: Square },
  { action: "restart", label: "Restart", icon: RotateCcw },
  { action: "check", label: "Check", icon: Stethoscope },
];

function stateVariant(state?: State): "default" | "secondary" | "destructive" | "outline" {
  if (state === "unhealthy") return "destructive";
  if (state === "running") return "default";
  if (state === "stopped") return "secondary";
  return "outline";
}

function operationStateLabel(operation: Operation): string {
  switch (operation.state) {
    case "queued": return "Queued";
    case "running": return "In progress";
    case "succeeded": return "Completed";
    case "failed": return "Failed";
    case "unknown": return "Outcome unknown";
  }
}

export function ProjectDetail({ project, status, operations = [], busyComponentIds = [], loading = false, error, onAction }: ProjectDetailProps) {
  if (error) return <ErrorState description={error} />;
  if (loading) return <LoadingState label="Loading project details" rows={3} />;
  if (!project) {
    return <EmptyState title="Select a project" description="Project components and status appear here." />;
  }

  const validStatus = status?.projectId === project.id ? status : undefined;
  const statusByComponent = new Map(validStatus?.components.map((item) => [item.componentId, item]) ?? []);
  const recentOperations = operations
    .filter((operation) => operation.projectId === project.id)
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="project-detail-heading">
      <header className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="project-detail-heading" className="break-words text-xl font-semibold tracking-tight">{project.name}</h2>
          <code className="mt-1 block break-all text-xs leading-5 text-muted-foreground">{project.root}</code>
        </div>
        <Badge variant="outline" className="shrink-0">{project.components.length} {project.components.length === 1 ? "component" : "components"}</Badge>
      </header>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Components</h3>
        {project.components.length === 0 ? (
          <EmptyState title="No components configured" description="This project is registered, but no runnable components are configured." className="min-h-36" />
        ) : (
          <ul className="grid min-w-0 grid-cols-1 gap-3 2xl:grid-cols-2">
            {project.components.map((component) => {
              const componentStatus = statusByComponent.get(component.id);
              const state = componentStatus?.state;
              const readyLabel = componentStatus ? (componentStatus.ready ? "Ready" : "Not ready") : "Readiness not confirmed";
              const url = safeHttpUrl(component.url ?? componentStatus?.url);
              const busy = busyComponentIds.includes(component.id);
              return (
                <li key={component.id} className="min-w-0">
                  <Card className="h-full min-w-0">
                    <CardHeader className="flex-row flex-wrap items-start gap-x-3 gap-y-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <CardTitle className="break-words">{component.name}</CardTitle>
                        <CardDescription className="break-all">{component.cwd}</CardDescription>
                      </div>
                      <CardAction className="flex flex-wrap items-center justify-end gap-1.5">
                        <Badge variant="outline">{component.kind === "native" ? "Native" : "Compose"}</Badge>
                        {state ? <Badge variant={stateVariant(state)}>{stateLabels[state]}</Badge> : <Badge variant="outline">Status unavailable</Badge>}
                      </CardAction>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="text-muted-foreground">Readiness</span>
                        <span className="font-medium">{readyLabel}</span>
                        {componentStatus?.detail ? <span className="break-words text-muted-foreground">{componentStatus.detail}</span> : null}
                      </div>

                      {component.compose ? (
                        <dl className="grid min-w-0 grid-cols-1 gap-2 rounded-md bg-muted/60 p-3 text-xs sm:grid-cols-2">
                          <div className="min-w-0"><dt className="text-muted-foreground">Compose project</dt><dd className="break-all font-mono text-foreground">{component.compose.projectName}</dd></div>
                          <div className="min-w-0"><dt className="text-muted-foreground">Services</dt><dd className="break-words text-foreground">{component.compose.services.join(", ") || "None selected"}</dd></div>
                          <div className="min-w-0"><dt className="text-muted-foreground">Profiles</dt><dd className="break-words text-foreground">{component.compose.profiles.join(", ") || "Default"}</dd></div>
                          <div className="min-w-0"><dt className="text-muted-foreground">Compose files</dt><dd className="break-all text-foreground">{component.compose.files.join(", ")}</dd></div>
                        </dl>
                      ) : null}

                      {component.dependsOn.length > 0 ? (
                        <p className="break-words text-xs leading-5 text-muted-foreground">Depends on: {component.dependsOn.join(", ")}</p>
                      ) : null}

                      {url ? (
                        <a href={url} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          Open component URL <ExternalLink aria-hidden="true" className="size-4" />
                        </a>
                      ) : component.url || componentStatus?.url ? (
                        <p className="text-xs text-muted-foreground">The configured URL cannot be opened safely.</p>
                      ) : null}

                      <div className="flex flex-wrap gap-2 border-t border-border pt-3" aria-label={`Actions for ${component.name}`}>
                        {componentActions.map(({ action, label, icon: Icon }) => (
                          <Button
                            key={action}
                            type="button"
                            size="sm"
                            variant={action === "start" ? "default" : "outline"}
                            disabled={busy}
                            aria-label={`${label} ${component.name}`}
                            onClick={() => onAction(action, [component.id])}
                          >
                            <Icon aria-hidden="true" />
                            {label}
                          </Button>
                        ))}
                        {busy ? <span className="self-center text-xs text-muted-foreground">Operation in progress</span> : null}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <section className="space-y-3" aria-labelledby="operations-heading">
        <div className="flex items-center justify-between gap-3">
          <h3 id="operations-heading" className="text-sm font-semibold">Recent operations</h3>
          <span className="text-xs text-muted-foreground">Latest 5</span>
        </div>
        {recentOperations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">No operations have been recorded for this project.</p>
        ) : (
          <ul className="space-y-2">
            {recentOperations.map((operation) => (
              <li key={operation.id}>
                <Card>
                  <CardContent className="flex min-w-0 flex-col gap-2 pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium capitalize">{operation.action}</span>
                        <Badge variant={operation.state === "failed" ? "destructive" : operation.state === "succeeded" ? "secondary" : "outline"}>
                          {operationStateLabel(operation)}
                        </Badge>
                      </div>
                      <p className="break-words text-xs text-muted-foreground">
                        {operation.componentIds.length} {operation.componentIds.length === 1 ? "component" : "components"} · Updated {formatDateTime(operation.updatedAt)}
                      </p>
                    </div>
                    {operation.error ? (
                      <Alert variant="destructive" className="sm:max-w-md">
                        <AlertTitle>Operation detail</AlertTitle>
                        <AlertDescription className="break-words">{operation.error}</AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
