import { t } from "../../lib/i18n";
import * as React from "react";
import { AlertCircle, ExternalLink, GitBranch, LoaderCircle, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import type { FeatureEnvironment } from "../../lib/api";
import { createEnvironment, errorMessage, getEnvironment, isAbortError, listEnvironmentRecipes, listEnvironments, removeEnvironment, startEnvironment, stopEnvironment } from "../../lib/api";
import { useResource } from "../../lib/use-resource";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState, ErrorState } from "../ui/state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { safeHttpUrl } from "./shared";

const REFRESH_MS = 5000;

const statusStyle: Record<FeatureEnvironment["observed"], { tone: "outline" | "up" | "degraded" | "down" | "info"; label: string }> = {
  creating: { tone: "info", label: t("Creating") },
  starting: { tone: "info", label: t("Starting") },
  ready: { tone: "up", label: t("Ready") },
  degraded: { tone: "degraded", label: t("Degraded") },
  error: { tone: "down", label: t("Error") },
  stopping: { tone: "info", label: t("Stopping") },
  stopped: { tone: "outline", label: t("Stopped") },
  destroying: { tone: "info", label: t("Removing") },
  destroyed: { tone: "outline", label: t("Removed") },
};

function serviceRows(services: string[] = [], containers: NonNullable<FeatureEnvironment["resources"]>["containers"] = []): { name: string; state: string }[] {
  const stateByService = new Map<string, string>();
  for (const container of containers ?? []) stateByService.set(container.service, container.health ?? container.state);
  const names = [...new Set([...services, ...stateByService.keys()])];
  return names.map((name) => ({ name, state: stateByService.get(name) ?? t("Unknown") }));
}

