import * as React from "react";
import { BadgeCheck, CircleAlert, FileCode2, LoaderCircle, SearchCheck, ShieldAlert } from "lucide-react";
import type { PublicChange, PublicProject, RemediationInput } from "../../../../../src/contracts";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState, ErrorState } from "../ui/state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ViewHeading, formatDateTime, type ViewTask } from "./shared";

export interface RemediationPanelProps {
  projects: PublicProject[];
  changes: PublicChange[];
  selectedChangeId?: string;
  busy?: boolean;
  error?: string;
  onSelectChange: (changeId: string | undefined) => ViewTask;
  onPreview: (input: RemediationInput) => ViewTask;
  onApply: (changeId: string) => ViewTask;
  onValidate: (changeId: string) => ViewTask;
  onActivate: (changeId: string) => ViewTask;
}

function isRelativeSourcePath(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function changeStateLabel(state: PublicChange["state"]): string {
  switch (state) {
    case "preview": return "Preview ready";
    case "applied": return "Applied";
    case "validated": return "Validated";
    case "failed": return "Failed";
    case "activated": return "Activated";
  }
}

function changeStateVariant(state: PublicChange["state"]): "default" | "secondary" | "destructive" | "outline" {
  if (state === "failed") return "destructive";
  if (state === "validated" || state === "activated") return "secondary";
  if (state === "applied") return "default";
  return "outline";
}

export function RemediationPanel({
  projects,
  changes,
  selectedChangeId,
  busy = false,
  error,
  onSelectChange,
  onPreview,
  onApply,
  onValidate,
  onActivate,
}: RemediationPanelProps) {
  const [projectId, setProjectId] = React.useState<string>();
  const [componentId, setComponentId] = React.useState<string>();
  const [file, setFile] = React.useState("");
  const [replacement, setReplacement] = React.useState("");
  const [service, setService] = React.useState("");
  const [stage, setStage] = React.useState("");
  const [previewedFormKey, setPreviewedFormKey] = React.useState<string>();
  const [changeIdsBeforePreview, setChangeIdsBeforePreview] = React.useState<string[]>([]);
  const [confirmingChangeId, setConfirmingChangeId] = React.useState<string>();

  const project = projects.find((item) => item.id === projectId);
  const composeComponents = project?.components.filter((component) => component.kind === "compose") ?? [];
  const component = composeComponents.find((item) => item.id === componentId);
  const services = component?.compose?.services ?? [];
  const selectedService = services.includes(service) ? service : "";
  const trimmedFile = file.trim();
  const normalizedFile = trimmedFile.replaceAll("\\", "/");
  const trimmedReplacement = replacement.trim();
  const trimmedStage = stage.trim();
  const pathIsRelative = isRelativeSourcePath(normalizedFile);
  const input: RemediationInput | undefined = project && component && pathIsRelative && trimmedReplacement
    ? {
        projectId: project.id,
        componentId: component.id,
        file: normalizedFile,
        replacement: trimmedReplacement,
        ...(selectedService ? { service: selectedService } : {}),
        ...(trimmedStage ? { stage: trimmedStage } : {}),
      }
    : undefined;
  const inputKey = input
    ? [input.projectId, input.componentId, input.file, input.replacement, input.service ?? "", input.stage ?? ""].join("\u001f")
    : undefined;
  const change = changes.find((item) => item.id === selectedChangeId);
  const formMatchesChange = Boolean(
    input && change &&
    change.projectId === input.projectId &&
    change.componentId === input.componentId &&
    (change.file === input.file || change.file === `${project?.root.replace(/\/$/, "")}/${input.file}`) &&
    change.replacement === input.replacement,
  );
  const freshPreview = Boolean(
    change && inputKey && previewedFormKey === inputKey &&
    !changeIdsBeforePreview.includes(change.id) && formMatchesChange,
  );
  const canApply = Boolean(change?.state === "preview" && freshPreview && !busy && !error);
  const canValidate = Boolean(change?.state === "applied" && !busy && !error);
  const canActivate = Boolean(change?.state === "validated" && change.imageId && !busy && !error);
  const confirmationChange = changes.find((item) => item.id === confirmingChangeId);
  const confirmationAllowed = Boolean(
    confirmationChange?.state === "validated" && confirmationChange.imageId && !busy && !error,
  );

  function handlePreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input || !inputKey || busy) return;
    setPreviewedFormKey(inputKey);
    setChangeIdsBeforePreview(changes.map((item) => item.id));
    onPreview(input);
  }

  function selectProject(value: string) {
    const nextProjectId = value.startsWith("project:") ? value.slice("project:".length) : undefined;
    setProjectId(nextProjectId);
    setComponentId(undefined);
    setFile("");
    setReplacement("");
    setService("");
    setStage("");
  }

  function selectComponent(value: string) {
    setComponentId(value.startsWith("component:") ? value.slice("component:".length) : undefined);
    setFile("");
    setReplacement("");
    setService("");
    setStage("");
  }

  function confirmActivation() {
    if (!confirmationAllowed || !confirmationChange) return;
    const targetId = confirmationChange.id;
    setConfirmingChangeId(undefined);
    onActivate(targetId);
  }

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="remediation-heading">
      <ViewHeading
        title="Source image change"
        titleId="remediation-heading"
        description="Preview an image-reference change, apply it on its reviewed branch, validate a candidate, then confirm activation separately."
        className="[&_h2]:text-lg"
      />

      {error ? (
        <ErrorState title="Maintenance action failed" description={error} />
      ) : null}

      {projects.length === 0 ? (
        <EmptyState title="No registered projects" description="Register a project before reviewing an image-reference change." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview an image-reference change</CardTitle>
            <CardDescription>Enter the exact replacement image reference. The local manager validates it before candidate activation.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handlePreview}>
              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="remediation-project">Project</Label>
                  <Select value={project ? `project:${project.id}` : "none"} onValueChange={selectProject} disabled={busy}>
                    <SelectTrigger id="remediation-project">
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Choose a project</SelectItem>
                      {projects.map((item) => <SelectItem key={item.id} value={`project:${item.id}`}>{item.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="remediation-component">Compose component</Label>
                  <Select value={component ? `component:${component.id}` : "none"} onValueChange={selectComponent} disabled={busy || !project || composeComponents.length === 0}>
                    <SelectTrigger id="remediation-component">
                      <SelectValue placeholder="Choose a Compose component" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Choose a component</SelectItem>
                      {composeComponents.map((item) => <SelectItem key={item.id} value={`component:${item.id}`}>{item.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {project && composeComponents.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">This project has no registered Compose component.</p> : null}
                </div>

                <div className="min-w-0 space-y-2 sm:col-span-2">
                  <Label htmlFor="remediation-file">Mapped source file</Label>
                  <Input
                    id="remediation-file"
                    value={file}
                    placeholder="docker/Dockerfile"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !component}
                    aria-invalid={Boolean(trimmedFile && !pathIsRelative)}
                    onChange={(event) => setFile(event.currentTarget.value)}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">Enter a relative path already mapped in local project configuration. Absolute paths and parent-directory segments are rejected here.</p>
                  {trimmedFile && !pathIsRelative ? <p role="alert" className="text-xs text-destructive">Enter a valid relative source path.</p> : null}
                </div>

                <div className="min-w-0 space-y-2 sm:col-span-2">
                  <Label htmlFor="remediation-replacement">Replacement image reference</Label>
                  <Input
                    id="remediation-replacement"
                    value={replacement}
                    placeholder="registry.example/team/service:version"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !component}
                    required
                    onChange={(event) => setReplacement(event.currentTarget.value)}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">DevHub checks this reference against the configured source before creating a change.</p>
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="remediation-service">Compose service (optional)</Label>
                  <Select
                    value={selectedService ? `service:${selectedService}` : "none"}
                    onValueChange={(value) => setService(value.startsWith("service:") ? value.slice("service:".length) : "")}
                    disabled={busy || !component || services.length === 0}
                  >
                    <SelectTrigger id="remediation-service">
                      <SelectValue placeholder="Use mapped source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Use mapped source</SelectItem>
                      {services.map((item) => <SelectItem key={item} value={`service:${item}`}>{item}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="remediation-stage">Build stage (optional)</Label>
                  <Input
                    id="remediation-stage"
                    value={stage}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !component}
                    onChange={(event) => setStage(event.currentTarget.value)}
                  />
                </div>
              </div>

              <Button type="submit" disabled={!input || busy}>
                {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <FileCode2 aria-hidden="true" />}
                Preview image change
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="change-records-heading">
        <div>
          <h3 id="change-records-heading" className="text-sm font-semibold">Source change records</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Each step stays explicit. A scan result alone does not prove a source change is fixed.</p>
        </div>

        {changes.length === 0 ? (
          <EmptyState title="No source changes" description="Preview a supported image-reference change to create a review record." className="min-h-36" />
        ) : (
          <div className="max-w-xl space-y-2">
            <Label htmlFor="remediation-change">Select a change record</Label>
            <Select
              value={selectedChangeId ? `change:${selectedChangeId}` : "none"}
              onValueChange={(value) => onSelectChange(value.startsWith("change:") ? value.slice("change:".length) : undefined)}
              disabled={busy}
            >
              <SelectTrigger id="remediation-change">
                <SelectValue placeholder="Choose a change record" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Choose a change record</SelectItem>
                {changes
                  .slice()
                  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
                  .map((item) => (
                    <SelectItem key={item.id} value={`change:${item.id}`}>
                      {item.state} · {item.file} · {item.projectId}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {change ? (
          <Card className="min-w-0">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <CardTitle className="break-all text-sm">{change.file}</CardTitle>
                <CardDescription className="break-all">Project {change.projectId} · Component {change.componentId}</CardDescription>
              </div>
              <Badge variant={changeStateVariant(change.state)}>{changeStateLabel(change.state)}</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid min-w-0 grid-cols-1 gap-3 rounded-md bg-muted/60 p-3 text-xs sm:grid-cols-2">
                <div className="min-w-0"><dt className="text-muted-foreground">Source branch</dt><dd className="mt-1 break-all font-mono">{change.branch ?? "Not created"}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">Candidate image ID</dt><dd className="mt-1 break-all font-mono">{change.imageId ?? "Not available"}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">Associated scan ID</dt><dd className="mt-1 break-all font-mono">{change.scanId ?? "Not available"}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">Created</dt><dd className="mt-1">{formatDateTime(change.createdAt)}</dd></div>
              </dl>

              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2" aria-label={`Image operand change on line ${change.changedLine.line}`}>
                <div className="min-w-0 rounded-md border border-border bg-muted/50 p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Before, line {change.changedLine.line}</p>
                  <code className="block break-all text-xs leading-5">{change.changedLine.before}</code>
                </div>
                <div className="min-w-0 rounded-md border border-border bg-muted/50 p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">After</p>
                  <code className="block break-all text-xs leading-5">{change.changedLine.after}</code>
                </div>
              </div>

              {change.state === "failed" ? (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>Change workflow failed</AlertTitle>
                  <AlertDescription className="break-words">{change.error ?? "The local validation step did not complete."}</AlertDescription>
                </Alert>
              ) : null}

              {change.state === "preview" ? (
                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs leading-5 text-muted-foreground">
                    {freshPreview ? "This preview matches the current form selection." : "Preview this exact form selection before applying."}
                  </p>
                  <Button type="button" disabled={!canApply} onClick={() => onApply(change.id)}>
                    {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <FileCode2 aria-hidden="true" />}
                    Apply reviewed change
                  </Button>
                </div>
              ) : null}

              {change.state === "applied" ? (
                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs leading-5 text-muted-foreground">Validation is a separate step and must succeed before activation is available.</p>
                  <Button type="button" disabled={!canValidate} onClick={() => onValidate(change.id)}>
                    {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <SearchCheck aria-hidden="true" />}
                    Validate candidate
                  </Button>
                </div>
              ) : null}

              {change.state === "validated" ? (
                <div className="space-y-3 border-t border-border pt-4">
                  {change.imageId ? (
                    <p className="break-words text-sm text-muted-foreground">Candidate validation completed for image <code className="break-all text-foreground">{change.imageId}</code>. Activation still requires separate confirmation.</p>
                  ) : (
                    <p role="status" className="text-sm text-muted-foreground">The change is marked validated, but no candidate image ID is available. Activation is disabled.</p>
                  )}
                  <Button type="button" disabled={!canActivate} onClick={() => setConfirmingChangeId(change.id)}>
                    <BadgeCheck aria-hidden="true" />
                    Review activation
                  </Button>
                </div>
              ) : null}

              {change.state === "activated" ? (
                <p role="status" className="border-t border-border pt-4 text-sm text-muted-foreground">This change is recorded as activated.</p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </section>

      <Dialog open={Boolean(confirmingChangeId)} onOpenChange={(open) => { if (!open) setConfirmingChangeId(undefined); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm candidate activation</DialogTitle>
          <DialogDescription className="break-all">
              {confirmationChange?.imageId
                ? `Activate the validated candidate image ${confirmationChange.imageId} for project ${confirmationChange.projectId}? This is a separate action from validation.`
                : "The selected change no longer has a validated candidate image available."}
            </DialogDescription>
          </DialogHeader>
          {confirmationChange ? (
            <div className="space-y-1 rounded-md bg-muted/60 p-3 text-xs">
              <p className="break-all"><span className="text-muted-foreground">Project:</span> {confirmationChange.projectId}</p>
              <p className="break-all"><span className="text-muted-foreground">Component:</span> {confirmationChange.componentId}</p>
              <p className="break-all"><span className="text-muted-foreground">Source file:</span> {confirmationChange.file}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmingChangeId(undefined)}>Cancel</Button>
            <Button type="button" disabled={!confirmationAllowed} onClick={confirmActivation}>
              {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <ShieldAlert aria-hidden="true" />}
              Confirm activation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
