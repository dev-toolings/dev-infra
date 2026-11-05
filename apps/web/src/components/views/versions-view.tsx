import * as React from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { VersionItem, VersionState } from "../../../../../src/contracts";
import { checkVersions, errorMessage, getVersions, isAbortError } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { Lifetime } from "../../lib/use-lifetime";
import { useResource } from "../../lib/use-resource";
import { ErrorToast } from "../error-toast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { DetailRow, matches, SearchField, StatTile } from "./inventory";
import { formatDateTime } from "./shared";

type Variant = "up" | "degraded" | "down" | "outline";

/** Worst first: the table reads top down. */
const STATES: { state: VersionState; label: string; variant: Variant }[] = [
  { state: "eol", label: t("End of life"), variant: "down" },
  { state: "vulnerable", label: t("Vulnerable"), variant: "down" },
  { state: "eol-soon", label: t("Ends soon"), variant: "degraded" },
  { state: "outdated", label: t("Update available"), variant: "degraded" },
  { state: "unknown", label: t("Unknown"), variant: "outline" },
  { state: "ok", label: t("Up to date"), variant: "up" },
  { state: "untracked", label: t("No lifecycle data"), variant: "outline" },
];
const rank = (state: VersionState) => STATES.findIndex((item) => item.state === state);
const itemKey = (item: VersionItem) => `${item.kind}:${item.source}:${item.name}:${item.version}`;

function StateBadge({ state }: { state: VersionState }) {
  const shown = STATES[rank(state)]!;
  return <Badge variant={shown.variant}>{shown.label}</Badge>;
}

