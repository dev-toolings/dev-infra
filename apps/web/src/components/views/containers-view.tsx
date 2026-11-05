import { t } from "../../lib/i18n";
import { containerService, ServiceIcon } from "../service-icon";
import * as React from "react";
import { Box, ExternalLink } from "lucide-react";
import type { ContainerInfo } from "../../../../../src/contracts";
import { DEFAULT_CONTAINER_STATE, type ContainerState } from "../../lib/router";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { EmptyState, ErrorState } from "../ui/state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { ContainerLogs } from "./container-logs";
import { DetailRow, SearchField, StatTile, StatusDot, matches, type Tone } from "./inventory";
import { ContainersSkeleton } from "./skeletons";

export interface ContainersViewProps {
  containers: ContainerInfo[];
  loading?: boolean;
  error?: string;
  filter: ContainerState;
  onFilterChange: (filter: ContainerState) => void;
  onSelectProject?: (projectId: string) => void | Promise<void>;
  onSelectComponent?: (projectId: string, componentId: string) => void | Promise<void>;
}

const stateFilters: { value: ContainerState; label: string }[] = [
  { value: "all", label: t("All states") },
  { value: "running", label: t("Running") },
  { value: "unhealthy", label: t("Unhealthy") },
  { value: "stopped", label: t("Stopped") },
  { value: "linked", label: t("Linked to a project") },
];

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return t("Not reported");
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
  return value !== undefined && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)}%` : t("Not reported");
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
  if (state === "running") return container.health?.toLowerCase() === "starting" ? "info" : "up";
  if (state === "restarting") return "info";
  return "degraded";
}

const badgeFor: Record<Tone, "up" | "degraded" | "down" | "info" | "muted" | "outline"> = { up: "up", degraded: "degraded", down: "down", info: "info", muted: "muted", neutral: "outline" };

/** Published ports first (`127.0.0.1:5432->5432/tcp`), then internal ones. */
function sortedPorts(ports: string[]): string[] {
  return [...ports].sort((a, b) => Number(b.includes("->")) - Number(a.includes("->")));
}

function rank(container: ContainerInfo): number {
  if (isUnhealthy(container)) return 0;
  return isRunning(container) ? 1 : 2;
}

export function ContainersView({ containers, loading = false, error, filter, onFilterChange, onSelectProject, onSelectComponent }: ContainersViewProps) {
  const [query, setQuery] = React.useState("");
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
  const toggle = (next: ContainerState) => onFilterChange(filter === next ? "all" : next);

  if (error) return <ErrorState description={error} />;
  if (loading) return <ContainersSkeleton />;
  if (containers.length === 0) {
    return <EmptyState icon={<Box aria-hidden="true" className="size-5" />} title={t("No containers observed")} description={t("Docker returned no containers for this machine.")} />;
  }

  return (
    <section className="min-w-0 space-y-4" aria-label={t("Docker containers")}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t("Running")} value={counts.running} tone="up" hint={t("of {count} observed", { count: containers.length })} pressed={filter === "running"} onSelect={() => toggle("running")} />
        <StatTile label={t("Unhealthy")} value={counts.unhealthy} tone="down" hint={t("Running with a failing health check")} pressed={filter === "unhealthy"} onSelect={() => toggle("unhealthy")} />
        <StatTile label={t("Stopped")} value={counts.stopped} tone="degraded" hint={t("Exited, created or paused")} pressed={filter === "stopped"} onSelect={() => toggle("stopped")} />
        <StatTile label={t("Linked to a project")} value={counts.linked} hint={t("Others are inventory only")} pressed={filter === "linked"} onSelect={() => toggle("linked")} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={setQuery} label={t("Search name, image or compose project")} />
        <Select value={filter} onValueChange={(value) => onFilterChange(value as ContainerState)}>
          <SelectTrigger size="sm" className="w-44" aria-label={t("Filter by state")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stateFilters.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {filter !== DEFAULT_CONTAINER_STATE || query ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => { onFilterChange(DEFAULT_CONTAINER_STATE); setQuery(""); }}>{t("Reset")}</Button>
        ) : null}
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {visible.length === containers.length ? t("{count} containers", { count: containers.length }) : t("{shown} of {count} containers", { shown: visible.length, count: containers.length })}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState title={t("No container matches")} description={t("Change the search or the state filter to see more containers.")} className="min-h-36" />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>{t("Container")}</TableHead>
                <TableHead className="hidden w-40 md:table-cell">{t("Compose project")}</TableHead>
                <TableHead className="w-32">{t("State")}</TableHead>
                <TableHead className="hidden w-20 text-right sm:table-cell">CPU</TableHead>
                <TableHead className="hidden w-24 text-right sm:table-cell">{t("Memory")}</TableHead>
                <TableHead className="hidden w-60 lg:table-cell">{t("Ports")}</TableHead>
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
                        <ServiceIcon name={containerService(container.name) ?? ""} className="text-muted-foreground" />
                        <span className="truncate font-medium">{container.name}</span>
                        {container.projectId ? <Badge variant="outline" size="sm">{t("Linked")}</Badge> : null}
                      </button>
                      <span className="block truncate pl-3.5 text-xs text-muted-foreground">{container.image}</span>
                    </TableCell>
                    <TableCell className="hidden truncate text-xs md:table-cell">
                      {container.composeProject ? <span className="font-mono">{container.composeProject}</span> : <span className="text-muted-foreground">{t("None")}</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badgeFor[tone]}>{container.state || "unknown"}</Badge>
                      {currentHealth(container) ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{currentHealth(container)}</span> : null}
                    </TableCell>
                    <TableCell className={`tabular hidden text-right text-xs sm:table-cell ${running ? "" : "text-muted-foreground"}`}>{running ? formatCpu(container.cpuPercent) : t("Idle")}</TableCell>
                    <TableCell className={`tabular hidden text-right text-xs sm:table-cell ${running ? "" : "text-muted-foreground"}`}>{running ? formatBytes(container.memoryBytes) : t("Idle")}</TableCell>
                    <TableCell className="hidden text-xs lg:table-cell">
                      {ports.length === 0 ? <span className="text-muted-foreground">{t("None")}</span> : (
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
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-[80vw] lg:overflow-hidden">
          {open ? (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="flex items-center gap-2 break-all pr-6">
                  <StatusDot tone={toneOf(open)} className="size-2" />
                  {open.name}
                </SheetTitle>
                <SheetDescription className="break-all">{open.image}</SheetDescription>
              </SheetHeader>
              <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
              <div className="min-w-0 space-y-5 lg:w-96 lg:shrink-0 lg:overflow-y-auto">
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-lg border p-3"><dt className="text-muted-foreground">{t("State")}</dt><dd className="mt-1.5"><Badge variant={badgeFor[toneOf(open)]}>{open.state || "unknown"}</Badge></dd><dd className="mt-1 truncate text-muted-foreground">{currentHealth(open) ?? (isRunning(open) ? t("No health check") : t("Not running"))}</dd></div>
                  <div className="rounded-lg border p-3"><dt className="text-muted-foreground">CPU</dt><dd className="tabular mt-1.5 text-base font-semibold">{isRunning(open) ? formatCpu(open.cpuPercent) : t("Idle")}</dd></div>
                  <div className="rounded-lg border p-3"><dt className="text-muted-foreground">{t("Memory")}</dt><dd className="tabular mt-1.5 text-base font-semibold">{isRunning(open) ? formatBytes(open.memoryBytes) : t("Idle")}</dd></div>
                </dl>
                <section aria-labelledby="container-ports">
                  <h3 id="container-ports" className="text-sm font-semibold">{t("Ports")}</h3>
                  {open.ports.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">{t("No port is exposed.")}</p> : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {sortedPorts(open.ports).map((port) => <li key={port}><Badge variant={port.includes("->") ? "outline" : "muted"} className="font-mono">{port}</Badge></li>)}
                    </ul>
                  )}
                </section>
                <section aria-labelledby="container-identity">
                  <h3 id="container-identity" className="text-sm font-semibold">{t("Identity")}</h3>
                  <dl className="mt-1 divide-y">
                    <DetailRow label={t("Container ID")} mono>{open.id}</DetailRow>
                    <DetailRow label={t("Image ID")} mono>{open.imageId}</DetailRow>
                    <DetailRow label={t("Compose project")} mono>{open.composeProject ?? t("None")}</DetailRow>
                    <DetailRow label={t("Project")}>{open.projectId ? <span className="font-mono">{open.projectId}{open.componentId ? ` / ${open.componentId}` : ""}</span> : t("Not linked. DevHub only observes this container.")}</DetailRow>
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
              <ContainerLogs key={open.id} containerId={open.id} live={isRunning(open)} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
