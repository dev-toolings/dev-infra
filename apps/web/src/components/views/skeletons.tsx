import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

/**
 * Loading placeholders that mirror the layout of the view they stand in for, so content
 * replaces them without a jump. Each one is a single `status` region with a spoken label.
 */
function Busy({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="min-w-0">
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
    <Busy label="Loading projects" className="grid grid-cols-1 gap-3">
      <Repeat count={count}>
        {(index) => (
          <div key={index} className="flex min-h-28 flex-col gap-2.5 rounded-lg border bg-card p-4 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-4 rounded-sm" />
                <Skeleton className={cn("h-3.5", projectNameWidths[index % projectNameWidths.length])} />
              </div>
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-32" />
          </div>
        )}
      </Repeat>
    </Busy>
  );
}

export function ProjectDetailSkeleton() {
  return (
    <Busy label="Loading project details" className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-5.5 w-24" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3.5 w-24" />
        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          <Repeat count={2}>
            {(index) => (
              <Card key={index}>
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-52" />
                  </div>
                  <div className="flex gap-1.5">
                    <Skeleton className="h-5.5 w-16" />
                    <Skeleton className="h-5.5 w-16" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FieldGrid count={3} />
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-20" />
                    <Skeleton className="h-8 w-20" />
                    <Skeleton className="h-8 w-20" />
                  </div>
                </CardContent>
              </Card>
            )}
          </Repeat>
        </div>
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
  return <InventorySkeleton label="Loading container inventory" columns={["w-20", "w-24", "w-16", "w-12", "w-14", "w-28"]} />;
}

const logMessageWidths = ["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-2/5", "w-4/5"];

export function LogsSkeleton({ lines = 8 }: { lines?: number }) {
  return (
    <Busy label="Connecting to the log stream" className="rounded-lg border border-log-panel bg-log-panel px-3 sm:px-4">
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
  return <InventorySkeleton label="Loading images and scans" columns={["w-20", "w-28", "w-24", "w-20", "w-16"]} rows={6} />;
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
