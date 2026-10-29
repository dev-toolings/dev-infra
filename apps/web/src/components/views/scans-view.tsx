import * as React from "react";
import { LoaderCircle, ScanLine, ShieldCheck } from "lucide-react";
import type { ContainerInfo, Finding, Scan, PublicChange } from "../../../../../src/contracts";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { EmptyState, ErrorState } from "../ui/state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { DetailRow, SearchField, StatTile, matches } from "./inventory";
import { ScansSkeleton } from "./skeletons";
import { formatDateTime, type ViewTask } from "./shared";

export interface ScansViewProps {
  scans: Scan[];
  changes: PublicChange[];
  containers: ContainerInfo[];
  /** The container inventory, which lists the images that can be scanned, is still loading. */
  inventoryLoading?: boolean;
  loading?: boolean;
  busy?: boolean;
  scanningImageId?: string;
  error?: string;
  onScan?: (imageId: string) => ViewTask;
}

type ImageFilter = "all" | "unscanned" | "findings" | "failed";

/** One local image: its references, the containers using it, and its latest scan. */
interface ImageRow {
  imageId: string;
  references: string[];
  containers: ContainerInfo[];
  latest?: Scan;
  severe: number;
  medium: number;
  other: number;
}

const SEVERE = new Set(["critical", "high"]);
const MEDIUM = new Set(["medium", "moderate"]);

function severityVariant(severity: string): "down" | "degraded" | "outline" {
  const normalized = severity.toLowerCase();
  if (SEVERE.has(normalized)) return "down";
  if (MEDIUM.has(normalized)) return "degraded";
  return "outline";
}

function severityRank(finding: Finding): number {
  const normalized = finding.severity.toLowerCase();
  return SEVERE.has(normalized) ? (normalized === "critical" ? 0 : 1) : MEDIUM.has(normalized) ? 2 : 3;
}

function changeVariant(state: PublicChange["state"]): "default" | "secondary" | "destructive" | "outline" | "muted" | "up" | "degraded" | "down" {
  if (state === "failed") return "down";
  if (state === "validated" || state === "activated") return "up";
  if (state === "applied") return "default";
  return "outline";
}

/** `adminer:6.1.2@sha256:...` reads as `adminer:6.1.2`; the digest is shown separately. */
function displayReference(reference: string): { name: string; pinned: boolean } {
  const at = reference.indexOf("@sha256:");
  return at > 0 ? { name: reference.slice(0, at), pinned: true } : { name: reference, pinned: false };
}

/** Short, recognizable form of a content digest: `sha256:b97af4787f35`. */
function shortId(imageId: string): string {
  const [algorithm, digest] = imageId.includes(":") ? imageId.split(":", 2) as [string, string] : ["", imageId];
  return algorithm ? `${algorithm}:${digest.slice(0, 12)}` : digest.slice(0, 12);
}

function buildRows(containers: ContainerInfo[], scans: Scan[]): ImageRow[] {
  const rows = new Map<string, ImageRow>();
  const row = (imageId: string) => {
    let current = rows.get(imageId);
    if (!current) {
      current = { imageId, references: [], containers: [], severe: 0, medium: 0, other: 0 };
      rows.set(imageId, current);
    }
    return current;
  };
  for (const container of containers) {
    const current = row(container.imageId);
    current.containers.push(container);
    if (container.image && !current.references.includes(container.image)) current.references.push(container.image);
  }
  for (const scan of scans) {
    const current = row(scan.imageId);
    if (!current.latest || Date.parse(scan.scannedAt) > Date.parse(current.latest.scannedAt)) current.latest = scan;
  }
  for (const current of rows.values()) {
    for (const finding of current.latest?.findings ?? []) {
      const severity = finding.severity.toLowerCase();
      if (SEVERE.has(severity)) current.severe += 1;
      else if (MEDIUM.has(severity)) current.medium += 1;
      else current.other += 1;
    }
  }
  // Images with severe findings first, then scanned ones, then by name.
  return [...rows.values()].sort((a, b) =>
    b.severe - a.severe
    || Number(Boolean(b.latest)) - Number(Boolean(a.latest))
    || (a.references[0] ?? a.imageId).localeCompare(b.references[0] ?? b.imageId));
}

function FindingCounts({ row }: { row: ImageRow }) {
  if (!row.latest) return <span className="text-muted-foreground">Not scanned</span>;
  if (row.latest.state === "failed") return <span className="text-muted-foreground">No result</span>;
  if (row.severe + row.medium + row.other === 0) return <span className="text-status-up">None found</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.severe > 0 ? <Badge variant="down" size="sm">{row.severe} high</Badge> : null}
      {row.medium > 0 ? <Badge variant="degraded" size="sm">{row.medium} medium</Badge> : null}
      {row.other > 0 ? <Badge variant="muted" size="sm">{row.other} low</Badge> : null}
    </span>
  );
}

