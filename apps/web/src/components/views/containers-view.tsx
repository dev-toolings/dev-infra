import * as React from "react";
import { Box, ExternalLink } from "lucide-react";
import type { ContainerInfo } from "../../../../../src/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { EmptyState, ErrorState } from "../ui/state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { DetailRow, SearchField, StatTile, StatusDot, matches, type Tone } from "./inventory";
import { ContainersSkeleton } from "./skeletons";

export interface ContainersViewProps {
  containers: ContainerInfo[];
  loading?: boolean;
  error?: string;
  onSelectProject?: (projectId: string) => void | Promise<void>;
  onSelectComponent?: (projectId: string, componentId: string) => void | Promise<void>;
}

type StateFilter = "all" | "running" | "unhealthy" | "stopped" | "linked";

const stateFilters: { value: StateFilter; label: string }[] = [
  { value: "all", label: "All states" },
  { value: "running", label: "Running" },
  { value: "unhealthy", label: "Unhealthy" },
  { value: "stopped", label: "Stopped" },
  { value: "linked", label: "Linked to a project" },
];

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

function formatCpu(value?: number): string {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)}%` : "Not reported";
}

/** Docker keeps the last health result after a stop, so health only counts while the container runs. */
function isUnhealthy(container: ContainerInfo): boolean {
  const state = container.state.toLowerCase();
  if (state === "dead" || state.includes("error")) return true;
  return state === "running" && (container.health?.toLowerCase() ?? "").includes("unhealthy");
}

function currentHealth(container: ContainerInfo): string | undefined {
  return isRunning(container) ? container.health : undefined;
}

function isRunning(container: ContainerInfo): boolean {
  return container.state.toLowerCase() === "running";
}

function toneOf(container: ContainerInfo): Tone {
  if (isUnhealthy(container)) return "down";
  const state = container.state.toLowerCase();
  if (state === "running") return container.health?.toLowerCase() === "starting" ? "degraded" : "up";
  if (state === "restarting" || state === "paused") return "degraded";
  return "muted";
}

const badgeFor: Record<Tone, "up" | "degraded" | "down" | "muted" | "outline"> = { up: "up", degraded: "degraded", down: "down", muted: "muted", neutral: "outline" };

/** Published ports first (`127.0.0.1:5432->5432/tcp`), then internal ones. */
function sortedPorts(ports: string[]): string[] {
  return [...ports].sort((a, b) => Number(b.includes("->")) - Number(a.includes("->")));
}

function rank(container: ContainerInfo): number {
  if (isUnhealthy(container)) return 0;
  return isRunning(container) ? 1 : 2;
}

export function ContainersView({ containers, loading = false, error, onSelectProject, onSelectComponent }: ContainersViewProps) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<StateFilter>("all");
  const [openId, setOpenId] = React.useState<string>();

  const counts = React.useMemo(() => ({
    running: containers.filter(isRunning).length,
    unhealthy: containers.filter(isUnhealthy).length,
    stopped: containers.filter((container) => !isRunning(container)).length,
    linked: containers.filter((container) => container.projectId).length,
  }), [containers]);

  const visible = React.useMemo(() => containers
    .filter((container) => {
      if (filter === "running" && !isRunning(container)) return false;
      if (filter === "unhealthy" && !isUnhealthy(container)) return false;
      if (filter === "stopped" && isRunning(container)) return false;
      if (filter === "linked" && !container.projectId) return false;
      return matches(query, container.name, container.image, container.composeProject, container.projectId);
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)), [containers, filter, query]);

  const open = containers.find((container) => container.id === openId);
  const toggle = (next: StateFilter) => setFilter((current) => (current === next ? "all" : next));

  if (error) return <ErrorState description={error} />;
  if (loading) return <ContainersSkeleton />;
  if (containers.length === 0) {
    return <EmptyState icon={<Box aria-hidden="true" className="size-5" />} title="No containers observed" description="Docker returned no containers for this machine." />;
  }

  return (
    <section className="min-w-0 space-y-4" aria-label="Docker containers">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Running" value={counts.running} tone="up" hint={`of ${containers.length} observed`} pressed={filter === "running"} onSelect={() => toggle("running")} />
        <StatTile label="Unhealthy" value={counts.unhealthy} tone="down" hint="Running with a failing health check" pressed={filter === "unhealthy"} onSelect={() => toggle("unhealthy")} />
        <StatTile label="Stopped" value={counts.stopped} tone="muted" hint="Exited, created or paused" pressed={filter === "stopped"} onSelect={() => toggle("stopped")} />
        <StatTile label="Linked to a project" value={counts.linked} hint="Others are inventory only" pressed={filter === "linked"} onSelect={() => toggle("linked")} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={setQuery} label="Search name, image or compose project" />
        <Select value={filter} onValueChange={(value) => setFilter(value as StateFilter)}>
          <SelectTrigger size="sm" className="w-44" aria-label="Filter by state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stateFilters.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {filter !== "all" || query ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => { setFilter("all"); setQuery(""); }}>Reset</Button>
        ) : null}
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {visible.length === containers.length ? `${containers.length} containers` : `${visible.length} of ${containers.length} containers`}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No container matches" description="Change the search or the state filter to see more containers." className="min-h-36" />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Container</TableHead>
                <TableHead className="hidden w-40 md:table-cell">Compose project</TableHead>
                <TableHead className="w-32">State</TableHead>
                <TableHead className="hidden w-20 text-right sm:table-cell">CPU</TableHead>
                <TableHead className="hidden w-24 text-right sm:table-cell">Memory</TableHead>
                <TableHead className="hidden w-60 lg:table-cell">Ports</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((container) => {
                const ports = sortedPorts(container.ports);
                const tone = toneOf(container);
                const running = isRunning(container);
                return (
                  <TableRow key={container.id} className="cursor-pointer" onClick={() => setOpenId(container.id)}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); setOpenId(container.id); }}
                        className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <StatusDot tone={tone} />
                        <span className="truncate font-medium">{container.name}</span>
                        {container.projectId ? <Badge variant="outline" size="sm">Linked</Badge> : null}
                      </button>
                      <span className="block truncate pl-3.5 text-xs text-muted-foreground">{container.image}</span>
                    </TableCell>
                    <TableCell className="hidden truncate text-xs md:table-cell">
                      {container.composeProject ? <span className="font-mono">{container.composeProject}</span> : <span className="text-muted-foreground">None</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badgeFor[tone]}>{container.state || "unknown"}</Badge>
                      {currentHealth(container) ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{currentHealth(container)}</span> : null}
                    </TableCell>
                    <TableCell className={`tabular hidden text-right text-xs sm:table-cell ${running ? "" : "text-muted-foreground"}`}>{running ? formatCpu(container.cpuPercent) : "Idle"}</TableCell>
                    <TableCell className={`tabular hidden text-right text-xs sm:table-cell ${running ? "" : "text-muted-foreground"}`}>{running ? formatBytes(container.memoryBytes) : "Idle"}</TableCell>
                    <TableCell className="hidden text-xs lg:table-cell">
                      {ports.length === 0 ? <span className="text-muted-foreground">None</span> : (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono">{ports[0]}</span>
                          {ports.length > 1 ? <Badge variant="muted" size="sm" className="shrink-0">+{ports.length - 1}</Badge> : null}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(next) => { if (!next) setOpenId(undefined); }}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
          {open ? (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="flex items-center gap-2 break-all pr-6">
                  <StatusDot tone={toneOf(open)} className="size-2" />
                  {open.name}
                </SheetTitle>
                <SheetDescription className="break-all">{open.image}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 p-4">
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-lg border p-3"><dt className="text-muted-foreground">State</dt><dd className="mt-1.5"><Badge variant={badgeFor[toneOf(open)]}>{open.state || "unknown"}</Badge></dd><dd className="mt-1 truncate text-muted-foreground">{currentHealth(open) ?? (isRunning(open) ? "No health check" : "Not running")}</dd></div>
                  <div className="rounded-lg border p-3"><dt className="text-muted-foreground">CPU</dt><dd className="tabular mt-1.5 text-base font-semibold">{isRunning(open) ? formatCpu(open.cpuPercent) : "Idle"}</dd></div>
                  <div className="rounded-lg border p-3"><dt className="text-muted-foreground">Memory</dt><dd className="tabular mt-1.5 text-base font-semibold">{isRunning(open) ? formatBytes(open.memoryBytes) : "Idle"}</dd></div>
                </dl>
                <section aria-labelledby="container-ports">
                  <h3 id="container-ports" className="text-sm font-semibold">Ports</h3>
                  {open.ports.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">No port is exposed.</p> : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {sortedPorts(open.ports).map((port) => <li key={port}><Badge variant={port.includes("->") ? "outline" : "muted"} className="font-mono">{port}</Badge></li>)}
                    </ul>
                  )}
                </section>
                <section aria-labelledby="container-identity">
                  <h3 id="container-identity" className="text-sm font-semibold">Identity</h3>
                  <dl className="mt-1 divide-y">
                    <DetailRow label="Container ID" mono>{open.id}</DetailRow>
                    <DetailRow label="Image ID" mono>{open.imageId}</DetailRow>
                    <DetailRow label="Compose project" mono>{open.composeProject ?? "None"}</DetailRow>
                    <DetailRow label="Project">{open.projectId ? <span className="font-mono">{open.projectId}{open.componentId ? ` / ${open.componentId}` : ""}</span> : "Not linked. DevHub only observes this container."}</DetailRow>
                  </dl>
                </section>
                {open.projectId && onSelectComponent && open.componentId ? (
                  <Button type="button" variant="outline" onClick={() => onSelectComponent(open.projectId!, open.componentId!)}>
                    Open linked component <ExternalLink aria-hidden="true" />
                  </Button>
                ) : open.projectId && onSelectProject ? (
                  <Button type="button" variant="outline" onClick={() => onSelectProject(open.projectId!)}>
                    Open linked project <ExternalLink aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