export function EnvironmentsView() {
  const actionRevision = React.useRef(0);
  const [actionResults, setActionResults] = React.useState(() => new Map<string, { revision: number; environment: FeatureEnvironment }>());
  const environments = useResource(async (signal) => {
    const revision = actionRevision.current;
    return { revision, items: await listEnvironments(signal) };
  }, "environments", { refreshMs: REFRESH_MS });
  const recipes = useResource(listEnvironmentRecipes, "environment-recipes");
  const [showCreate, setShowCreate] = React.useState(false);
  const [feature, setFeature] = React.useState("");
  const [recipeId, setRecipeId] = React.useState("");
  const [build, setBuild] = React.useState(false);
  const [createBusy, setCreateBusy] = React.useState(false);
  const [createError, setCreateError] = React.useState<string>();
  const [actionBusy, setActionBusy] = React.useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = React.useState<{ id: string; message: string }>();
  const [expandedId, setExpandedId] = React.useState<string>();
  const [removing, setRemoving] = React.useState<FeatureEnvironment>();
  const removeTrigger = React.useRef<HTMLButtonElement | null>(null);
  const listRef = React.useRef<HTMLElement | null>(null);
  const detail = useResource(
    (signal) => getEnvironment(expandedId ?? "", signal),
    expandedId,
    { refreshMs: REFRESH_MS },
  );

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recipes.data?.some(({ id }) => id === recipeId) || !feature.trim() || createBusy) return;
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      await createEnvironment({ project: recipeId, feature: feature.trim(), idempotencyKey: crypto.randomUUID(), ...(build ? { build: true } : {}) });
      setFeature("");
      setBuild(false);
      setShowCreate(false);
      environments.reload();
    } catch (error) {
      if (!isAbortError(error)) setCreateError(errorMessage(error));
    } finally {
      setCreateBusy(false);
    }
  }

  async function runAction(environment: FeatureEnvironment, action: "start" | "stop" | "remove") {
    setActionBusy((current) => new Set(current).add(environment.id));
    setActionError(undefined);
    try {
      const updated = await (action === "start" ? startEnvironment(environment.id)
        : action === "stop" ? stopEnvironment(environment.id) : removeEnvironment(environment.id));
      const revision = ++actionRevision.current;
      setActionResults((current) => new Map(current).set(environment.id, { revision, environment: updated }));
      if (action === "remove") {
        setExpandedId(undefined);
        setRemoving(undefined);
      }
    } catch (error) {
      if (!isAbortError(error)) setActionError({ id: environment.id, message: errorMessage(error) });
    } finally {
      setActionBusy((current) => {
        const next = new Set(current);
        next.delete(environment.id);
        return next;
      });
      environments.reload();
    }
  }

  const list = environments.data;
  const items = list && list.items.map((item) => {
    const result = actionResults.get(item.id);
    // A poll that began before the action result may still resolve with the old preview.
    return result && result.revision > list.revision ? result.environment : item;
  });
  const recipeOptions = [...(recipes.data ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const removingBusy = removing !== undefined && actionBusy.has(removing.id);

  return (
    <section ref={listRef} tabIndex={-1} aria-label={t("Feature environments")} className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col gap-4 outline-none">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("Work on a feature in isolation")}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{t("Each feature gets its own worktree and services, while the main project stays untouched.")}</p>
        </div>
        <Button type="button" className="min-h-11 sm:min-h-8" onClick={() => { setShowCreate((open) => !open); setCreateError(undefined); }}>
          <Plus aria-hidden="true" />{t("New environment")}
        </Button>
      </div>

      <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">{t("Preview addresses use a local tunnel when the application listens on loopback, so the browser can reach it safely.")}</p>

      {showCreate ? (
        <Card className="p-4 sm:p-5">
          <form className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end" onSubmit={submitCreate}>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="environment-project">{t("Recipe")}</Label>
              <select id="environment-project" name="project" required value={recipeId} onChange={(event) => setRecipeId(event.target.value)} className="h-9 min-w-0 rounded-lg border border-input bg-background px-2.5 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm">
                <option value="">{t("Choose a recipe")}</option>
                {recipeOptions.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.id}</option>)}
              </select>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="environment-feature">{t("Feature name")}</Label>
              <Input id="environment-feature" name="feature" autoComplete="off" placeholder={t("For example, search-filters")} value={feature} onChange={(event) => setFeature(event.target.value)} required />
            </div>
            <div className="flex flex-wrap items-center gap-3 md:justify-end">
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                <input type="checkbox" checked={build} onChange={(event) => setBuild(event.target.checked)} className="size-4 accent-primary" />
                {t("Build after creation")}
              </label>
              <Button type="submit" className="min-h-11 md:min-h-8" disabled={!recipeId || !feature.trim() || createBusy || recipeOptions.length === 0}>
                {createBusy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <GitBranch aria-hidden="true" />}{t("Create environment")}
              </Button>
              <Button type="button" variant="outline" className="min-h-11 md:min-h-8" disabled={createBusy} onClick={() => setShowCreate(false)}>{t("Cancel")}</Button>
            </div>
          </form>
          {recipes.error ? <p className="mt-3 text-xs text-muted-foreground">{t("Recipe suggestions are unavailable")}</p> : null}
          {!recipes.loading && !recipes.error && recipeOptions.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">{t("No feature recipes are available.")}</p> : null}
          {createError ? <Alert variant="destructive" className="mt-4"><AlertTitle>{t("Environment could not be created")}</AlertTitle><AlertDescription>{createError}</AlertDescription></Alert> : null}
        </Card>
      ) : null}

      {environments.error && !environments.data ? <ErrorState title={t("Environments could not be loaded")} description={environments.error} action={<Button type="button" variant="outline" onClick={environments.reload}><RefreshCw aria-hidden="true" />{t("Try again")}</Button>} /> : null}
      {environments.loading ? <div role="status" aria-busy="true" className="rounded-xl border p-5 text-sm text-muted-foreground">{t("Loading feature environments")}</div> : null}
      {environments.error && environments.data ? <Alert variant="destructive"><AlertTitle>{t("Environments could not be refreshed")}</AlertTitle><AlertDescription>{environments.error}</AlertDescription></Alert> : null}
      {!environments.loading && !environments.error && items?.length === 0 ? (
        <EmptyState title={t("No feature environments yet")} description={t("Create an environment to work on a feature in its own branch and services.")} icon={<GitBranch aria-hidden="true" className="size-5" />} action={<Button type="button" onClick={() => setShowCreate(true)}><Plus aria-hidden="true" />{t("New environment")}</Button>} />
      ) : null}

      {items && items.length > 0 ? (
        <ul className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {items.map((environment) => {
            const status = statusStyle[environment.observed] ?? statusStyle.error;
            const currentEnvironment = environment.id === detail.data?.id ? detail.data : environment;
            const services = serviceRows(currentEnvironment.configuration?.services, currentEnvironment.resources?.containers);
            const busy = actionBusy.has(environment.id);
            const preview = !busy && environment.desired === "running" && environment.observed === "ready" ? environment.preview : undefined;
            const previewUrl = safeHttpUrl(preview?.url);
            const domainPreviewUrl = safeHttpUrl(preview?.domainUrl);
            const canStop = environment.desired === "running" && !["stopped", "stopping", "destroying", "destroyed"].includes(environment.observed);
            const canRetry = environment.desired === "running" && ["error", "degraded"].includes(environment.observed);
            const canStart = environment.desired !== "destroyed" && (environment.desired !== "running" || canRetry) && !["creating", "starting", "destroying", "destroyed"].includes(environment.observed);
            const environmentError = environment.id === detail.data?.id
              ? detail.data.operation?.error?.message ?? detail.data.observationError?.message
              : environment.operation?.error?.message ?? environment.observationError?.message;
            const err = actionError?.id === environment.id ? actionError.message : environmentError;
            return (
              <li key={environment.id} className="min-w-0">
                <Card className="flex h-full min-w-0 flex-col gap-4 p-4 sm:p-5">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{environment.feature}</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">{environment.project}</p>
                    </div>
                    <Badge variant={status.tone}>{status.label}</Badge>
                  </div>
                  {environment.operation?.step ? <p className="text-xs text-muted-foreground">{t("Step")}: {environment.operation.step}</p> : null}
                  {err ? <Alert variant="destructive"><AlertCircle aria-hidden="true" /><AlertTitle>{t("Environment action failed")}</AlertTitle><AlertDescription>{environment.operation?.error?.code ? <span className="font-mono">{environment.operation.error.code}: </span> : null}{err}</AlertDescription></Alert> : null}
                  {expandedId === environment.id && detail.error ? <p role="alert" className="text-xs text-destructive">{t("Environment details could not be refreshed")}: {detail.error}</p> : null}
                  <div className="min-w-0 rounded-lg border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-medium">{t("Preview")}</p>
                      {previewUrl ? <a className="inline-flex min-h-11 items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8" href={previewUrl} target="_blank" rel="noopener noreferrer">{t("Open preview")}<ExternalLink aria-hidden="true" className="size-3.5" /></a> : <Button type="button" variant="outline" className="min-h-11 md:min-h-8" disabled><ExternalLink aria-hidden="true" />{t("Open preview")}</Button>}
                    </div>
                    {previewUrl ? <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{previewUrl}</p> : <p className="mt-1 text-xs text-muted-foreground">{t("Preview is not ready yet")}</p>}
                    {preview?.port ? <p className="mt-1 text-xs text-muted-foreground">{t("Port {port}", { port: preview.port })}</p> : null}
                    {domainPreviewUrl ? <p className="mt-1 break-all text-xs"><a className="text-primary underline-offset-4 hover:underline" href={domainPreviewUrl} target="_blank" rel="noopener noreferrer">{t("Open domain preview")}</a></p> : null}
                  </div>
                  {services.length > 0 ? (
                    <div>
                      <p className="mb-2 text-xs font-medium">{t("Services")}</p>
                      <ul className="flex flex-wrap gap-1.5">{services.map((service) => <li key={service.name}><Badge variant="outline" className="max-w-full gap-1"><span className="max-w-44 truncate">{service.name}</span><span className="text-muted-foreground">{service.state}</span></Badge></li>)}</ul>
                    </div>
                  ) : null}
                  {expandedId === environment.id && detail.data?.id === environment.id ? (
                    <dl className="grid min-w-0 gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2">
                      <div className="min-w-0"><dt className="text-muted-foreground">{t("Environment ID")}</dt><dd className="mt-1 break-all font-mono">{detail.data.id}</dd></div>
                      <div className="min-w-0"><dt className="text-muted-foreground">{t("Desired state")}</dt><dd className="mt-1">{detail.data.desired}</dd></div>
                    </dl>
                  ) : null}
                  {expandedId === environment.id && detail.loading ? <p role="status" className="text-xs text-muted-foreground">{t("Loading environment details")}</p> : null}
                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
                    {canStart ? <Button type="button" className="min-h-11 md:min-h-8" disabled={busy} onClick={() => void runAction(environment, "start")}><Play aria-hidden="true" />{t(canRetry ? "Retry" : "Start")}</Button> : null}
                    {canStop ? <Button type="button" variant="outline" className="min-h-11 md:min-h-8" disabled={busy} onClick={() => void runAction(environment, "stop")}><Square aria-hidden="true" />{t("Stop")}</Button> : null}
                    <Button type="button" variant="ghost" className="min-h-11 text-muted-foreground hover:text-destructive md:min-h-8" disabled={busy || environment.observed === "destroying" || environment.observed === "destroyed"} onClick={(event) => { removeTrigger.current = event.currentTarget; setRemoving(environment); setActionError(undefined); }}><Trash2 aria-hidden="true" />{t("Remove")}</Button>
                    <Button type="button" variant="ghost" className="min-h-11 md:min-h-8" onClick={() => setExpandedId((current) => current === environment.id ? undefined : environment.id)}>{t(expandedId === environment.id ? "Hide details" : "Details")}</Button>
                    <Button type="button" variant="ghost" className="ml-auto min-h-11 md:min-h-8" disabled={busy} onClick={() => { environments.reload(); if (expandedId === environment.id) detail.reload(); }}>{busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />}{t("Refresh")}</Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {removing ? (
        <Dialog open onOpenChange={(open) => { if (!open && !removingBusy) setRemoving(undefined); }}>
          <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); (removeTrigger.current?.isConnected ? removeTrigger.current : listRef.current)?.focus(); }}>
            <DialogHeader>
              <DialogTitle className="break-words">{t("Remove environment resources for {feature}?", { feature: removing.feature })}</DialogTitle>
              <DialogDescription>{t("Services stop and the environment remains in this list with its last inventory. Its worktree, branch, and data volumes are kept.")}</DialogDescription>
            </DialogHeader>
            {actionError?.id === removing.id ? <Alert variant="destructive"><AlertTitle>{t("Environment could not be removed")}</AlertTitle><AlertDescription>{actionError.message}</AlertDescription></Alert> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={removingBusy} onClick={() => setRemoving(undefined)}>{t("Cancel")}</Button>
              <Button type="button" variant="destructive" disabled={removingBusy} onClick={() => void runAction(removing, "remove")}>
                {removingBusy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Trash2 aria-hidden="true" />}{t("Remove")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