export function ScansView({ scans, changes, containers, inventoryLoading = false, loading = false, busy = false, scanningImageId, error, onScan }: ScansViewProps) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<ImageFilter>("all");
  const [openId, setOpenId] = React.useState<string>();
  const rows = React.useMemo(() => buildRows(containers, scans), [containers, scans]);

  const counts = {
    scanned: rows.filter((row) => row.latest).length,
    severe: rows.filter((row) => row.severe > 0).length,
    unscanned: rows.filter((row) => !row.latest).length,
    failed: rows.filter((row) => row.latest?.state === "failed").length,
  };
  const visible = rows.filter((row) => {
    if (filter === "unscanned" && row.latest) return false;
    if (filter === "findings" && row.severe + row.medium + row.other === 0) return false;
    if (filter === "failed" && row.latest?.state !== "failed") return false;
    return matches(query, row.imageId, ...row.references, ...row.containers.map((container) => container.name));
  });
  const open = rows.find((row) => row.imageId === openId);
  const toggle = (next: ImageFilter) => setFilter((current) => (current === next ? "all" : next));
  const filters: { value: ImageFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "unscanned", label: "Not scanned" },
    { value: "findings", label: "With findings" },
    { value: "failed", label: "Failed scans" },
  ];

  function scanButton(row: ImageRow, className?: string) {
    if (!onScan) return null;
    const scanning = busy && scanningImageId === row.imageId;
    // Only images still present in the container inventory can be scanned: nothing is pulled.
    const scannable = row.containers.length > 0;
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-busy={scanning}
        disabled={busy || !scannable}
        title={scannable ? undefined : "This image is no longer used by an observed container"}
        className={className}
        onClick={(event) => { event.stopPropagation(); void onScan(row.imageId); }}
      >
        {scanning ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <ScanLine aria-hidden="true" />}
        {scanning ? "Scanning" : row.latest ? "Rescan" : "Scan"}
      </Button>
    );
  }

  if (error) return <ErrorState description={error} />;
  if (loading || inventoryLoading) return <ScansSkeleton />;

  return (
    <section className="min-w-0 space-y-6" aria-label="Image maintenance">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Local images" value={rows.length} hint={`Used by ${containers.length} containers`} pressed={filter === "all" && !query} onSelect={() => setFilter("all")} />
          <StatTile label="Never scanned" value={counts.unscanned} tone="muted" hint="Scan to check for vulnerabilities" pressed={filter === "unscanned"} onSelect={() => toggle("unscanned")} />
          <StatTile label="High or critical" value={counts.severe} tone="down" hint="Images in their latest scan" pressed={filter === "findings"} onSelect={() => toggle("findings")} />
          <StatTile label="Failed scans" value={counts.failed} tone="degraded" hint="Latest scan did not complete" pressed={filter === "failed"} onSelect={() => toggle("failed")} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={query} onChange={setQuery} label="Search image or container" />
          <div role="group" aria-label="Filter images" className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {filters.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  "h-6 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  filter === item.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="tabular ml-auto text-xs text-muted-foreground">
            {visible.length === rows.length ? `${rows.length} images` : `${visible.length} of ${rows.length} images`}
          </span>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck aria-hidden="true" className="size-5" />} title="No local images" description="Images appear here once Docker reports containers that use them. Nothing is pulled." />
        ) : visible.length === 0 ? (
          <EmptyState title="No image matches" description="Change the search or the filter to see more images." className="min-h-36" />
        ) : (
          <Card className="overflow-hidden p-0">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Image</TableHead>
                  <TableHead className="hidden w-56 md:table-cell">Used by</TableHead>
                  <TableHead className="hidden w-40 sm:table-cell">Last scan</TableHead>
                  <TableHead className="w-44">Findings</TableHead>
                  {onScan ? <TableHead className="w-28"><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow key={row.imageId} className="cursor-pointer" onClick={() => setOpenId(row.imageId)}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); setOpenId(row.imageId); }}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <span className="truncate">{row.references[0] ? displayReference(row.references[0]).name : shortId(row.imageId)}</span>
                        {row.references[0] && displayReference(row.references[0]).pinned ? <Badge variant="outline" size="sm" title="Referenced by digest">pinned</Badge> : null}
                      </button>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{shortId(row.imageId)}{row.references.length > 1 ? `, +${row.references.length - 1} tags` : ""}</span>
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">
                      {row.containers.length === 0 ? <span className="text-muted-foreground">No running container</span> : (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{row.containers[0]!.name}</span>
                          {row.containers.length > 1 ? <Badge variant="muted" size="sm" className="shrink-0">+{row.containers.length - 1}</Badge> : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-xs sm:table-cell">
                      {row.latest ? (
                        <>
                          <span className="block">{formatDateTime(row.latest.scannedAt)}</span>
                          {row.latest.state === "failed" ? <span className="text-status-down">Failed</span> : <span className="text-muted-foreground">{row.latest.scanner}</span>}
                        </>
                      ) : <span className="text-muted-foreground">Never</span>}
                    </TableCell>
                    <TableCell className="text-xs"><FindingCounts row={row} /></TableCell>
                    {onScan ? <TableCell className="text-right">{scanButton(row)}</TableCell> : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      <Sheet open={Boolean(open)} onOpenChange={(next) => { if (!next) setOpenId(undefined); }}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          {open ? (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="break-all pr-6">{open.references[0] ? displayReference(open.references[0]).name : shortId(open.imageId)}</SheetTitle>
                <SheetDescription className="break-all font-mono">{open.imageId}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {scanButton(open)}
                  {open.containers.length === 0 ? <span className="text-xs text-muted-foreground">Not used by an observed container, so it cannot be scanned.</span> : null}
                </div>
                <section aria-labelledby="image-usage">
                  <h3 id="image-usage" className="text-sm font-semibold">Used by</h3>
                  {open.containers.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">No observed container uses this image.</p> : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {open.containers.map((container) => (
                        <li key={container.id}><Badge variant={container.projectId ? "outline" : "muted"}>{container.name}{container.projectId ? ` (${container.projectId})` : ""}</Badge></li>
                      ))}
                    </ul>
                  )}
                  {open.references.length > 1 ? <p className="mt-2 break-all text-xs text-muted-foreground">Tags: {open.references.join(", ")}</p> : null}
                </section>
                {open.latest ? (
                  <section aria-labelledby="image-scan" className="space-y-3">
                    <h3 id="image-scan" className="text-sm font-semibold">Latest scan</h3>
                    <dl className="divide-y">
                      <DetailRow label="Result">{open.latest.state === "failed" ? <Badge variant="down">Failed</Badge> : <Badge variant="muted">Completed</Badge>}</DetailRow>
                      <DetailRow label="Scanned">{formatDateTime(open.latest.scannedAt)}</DetailRow>
                      <DetailRow label="Scanner">{open.latest.scanner}</DetailRow>
                      <DetailRow label="Database">{open.latest.databaseUpdatedAt ? `Updated ${formatDateTime(open.latest.databaseUpdatedAt)}` : "Freshness unknown"}</DetailRow>
                    </dl>
                    {open.latest.state === "failed" ? (
                      <p role="status" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                        {open.latest.error ?? "The scan did not complete. Check that the local scanner is installed, then rescan."}
                      </p>
                    ) : open.latest.findings.length === 0 ? (
                      <p className="rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">The scanner reported no vulnerability for this image.</p>
                    ) : (
                      <ul className="divide-y rounded-lg border">
                        {[...open.latest.findings].sort((a, b) => severityRank(a) - severityRank(b)).map((finding) => (
                          <li key={JSON.stringify([finding.target, finding.id, finding.package, finding.installedVersion])} className="space-y-1 p-3">
                            <div className="flex min-w-0 items-start justify-between gap-2">
                              <p className="min-w-0 break-words text-sm font-medium">{finding.title}</p>
                              <Badge variant={severityVariant(finding.severity)} className="shrink-0">{finding.severity.toLowerCase()}</Badge>
                            </div>
                            <p className="break-all font-mono text-xs text-muted-foreground">{finding.id} in {finding.package} {finding.installedVersion}</p>
                            <p className="text-xs text-muted-foreground">{finding.fixedVersion ? `Fixed in ${finding.fixedVersion}` : "No fix released yet"}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ) : (
                  <p className="text-xs text-muted-foreground">This image has never been scanned.</p>
                )}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {!error && !loading && changes.length > 0 ? (
        <section className="space-y-3" aria-labelledby="source-changes-heading">
          <div>
            <h3 id="source-changes-heading" className="text-sm font-semibold">Existing source changes</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Source change records and their current review state.</p>
          </div>
          <ul className="space-y-2">
            {changes.map((change) => (
              <li key={change.id}>
                <Card>
                  <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <CardTitle className="break-all text-sm">{change.file}</CardTitle>
                      <CardDescription className="break-all">Project {change.projectId} · Component {change.componentId}</CardDescription>
                    </div>
                    <Badge variant={changeVariant(change.state)}>{change.state}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">Created {formatDateTime(change.createdAt)} · Line {change.changedLine.line}</p>
                    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="min-w-0 rounded-md border border-border bg-muted/50 p-3">
                        <p className="mb-1 text-xs font-medium text-muted-foreground">Before</p>
                        <code className="block break-all text-xs leading-5">{change.changedLine.before}</code>
                      </div>
                      <div className="min-w-0 rounded-md border border-border bg-muted/50 p-3">
                        <p className="mb-1 text-xs font-medium text-muted-foreground">After</p>
                        <code className="block break-all text-xs leading-5">{change.changedLine.after}</code>
                      </div>
                    </div>
                    {change.branch ? <p className="break-all text-xs text-muted-foreground">Branch: <code>{change.branch}</code></p> : null}
                    {change.error ? <p role="status" className="break-words text-xs text-destructive">{change.error}</p> : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
