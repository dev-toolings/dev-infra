import { t } from "../../lib/i18n";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

/**
 * Loading placeholders that mirror the layout of the view they stand in for, so content
 * replaces them without a jump. Each one is a single `status` region with a spoken label.
 */
function Busy({ label, className, outerClassName, children }: { label: string; className?: string; outerClassName?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn("min-w-0", outerClassName)}>
      <div aria-hidden="true" className={cn("min-w-0", className)}>{children}</div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function Repeat({ count, children }: { count: number; children: (index: number) => ReactNode }) {
  return <>{Array.from({ length: count }, (_, index) => children(index))}</>;
}

/** Label/value pairs, as in the `dl` grids of container and scan cards. */
function FieldGrid({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3", className)}>
      <Repeat count={count}>
        {(index) => (
          <div key={index} className="space-y-1.5">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className={cn("h-3.5", index % 2 === 0 ? "w-16" : "w-24")} />
          </div>
        )}
      </Repeat>
    </div>
  );
}

const projectNameWidths = ["w-28", "w-36", "w-24"];

export function ProjectListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Busy label={t("Loading projects")} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 min-[110rem]:grid-cols-4">
      <Repeat count={count}>
        {(index) => (
          <div key={index} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-lg" />
                <div className="space-y-1.5">
                  <Skeleton className={cn("h-3.5", projectNameWidths[index % projectNameWidths.length])} />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-5.5 w-16" />
            </div>
            <Skeleton className="h-3 w-4/5" />
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        )}
      </Repeat>
    </Busy>
  );
}

export function ProjectDetailSkeleton() {
  return (
    <Busy label={t("Loading project details")} className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-24" />
        <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs">
          <Skeleton className="size-8 rounded-md" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="ml-auto h-5.5 w-16" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-7 w-56 rounded-lg" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </Busy>
  );
}

/** Stat tiles, toolbar and table rows: the inventory layout shared by Containers and image scans. */
function InventorySkeleton({ label, columns, rows = 8 }: { label: string; columns: string[]; rows?: number }) {
  return (
    <Busy label={label} className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Repeat count={4}>
          {(index) => (
            <div key={index} className="space-y-2.5 rounded-xl border bg-card p-3.5 shadow-xs">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-10" />
              <Skeleton className="h-3 w-28" />
            </div>
          )}
        </Repeat>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-7 w-44" />
        <Skeleton className="ml-auto h-3 w-24" />
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="flex h-9 items-center gap-6 border-b bg-muted/40 px-3">
          {columns.map((width, index) => <Skeleton key={index} className={cn("h-2.5", width)} />)}
        </div>
        <Repeat count={rows}>
          {(index) => (
            <div key={index} className="flex items-center gap-6 border-b px-3 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className={cn("h-3.5", projectNameWidths[index % projectNameWidths.length])} />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              {columns.slice(1).map((width, column) => <Skeleton key={column} className={cn("hidden h-5 sm:block", width)} />)}
            </div>
          )}
        </Repeat>
      </div>
    </Busy>
  );
}

export function ContainersSkeleton() {
  return <InventorySkeleton label={t("Loading container inventory")} columns={["w-20", "w-24", "w-16", "w-12", "w-14", "w-28"]} />;
}

const logMessageWidths = ["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-2/5", "w-4/5"];

export function LogsSkeleton({ lines = 8 }: { lines?: number }) {
  return (
    <Busy label={t("Connecting to the log stream")} className="rounded-lg border border-log-panel bg-log-panel px-3 sm:px-4">
      <Repeat count={lines}>
        {(index) => (
          <div key={index} className="space-y-2 border-b border-log-foreground/10 py-2.5 last:border-b-0">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-16 bg-log-foreground/10" />
              <Skeleton className="h-4 w-12 bg-log-foreground/10" />
              <Skeleton className="h-3 w-20 bg-log-foreground/10" />
            </div>
            <Skeleton className={cn("h-3 bg-log-foreground/10", logMessageWidths[index % logMessageWidths.length])} />
          </div>
        )}
      </Repeat>
    </Busy>
  );
}

export function ScansSkeleton() {
  return <InventorySkeleton label={t("Loading images and scans")} columns={["w-20", "w-28", "w-24", "w-20", "w-16"]} rows={6} />;
}

/** Stand-in for the whole shell while the session is checked, matching the floating sidebar. */
export function ShellSkeleton({ label }: { label: string }) {
  return (
    <Busy label={label} className="flex h-svh gap-2 bg-muted p-2">
      <div className="hidden w-[244px] shrink-0 flex-col rounded-lg border bg-background p-2 shadow-xs md:flex">
        <div className="flex items-center gap-2 p-2">
          <Skeleton className="size-7 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        </div>
        <div className="mt-4 space-y-3 px-2">
          <Skeleton className="h-2.5 w-16" />
          <Repeat count={4}>
            {(index) => (
              <div key={index} className="flex items-center gap-2">
                <Skeleton className="size-4 rounded-sm" />
                <Skeleton className={cn("h-3.5", index % 2 === 0 ? "w-20" : "w-24")} />
              </div>
            )}
          </Repeat>
        </div>
        <div className="mt-auto flex items-center gap-2 p-2">
          <Skeleton className="size-7 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-2.5 w-28" />
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background shadow-xs">
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
          <Skeleton className="size-5 rounded-sm" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-2.5 w-56" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Repeat count={3}>{(index) => <Skeleton key={index} className="h-28 rounded-lg" />}</Repeat>
          </div>
          <div className="hidden space-y-3 lg:block">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
            <Skeleton className="mt-5 h-40 rounded-xl" />
          </div>
        </div>
      </div>
    </Busy>
  );
}

export function CreateProjectSkeleton() {
  return (
    <Busy label={t("Loading project form")} outerClassName="w-full flex-1" className="grid h-full gap-4 xl:grid-cols-[minmax(28rem,36rem)_minmax(0,1fr)]">
      <Card className="gap-4 p-4 md:p-5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </Card>
      <Card className="gap-2 p-4 md:p-5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </Card>
    </Busy>
  );
}
