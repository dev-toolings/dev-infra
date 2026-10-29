import * as React from "react";
import { FileText, FolderSearch, Plus, WandSparkles } from "lucide-react";
import type { Preset, PublicComponent, PublicDetection, PublicSetupPlan, Root, SetupInput } from "../../../../../src/contracts";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState } from "../ui/state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ViewTask, formatDateTime } from "./shared";

export interface AddProjectDialogProps {
  open: boolean;
  roots: Root[];
  presets: Preset[];
  detections: PublicDetection[];
  plan: PublicSetupPlan | undefined;
  busy: boolean;
  error?: string;
  onDiscover: (path: string) => ViewTask;
  onPreview: (input: SetupInput) => ViewTask;
  onApply: (planId: string) => ViewTask;
  onOpenChange: (open: boolean) => ViewTask;
}

function ProjectComponents({ components }: { components: PublicComponent[] }) {
  if (components.length === 0) {
    return <p className="text-sm text-muted-foreground">No components are included in this plan.</p>;
  }
  return (
    <ul className="space-y-2">
      {components.map((component) => (
        <li key={component.id} className="min-w-0 rounded-md border border-border bg-card p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-words text-sm font-medium">{component.name}</span>
            <Badge variant="outline">{component.kind === "native" ? "Native" : "Compose"}</Badge>
          </div>
          <code className="mt-1 block break-all text-xs leading-5 text-muted-foreground">{component.cwd}</code>
          {component.compose ? (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              Services: {component.compose.services.join(", ") || "None selected"}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function AddProjectDialog({
  open,
  roots,
  presets,
  detections,
  plan,
  busy,
  error,
  onDiscover,
  onPreview,
  onApply,
  onOpenChange,
}: AddProjectDialogProps) {
  const [rootId, setRootId] = React.useState<string>();
  const [pathOverride, setPathOverride] = React.useState<string>();
  const [name, setName] = React.useState("");
  const [presetId, setPresetId] = React.useState("");
  const [composeProjectName, setComposeProjectName] = React.useState("");
  const [previewedInputKey, setPreviewedInputKey] = React.useState<string>();
  const [planIdBeforeRequest, setPlanIdBeforeRequest] = React.useState<string>();

  const root = roots.find((item) => item.id === rootId) ?? roots[0];
  const path = pathOverride ?? root?.path ?? "";
  const preset = presets.some((item) => item.id === presetId) ? presetId : (presets[0]?.id ?? "");
  const trimmedName = name.trim();
  const trimmedPath = path.trim();
  const trimmedComposeName = composeProjectName.trim();
  const input: SetupInput | undefined = trimmedPath && trimmedName && preset
    ? {
        path: trimmedPath,
        name: trimmedName,
        preset,
        ...(trimmedComposeName ? { composeProjectName: trimmedComposeName } : {}),
      }
    : undefined;
  const inputKey = input
    ? [input.path, input.name, input.preset, input.composeProjectName ?? ""].join("\u001f")
    : undefined;
  const currentPlan = plan && inputKey && previewedInputKey === inputKey && plan.id !== planIdBeforeRequest ? plan : undefined;
  const planIsStale = Boolean(plan && previewedInputKey !== undefined && previewedInputKey !== inputKey);
  const waitingForPreview = Boolean(inputKey && previewedInputKey === inputKey && !currentPlan);
  const canPreview = Boolean(input && roots.length > 0 && !busy);
  const canApply = Boolean(currentPlan && !busy && !error);

  function invalidatePreview() {
    setPreviewedInputKey("");
    setPlanIdBeforeRequest(undefined);
  }

  function handleDiscover() {
    if (!trimmedPath || busy) return;
    invalidatePreview();
    onDiscover(trimmedPath);
  }

  function handlePreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input || !inputKey || busy) return;
    setPlanIdBeforeRequest(plan?.id);
    setPreviewedInputKey(inputKey);
    onPreview(input);
  }

  function useDetection(detection: PublicDetection) {
    setPathOverride(detection.path);
    setName(detection.name);
    invalidatePreview();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add an existing project</DialogTitle>
          <DialogDescription>Inspect an approved folder, review the generated setup plan, then explicitly confirm it.</DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Project setup could not continue</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        {roots.length === 0 ? (
          <EmptyState
            title="No approved project roots"
            description="Add a root in the local terminal, then reopen this dialog."
            icon={<FolderSearch aria-hidden="true" className="size-5" />}
            action={<code className="rounded bg-muted px-2 py-1 text-xs">devhub root add ~/Projects</code>}
          />
        ) : (
          <form className="min-w-0 space-y-5" onSubmit={handlePreview}>
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="project-root">Approved root</Label>
                <Select
                  value={root?.id ?? ""}
                  onValueChange={(value) => {
                    const nextRoot = roots.find((item) => item.id === value);
                    if (!nextRoot) return;
                    setRootId(nextRoot.id);
                    setPathOverride(nextRoot.path);
                    invalidatePreview();
                  }}
                >
                  <SelectTrigger id="project-root" disabled={busy}>
                    <SelectValue placeholder="Choose a root" />
                  </SelectTrigger>
                  <SelectContent>
                    {roots.map((item) => <SelectItem key={item.id} value={item.id}>{item.label} ({item.path})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0 space-y-2">
                <Label htmlFor="project-preset">Setup preset</Label>
                {presets.length > 0 ? (
                  <Select value={preset} onValueChange={(value) => { setPresetId(value); invalidatePreview(); }}>
                    <SelectTrigger id="project-preset" disabled={busy}>
                      <SelectValue placeholder="Choose a preset" />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">No setup presets are available.</p>
                )}
              </div>

              <div className="min-w-0 space-y-2 sm:col-span-2">
                <Label htmlFor="project-path">Project folder path</Label>
                <Input
                  id="project-path"
                  value={path}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="/home/user/Projects/example"
                  disabled={busy}
                  onChange={(event) => { setPathOverride(event.currentTarget.value); invalidatePreview(); }}
                />
                <p className="text-xs leading-5 text-muted-foreground">Use a folder inside the selected approved root. The local manager checks the path before acting.</p>
              </div>

              <div className="min-w-0 space-y-2">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  value={name}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => { setName(event.currentTarget.value); invalidatePreview(); }}
                />
              </div>

              <div className="min-w-0 space-y-2">
                <Label htmlFor="compose-project-name">Compose project name (optional)</Label>
                <Input
                  id="compose-project-name"
                  value={composeProjectName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => { setComposeProjectName(event.currentTarget.value); invalidatePreview(); }}
                />
                <p className="text-xs leading-5 text-muted-foreground">Use this when the existing Compose identity needs to be selected explicitly.</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={!trimmedPath || busy} onClick={handleDiscover}>
                <FolderSearch aria-hidden="true" />
                Inspect folder
              </Button>
              <Button type="submit" disabled={!canPreview}>
                <WandSparkles aria-hidden="true" />
                Preview setup
              </Button>
            </div>

            {detections.length > 0 ? (
              <section className="space-y-3" aria-labelledby="discovery-results-heading">
                <div>
                  <h3 id="discovery-results-heading" className="text-sm font-semibold">Detected project folders</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Choose a result to use its path and detected name in the form.</p>
                </div>
                <ul className="space-y-2">
                  {detections.map((detection) => (
                    <li key={detection.path}>
                      <Card>
                        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <CardTitle className="break-words text-sm">{detection.name}</CardTitle>
                            <CardDescription className="break-all">{detection.path}</CardDescription>
                          </div>
                          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => useDetection(detection)}>
                            Use this folder
                          </Button>
                        </CardHeader>
                        <CardContent className="space-y-2 text-xs">
                          <p className="break-words text-muted-foreground">Git: {detection.git} · Stacks: {detection.stacks.join(", ") || "None detected"}</p>
                          {detection.composeFiles.length > 0 ? <p className="break-all text-muted-foreground">Compose: {detection.composeFiles.join(", ")}</p> : null}
                          {detection.components.length > 0 ? <p className="text-muted-foreground">{detection.components.length} component candidates</p> : null}
                          {detection.warnings.length > 0 ? (
                            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                              {detection.warnings.map((warning, index) => <li key={`${index}:${warning}`} className="break-words">{warning}</li>)}
                            </ul>
                          ) : null}
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {planIsStale ? (
              <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                The form changed after this preview. Preview again before applying a plan.
              </p>
            ) : null}
            {waitingForPreview && !busy ? (
              <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                A fresh preview is not available yet. Review any error above, then preview again.
              </p>
            ) : null}

            {currentPlan ? (
              <section className="space-y-3 border-t border-border pt-4" aria-labelledby="setup-preview-heading">
                <div>
                  <h3 id="setup-preview-heading" className="text-base font-semibold">Review setup plan</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Preview created {formatDateTime(currentPlan.createdAt)}. No files are changed until you confirm.</p>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">{currentPlan.project.name}</CardTitle>
                    <CardDescription className="break-all">{currentPlan.project.root}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ProjectComponents components={currentPlan.project.components} />
                    {currentPlan.warnings.length > 0 ? (
                      <Alert>
                        <FileText aria-hidden="true" />
                        <AlertTitle>Review these warnings</AlertTitle>
                        <AlertDescription>
                          <ul className="list-disc space-y-1 pl-4">
                            {currentPlan.warnings.map((warning, index) => <li key={`${index}:${warning}`} className="break-words">{warning}</li>)}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>

                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Planned files</h4>
                  {currentPlan.files.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">No project files will be created by this plan.</p>
                  ) : (
                    <ul className="space-y-2">
                      {currentPlan.files.map((file) => (
                        <li key={file.path} className="min-w-0 rounded-md border border-border bg-card">
                          <details className="min-w-0">
                            <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                              <code className="break-all">{file.path}</code>
                            </summary>
                            <pre className="m-0 max-h-64 overflow-auto border-t border-border bg-log-panel p-3 font-mono text-xs leading-5 text-log-foreground"><code className="whitespace-pre-wrap break-words">{file.content}</code></pre>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <DialogFooter>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
                  <Button type="button" disabled={!canApply} onClick={() => currentPlan && onApply(currentPlan.id)}>
                    <Plus aria-hidden="true" />
                    Confirm and add project
                  </Button>
                </DialogFooter>
              </section>
            ) : null}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
