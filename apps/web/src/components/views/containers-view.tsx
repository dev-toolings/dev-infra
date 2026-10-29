import { Box, ExternalLink } from "lucide-react";
import type { ContainerInfo } from "../../../../../src/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ViewHeading } from "./shared";

export interface ContainersViewProps {
  containers: ContainerInfo[];
  loading?: boolean;
  error?: string;
  onSelectProject?: (projectId: string) => void | Promise<void>;
  onSelectComponent?: (projectId: string, componentId: string) => void | Promise<void>;
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Not reported";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; amount >= 1024 && index < units.length; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount.toFixed(1)} ${unit}`;
}

function stateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = state.toLowerCase();
  if (normalized === "running") return "default";
  if (normalized === "exited" || normalized === "stopped") return "secondary";
  if (normalized.includes("unhealthy") || normalized.includes("error")) return "destructive";
  return "outline";
}

export function ContainersView({ containers, loading = false, error, onSelectProject, onSelectComponent }: ContainersViewProps) {
  return (
    <section className="space-y-4" aria-labelledby="containers-heading">
      <ViewHeading
        title="Docker containers"
        titleId="containers-heading"
        description="Observed containers are listed as inventory. Only explicitly mapped entries link back to a registered project."
      />
      {error ? <ErrorState description={error} /> : loading ? <LoadingState label="Loading container inventory" rows={4} /> : null}
      {!error && !loading && containers.length === 0 ? (
        <EmptyState title="No containers observed" description="The current Docker inventory returned no containers." icon={<Box aria-hidden="true" className="size-5" />} />
      ) : null}

      {!error && !loading && containers.length > 0 ? (
        <ul className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
          {containers.map((container) => {
            const mapped = Boolean(container.projectId);
            const memory = formatBytes(container.memoryBytes);
            const cpu = container.cpuPercent !== undefined && Number.isFinite(container.cpuPercent) && container.cpuPercent >= 0
              ? `${container.cpuPercent.toFixed(1)}%`
              : "Not reported";
            return (
              <li key={container.id} className="min-w-0">
                <Card className="h-full min-w-0">
                  <CardHeader className="flex-row items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Box aria-hidden="true" className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <CardTitle className="break-all">{container.name}</CardTitle>
                      <CardDescription className="break-all">{container.image}</CardDescription>
                    </div>
                    <Badge variant={mapped ? "secondary" : "outline"} className="shrink-0">
                      {mapped ? "Mapped" : "Observed only"}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
                      <div className="min-w-0"><dt className="text-muted-foreground">State</dt><dd className="mt-1"><Badge variant={stateVariant(container.state)}>{container.state || "Unknown"}</Badge></dd></div>
                      <div className="min-w-0"><dt className="text-muted-foreground">Health</dt><dd className="mt-1 break-words font-medium">{container.health ?? "Not reported"}</dd></div>
                      <div className="min-w-0"><dt className="text-muted-foreground">CPU</dt><dd className="mt-1 font-medium">{cpu}</dd></div>
                      <div className="min-w-0"><dt className="text-muted-foreground">Memory</dt><dd className="mt-1 font-medium">{memory}</dd></div>
                      <div className="col-span-2 min-w-0 sm:col-span-1"><dt className="text-muted-foreground">Ports</dt><dd className="mt-1 break-words font-mono">{container.ports.length > 0 ? container.ports.join(", ") : "None reported"}</dd></div>
                    </dl>

                    <div className="min-w-0 space-y-1 rounded-md bg-muted/60 p-3 text-xs">
                      <p className="break-all"><span className="text-muted-foreground">Container ID:</span> <code>{container.id}</code></p>
                      <p className="break-all"><span className="text-muted-foreground">Image ID:</span> <code>{container.imageId}</code></p>
                      {container.composeProject ? <p className="break-all"><span className="text-muted-foreground">Compose project:</span> <code>{container.composeProject}</code></p> : null}
                      {container.projectId ? <p className="break-all"><span className="text-muted-foreground">Project ID:</span> <code>{container.projectId}</code></p> : null}
                      {container.componentId ? <p className="break-all"><span className="text-muted-foreground">Component ID:</span> <code>{container.componentId}</code></p> : null}
                    </div>

                    {container.projectId && onSelectComponent && container.componentId ? (
                      <Button type="button" variant="outline" onClick={() => onSelectComponent(container.projectId!, container.componentId!)}>
                        Open mapped component <ExternalLink aria-hidden="true" />
                      </Button>
                    ) : container.projectId && onSelectProject ? (
                      <Button type="button" variant="outline" onClick={() => onSelectProject(container.projectId!)}>
                        Open mapped project <ExternalLink aria-hidden="true" />
                      </Button>
                    ) : !mapped ? (
                      <p className="text-xs leading-5 text-muted-foreground">This container is inventory only. No project action is available.</p>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
