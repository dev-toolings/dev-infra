import type { ContainerInfo, Scan, PublicChange } from "../../../../../src/contracts";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ViewHeading, formatDateTime } from "./shared";

export interface ScansViewProps {
  scans: Scan[];
  changes: PublicChange[];
  containers: ContainerInfo[];
  loading?: boolean;
  error?: string;
}

function severityVariant(severity: string): "destructive" | "secondary" | "outline" {
  const normalized = severity.toLowerCase();
  if (normalized === "critical" || normalized === "high") return "destructive";
  if (normalized === "medium" || normalized === "moderate") return "secondary";
  return "outline";
}

function changeVariant(state: PublicChange["state"]): "default" | "secondary" | "destructive" | "outline" {
  if (state === "failed") return "destructive";
  if (state === "validated" || state === "activated") return "secondary";
  if (state === "applied") return "default";
  return "outline";
}

export function ScansView({ scans, changes, containers, loading = false, error }: ScansViewProps) {
  return (
    <section className="min-w-0 space-y-6" aria-labelledby="maintenance-heading">
      <ViewHeading
        title="Image maintenance"
        titleId="maintenance-heading"
        description="Review scan results, database freshness, and existing source-change records. This view does not apply or activate changes."
        className="[&_h2]:text-lg"
      />
      {error ? <ErrorState description={error} /> : loading ? <LoadingState label="Loading scan and change records" rows={4} /> : null}
      {!error && !loading && scans.length === 0 && changes.length === 0 ? (
        <EmptyState
          title="No maintenance records"
          description="No image scans or source-change records are available yet."
        />
      ) : null}

      {!error && !loading && scans.length > 0 ? (
        <section className="space-y-3" aria-labelledby="scan-results-heading">
          <h3 id="scan-results-heading" className="text-sm font-semibold">Image scans</h3>
          <ul className="space-y-3">
            {scans.map((scan) => {
              const matchingContainers = containers.filter((container) => container.imageId === scan.imageId);
              const mappedContainers = matchingContainers.filter((container) => container.projectId);
              return (
                <li key={scan.id}>
                  <Card className="min-w-0">
                    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <CardTitle className="text-sm">Image scan</CardTitle>
                        <CardDescription className="break-all font-mono">{scan.imageId}</CardDescription>
                      </div>
                      <Badge variant={scan.state === "failed" ? "destructive" : "secondary"}>
                        {scan.state === "failed" ? "Failed" : "Completed"}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <dl className="grid grid-cols-1 gap-3 rounded-md bg-muted/60 p-3 text-xs sm:grid-cols-3">
                        <div className="min-w-0"><dt className="text-muted-foreground">Scanner</dt><dd className="mt-1 break-words font-medium">{scan.scanner}</dd></div>
                        <div className="min-w-0"><dt className="text-muted-foreground">Scanned</dt><dd className="mt-1 font-medium">{formatDateTime(scan.scannedAt)}</dd></div>
                        <div className="min-w-0"><dt className="text-muted-foreground">Vulnerability database</dt><dd className="mt-1 font-medium">{scan.databaseUpdatedAt ? `Updated ${formatDateTime(scan.databaseUpdatedAt)}` : "Freshness unknown"}</dd></div>
                      </dl>

                      <div className="space-y-1 text-xs leading-5">
                        {matchingContainers.length === 0 ? (
                          <p className="text-muted-foreground">No currently observed container matches this image ID. Source mapping is unknown.</p>
                        ) : mappedContainers.length === 0 ? (
                          <p className="text-muted-foreground">Matching container inventory is observed only. No project mapping is known.</p>
                        ) : (
                          <p className="break-words text-muted-foreground">
                            Observed in {mappedContainers.length} mapped {mappedContainers.length === 1 ? "container" : "containers"}: {mappedContainers.map((container) => `${container.projectId}${container.componentId ? ` / ${container.componentId}` : ""}`).join(", ")}
                          </p>
                        )}
                      </div>

                      {scan.state === "failed" ? (
                        <p role="status" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground">
                          The scan did not complete. Review the local scanner output for details.
                        </p>
                      ) : null}

                      {scan.findings.length === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                          {scan.state === "succeeded" ? "No findings were returned by this scan." : "No findings are available for this scan."}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <h4 className="text-sm font-medium">{scan.findings.length} {scan.findings.length === 1 ? "finding" : "findings"}</h4>
                          <ul className="space-y-2">
                            {scan.findings.map((finding) => (
                              <li key={JSON.stringify([finding.target, finding.id, finding.package, finding.installedVersion])} className="min-w-0 rounded-md border border-border bg-card p-3">
                                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0 space-y-1">
                                    <h5 className="break-words text-sm font-medium">{finding.title}</h5>
                                    <p className="break-all text-xs text-muted-foreground">
                                      {finding.id} · {finding.package} {finding.installedVersion} · {finding.target}
                                    </p>
                                  </div>
                                  <Badge variant={severityVariant(finding.severity)}>{finding.severity}</Badge>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                  {finding.fixedVersion ? `Fixed version reported: ${finding.fixedVersion}` : "No fixed version reported"}
                                </p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {!error && !loading && changes.length > 0 ? (
        <section className="space-y-3" aria-labelledby="source-changes-heading">
          <div>
            <h3 id="source-changes-heading" className="text-sm font-semibold">Existing source changes</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Viewing only. Change review actions remain unavailable here.</p>
          </div>
          <ul className="space-y-2">
            {changes.map((change) => (
              <li key={change.id}>
                <Card>
                  <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
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