export function VersionsView({ lifetime }: { lifetime: Lifetime }) {
  const report = useResource(getVersions, "versions");
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [failures, setFailures] = React.useState(0);
  const [filter, setFilter] = React.useState<VersionState>();
  const [query, setQuery] = React.useState("");
  const [openKey, setOpenKey] = React.useState<string>();

  async function check() {
    const signal = lifetime();
    if (!signal) return;
    setChecking(true);
    setError(undefined);
    try {
      const next = await checkVersions(signal);
      report.update(() => next);
    } catch (caught) {
      if (!isAbortError(caught)) { setError(errorMessage(caught)); setFailures((count) => count + 1); }
    } finally {
      if (!signal.aborted) setChecking(false);
    }
  }

  if (report.error) return <ErrorState description={report.error} />;
  if (report.loading) return <Skeleton className="h-96 w-full rounded-xl" />;

  const items = [...(report.data?.items ?? [])].sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
  const count = (state: VersionState) => items.filter((item) => item.state === state).length;
  const rows = items.filter((item) => (!filter || item.state === filter) && matches(query, item.name, item.version, item.ecosystem));
  const open = items.find((item) => itemKey(item) === openKey);
  const toggle = (state: VersionState) => () => setFilter((current) => current === state ? undefined : state);
  const checkButton = (
    <Button type="button" aria-busy={checking} disabled={checking} onClick={() => void check()}>
      {checking ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />}
      {checking ? t("Checking") : t("Check now")}
    </Button>
  );

  return (
    <section className="min-w-0 space-y-4" aria-label={t("Versions")}>
      {error ? <ErrorToast key={failures} title={t("Version check failed")} message={error} onDismiss={() => setError(undefined)} /> : null}
      {!report.data ? (
        <EmptyState title={t("No version check yet")} description={t("Check the runtimes, services and packages DevHub installs for end of life, known CVEs and new releases.")} action={checkButton} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label={t("End of life")} value={count("eol")} tone="down" hint={t("No more security fixes")} pressed={filter === "eol"} onSelect={toggle("eol")} />
            <StatTile label={t("Vulnerable")} value={count("vulnerable")} tone="down" hint={t("Known CVEs in the pinned version")} pressed={filter === "vulnerable"} onSelect={toggle("vulnerable")} />
            <StatTile label={t("Ends soon")} value={count("eol-soon")} tone="degraded" hint={t("Support ends within 6 months")} pressed={filter === "eol-soon"} onSelect={toggle("eol-soon")} />
            <StatTile label={t("Update available")} value={count("outdated")} tone="degraded" hint={t("A newer release exists")} pressed={filter === "outdated"} onSelect={toggle("outdated")} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchField value={query} onChange={setQuery} label={t("Search name or version")} />
            <span className="text-xs text-muted-foreground">{t("Last check: {date}", { date: formatDateTime(report.data.checkedAt) })}</span>
            <div className="ml-auto">{checkButton}</div>
          </div>
          {rows.length === 0 ? (
            <EmptyState title={t("No version matches")} description={t("Change the search or the filter to see more versions.")} />
          ) : (
            <Card className="overflow-hidden">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>{t("Name")}</TableHead>
                    <TableHead className="w-28">{t("Version")}</TableHead>
                    <TableHead className="hidden w-28 sm:table-cell">{t("Latest")}</TableHead>
                    <TableHead className="hidden w-36 md:table-cell">{t("End of support")}</TableHead>
                    <TableHead className="w-52">{t("State")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((item) => (
                    <TableRow key={itemKey(item)} className="cursor-pointer" onClick={() => setOpenKey(itemKey(item))}>
                      <TableCell>
                        <button type="button" className="block max-w-full truncate text-left font-medium" onClick={() => setOpenKey(itemKey(item))}>{item.name}</button>
                        <span className="block truncate text-xs text-muted-foreground">{item.ecosystem ?? t("Docker image")}, {item.source}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.version}</TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">{item.latest}</TableCell>
                      <TableCell className="hidden text-xs md:table-cell">
                        {item.eol}
                        {item.lts ? <Badge variant="outline" className="ml-1.5">LTS</Badge> : null}
                      </TableCell>
                      <TableCell><StateBadge state={item.state} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(next) => { if (!next) setOpenKey(undefined); }}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          {open ? (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="break-all pr-6">{open.name}</SheetTitle>
                <SheetDescription className="font-mono">{open.source}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 p-4">
                <dl className="divide-y">
                  <DetailRow label={t("State")}><StateBadge state={open.state} /></DetailRow>
                  <DetailRow label={t("Version")} mono>{open.version}</DetailRow>
                  {open.latest ? <DetailRow label={t("Latest")} mono>{open.latest}</DetailRow> : null}
                  {open.cycle ? <DetailRow label={t("Release line")} mono>{open.cycle}{open.lts ? " LTS" : ""}</DetailRow> : null}
                  {open.eol ? <DetailRow label={t("End of support")}>{open.eol}</DetailRow> : null}
                </dl>
                {open.vulns.length > 0 ? (
                  <section aria-labelledby="version-vulns" className="space-y-2">
                    <h3 id="version-vulns" className="text-sm font-semibold">{t("Advisories")}</h3>
                    <ul className="divide-y rounded-lg border">
                      {open.vulns.map((vuln) => (
                        <li key={vuln.id} className="space-y-1 p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2 font-mono">
                            {vuln.cve ?? vuln.id}
                            {vuln.severity ? <Badge variant={vuln.severity === "low" ? "outline" : vuln.severity === "moderate" ? "degraded" : "down"}>{vuln.severity}</Badge> : null}
                          </div>
                          {vuln.summary ? <p>{vuln.summary}</p> : null}
                          {vuln.fixed ? <p className="text-muted-foreground">{t("Fixed in {version}", { version: vuln.fixed })}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {open.errors.length > 0 ? (
                  <section aria-labelledby="version-errors" className="space-y-2">
                    <h3 id="version-errors" className="text-sm font-semibold">{t("Not checked")}</h3>
                    <ul className="space-y-1 text-xs text-muted-foreground">{open.errors.map((item) => <li key={item} className="break-all">{item}</li>)}</ul>
                  </section>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
