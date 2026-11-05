import { t } from "../../lib/i18n";
import * as React from "react";
import { Box, Check, Code, Eye, FolderPlus, Laptop, Pencil, Play, X } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import type { CreateDraft, CreateInput, CreateMode, CreatePlan, DockerCustom, Operation, PublicProject, StackChoice, StackDefinition, StackOption, VersionReport } from "../../../../../src/contracts";
import { createNewProject, errorMessage, getVersions, isAbortError, listRoots, listStacks, previewCreation } from "../../lib/api";
import type { Lifetime } from "../../lib/use-lifetime";
import { useResource } from "../../lib/use-resource";
import { translate } from "../../lib/i18n";
import { CodeBlock, languageOf } from "../code-block";
import { ErrorToast } from "../error-toast";
import { FileTree } from "../file-tree";
import { MarkdownView } from "../markdown-view";
import { ServiceIcon } from "../service-icon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ErrorState } from "../ui/state";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { FolderPicker } from "./folder-picker";
import { CreateProjectSkeleton } from "./skeletons";

const MODES: { id: CreateMode; label: string; description: string; icon: typeof Box }[] = [
  { id: "docker", label: t("Docker"), description: t("Isolated container, only the project mounted."), icon: Box },
  { id: "native", label: t("Native"), description: t("Runs on this machine as your user."), icon: Laptop },
];

export interface CreateProjectViewProps {
  lifetime: Lifetime;
  onCancel: () => void;
  onCreated: (project: PublicProject, operation: Operation) => void;
}

type Step = "project" | "services" | "docker" | "create";
const STEPS: { id: Step; label: string }[] = [
  { id: "project", label: t("Stack and project") },
  { id: "services", label: t("Services") },
  { id: "docker", label: t("Docker") },
  { id: "create", label: t("Create") },
];

/** The project as it will be written: pick a file in the tree to read it, and edit its instructions for agents. */
function FilesView({ plan, edits, editable, busy, selected, view, onSelect, onView, onEdit }: { plan: CreatePlan; edits: Record<string, string>; editable: boolean; busy: boolean; selected?: string; view: string; onSelect: (file: string) => void; onView: (view: string) => void; onEdit: (file: string, text?: string) => void }) {
  const content = selected === undefined ? undefined : edits[selected] ?? plan.generatedInstructions[selected] ?? plan.contents[selected];
  const markdown = content !== undefined && languageOf(selected!) === "markdown";
  const instructions = selected === "AGENTS.md";
  const shown = view === "edit" && !(instructions && editable) ? "preview" : view;
  return (
    <>
      <div className="flex min-h-13 items-center justify-between gap-3 border-b px-4 py-2 md:px-5">
        <h2 className="truncate font-mono text-sm font-semibold">{plan.id}/{content === undefined ? "" : selected}</h2>
        <div className="flex shrink-0 items-center gap-3">
          {selected !== undefined && edits[selected] !== undefined ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onEdit(selected)}>{t("Restore the generated file")}</Button> : null}
          {markdown && <Segmented label={t("File view")} value={shown} onChange={onView} items={[
            { value: "preview", label: t("Preview"), icon: <Eye className="size-3.5" aria-hidden /> },
            { value: "code", label: t("Code"), icon: <Code className="size-3.5" aria-hidden /> },
            ...(instructions ? [{ value: "edit", label: t("Edit"), icon: <Pencil className="size-3.5" aria-hidden />, disabled: !editable, title: editable ? undefined : t("Name the project and choose its folder to edit this file.") }] : []),
          ]} />}
          <span className="text-xs text-muted-foreground">{t("{count} files", { count: plan.files.length })}</span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)]">
        <div className="scrollbar-soft min-w-0 overflow-auto border-b p-4 md:border-r md:border-b-0"><FileTree files={plan.files} selected={selected} onSelect={onSelect} /></div>
        {/* Keyed: each file opens at its top. */}
        <div key={selected} className="scrollbar-soft min-w-0 xl:min-h-0 xl:overflow-auto">
          {content === undefined
            ? <p className="p-4 text-xs text-muted-foreground">{t("Select a file to see its content.")}</p>
            : shown === "edit"
              ? <Textarea aria-label={selected} spellCheck={false} readOnly={busy} value={content} onChange={(event) => onEdit(selected!, event.target.value)} className="scrollbar-soft h-full min-h-80 resize-none rounded-none border-0 p-4 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0 md:px-5" />
              : markdown && shown === "preview"
                ? <MarkdownView>{content}</MarkdownView>
                : <CodeBlock language={languageOf(selected!)}>{content || " "}</CodeBlock>}
        </div>
      </div>
    </>
  );
}

/** Stands in for the plan while it loads or failed. */
function PlanState({ error, onRetry }: { error?: string; onRetry: () => void }) {
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        {error}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>{t("Try again")}</Button>
      </div>
    );
  }
  return (
    <div role="status" aria-label={t("Loading summary")} className="space-y-2">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}

/** Names typed one at a time: each becomes a removable chip. */
function NameList({ id, label, items, disabled, onChange }: { id: string; label: string; items: string[]; disabled?: boolean; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = React.useState("");
  const add = () => {
    const next = draft.trim();
    if (next && !items.includes(next)) onChange([...items, next]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="font-mono"
          value={draft}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
        />
        <Button type="button" variant="outline" disabled={disabled || !draft.trim()} onClick={add}>{t("Add")}</Button>
      </div>
      {items.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item}>
              <Badge variant="outline" className="font-mono">
                {item}
                <button type="button" aria-label={t("Remove {name}", { name: item })} disabled={disabled} className="ml-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onChange(items.filter((other) => other !== item))}>
                  <X aria-hidden="true" className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Each component with its release lines. Support dates and CVEs come from the last `devhub versions` report. */
function VersionTable({ options, values, report, onChange }: { options: StackOption[]; values: Record<string, string>; report?: VersionReport; onChange: (id: string, value: string) => void }) {
  const radio = (option: StackOption, choice: StackChoice) => (
    <label key={choice.value} className="inline-flex items-center gap-1.5 font-mono text-xs">
      <input type="radio" name={`create-${option.id}`} className="size-3.5 appearance-none rounded-full border border-muted-foreground transition-[border-width] checked:border-4 checked:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" checked={values[option.id] === choice.value} onChange={() => onChange(option.id, choice.value)} />
      {choice.label}
    </label>
  );
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>{t("Component")}</TableHead>
              <TableHead>LTS</TableHead>
              <TableHead>{t("Latest")}</TableHead>
              <TableHead>{t("Other")}</TableHead>
              <TableHead>{t("End of support")}</TableHead>
              <TableHead className="text-right">CVE</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {options.map((option) => {
              const selected = option.choices.find((choice) => choice.value === values[option.id]);
              const item = report?.items.find(({ name, version }) => name === selected?.check?.name && version === selected?.check?.version);
              return (
                <TableRow key={option.id}>
                  <TableCell className="font-medium">{translate(option.label)}</TableCell>
                  <TableCell>{option.choices.filter((choice) => choice.tag === "lts").map((choice) => radio(option, choice))}</TableCell>
                  <TableCell>{option.choices.filter((choice) => choice.tag === "latest").map((choice) => radio(option, choice))}</TableCell>
                  <TableCell><span className="flex gap-3">{option.choices.filter((choice) => !choice.tag).map((choice) => radio(option, choice))}</span></TableCell>
                  <TableCell className="text-xs">{item?.state === "eol" ? <Badge variant="down">{t("End of life")}</Badge> : item?.eol}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{item?.vulns.length}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {!report ? <p className="text-xs text-muted-foreground">{t("Run a check under Maintenance, Versions to see support dates and CVEs here.")}</p> : null}
    </div>
  );
}

/** A choice between a few values, all visible: the selected one stands out by surface and weight, never by color. */
function Segmented({ label, value, onChange, items }: { label: string; value: string; onChange: (value: string) => void; items: { value: string; label: string; icon: React.ReactNode; disabled?: boolean; title?: string }[] }) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => { if (next) onChange(next); }}
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-muted p-1"
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          title={item.title}
          className="flex min-h-7 min-w-0 items-center justify-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-xs"
        >
          {item.icon}
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

function SwitchRow({ id, label, icon, checked, disabled, onChange, children }: { id: string; label: string; icon?: React.ReactNode; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      {icon}
      <Label htmlFor={id} className="min-w-0 flex-1">{label}</Label>
      {children}
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function CreateProjectView({ lifetime, onCancel, onCreated }: CreateProjectViewProps) {
  const stacks = useResource(listStacks, "stacks");
  const roots = useResource(listRoots, "create-roots");
  const report = useResource(getVersions, "create-versions");
  const [stackId, setStackId] = React.useState<string>();
  const [mode, setMode] = React.useState<CreateMode>("docker");
  const [name, setName] = React.useState("");
  const [rootId, setRootId] = React.useState<string>();
  const [pickingRoot, setPickingRoot] = React.useState(false);
  const [choices, setChoices] = React.useState<Record<string, string>>({});
  const [services, setServices] = React.useState<string[]>([]);
  const [versions, setVersions] = React.useState<Record<string, string>>({});
  const [git, setGit] = React.useState(true);
  const [step, setStep] = React.useState<Step>("project");
  const [image, setImage] = React.useState("");
  const [packages, setPackages] = React.useState<string[]>([]);
  const [extensions, setExtensions] = React.useState<string[]>([]);
  const [dockerfile, setDockerfile] = React.useState<string>();
  const [instructions, setInstructions] = React.useState<Record<string, string>>({});
  /** Held here because the files view unmounts with its tab and with a change of mode. */
  const [selectedFile, setSelectedFile] = React.useState<string>();
  const [fileView, setFileView] = React.useState("preview");
  const [preview, setPreview] = React.useState<{ key: string; plan?: CreatePlan; error?: string }>();
  const [attempt, setAttempt] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [failures, setFailures] = React.useState(0);

  const stack: StackDefinition | undefined = stacks.data?.find((item) => item.id === stackId) ?? stacks.data?.[0];
  const rootList = roots.data ?? [];
  const root = rootList.find((item) => item.id === rootId) ?? rootList[0];
  /** Same rule as the server: options come in dependency order, and some apply only to an image or to another choice. */
  const options: Record<string, string> = {};
  const activeOptions: StackOption[] = [];
  for (const option of stack?.options ?? []) {
    if ((option.when && options[option.when.option] !== option.when.value) || (option.docker && mode !== "docker")) continue;
    options[option.id] = choices[option.id] ?? option.default;
    activeOptions.push(option);
  }
  /** Some choices bring a service with them: the form shows it on, and the server applies the same rule. */
  const required = (stack?.options ?? []).flatMap((option) => option.choices.find((choice) => choice.value === options[option.id])?.services ?? []);
  const fields: DockerCustom = { ...(image.trim() ? { image: image.trim() } : {}), ...(packages.length ? { packages } : {}), ...(extensions.length ? { extensions } : {}) };
  const custom: DockerCustom | undefined = mode !== "docker" ? undefined : dockerfile !== undefined ? { dockerfile } : Object.keys(fields).length ? fields : undefined;
  const form = stack ? { stack: stack.id, mode, options, services, versions, ...(custom ? { docker: custom } : {}), ...(Object.keys(instructions).length ? { instructions } : {}), git } : undefined;
  const input: CreateInput | undefined = form && root && name.trim() ? { ...form, name: name.trim(), rootId: root.id } : undefined;

  /** Until the form names a project, the preview is a draft of the same choices: it shows the files but cannot be created. */
  const inputKey = form ? JSON.stringify(input ?? { ...form, rootId: root?.id }) : undefined;
  const current = preview?.key === inputKey ? preview : undefined;
  const plan = input ? current?.plan : undefined;
  const previewError = current?.error;
  /** The files stay on screen while the next plan loads, so an open editor keeps its focus. */
  const lastPlan = React.useRef<CreatePlan>(undefined);
  if (current?.plan) lastPlan.current = current.plan;
  const shownPlan = lastPlan.current;
  const shownDocker = mode === "docker" ? shownPlan?.docker : undefined;

  /** The summary is always the server's plan for the exact form, so creation follows a preview without a separate step. */
  React.useEffect(() => {
    if (!inputKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewCreation(JSON.parse(inputKey) as CreateInput | CreateDraft, controller.signal)
        .then((next) => setPreview({ key: inputKey, plan: next }))
        .catch((caught: unknown) => { if (!isAbortError(caught)) setPreview({ key: inputKey, error: errorMessage(caught) }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [inputKey, attempt]);

  /** A plan only counts for the form it was made from, so creation stays disabled until the new one arrives. */
  function changed<T>(apply: (value: T) => void) {
    return (value: T) => { apply(value); setError(undefined); };
  }

  function editInstructions(file: string, text?: string) {
    const { [file]: _replaced, ...others } = instructions;
    changed(setInstructions)(text === undefined ? others : { ...others, [file]: text });
  }

  async function task(work: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime();
    if (!signal || busy) return;
    setBusy(true);
    setError(undefined);
    try { await work(signal); }
    catch (caught) { if (!isAbortError(caught)) { setError(errorMessage(caught)); setFailures((count) => count + 1); } }
    finally { if (!signal.aborted) setBusy(false); }
  }

  if (stacks.error || roots.error) return <ErrorState description={stacks.error ?? roots.error ?? ""} />;
  if (stacks.loading || roots.loading || !stack) return <CreateProjectSkeleton />;

  const docker = mode === "docker";
  const steps = STEPS.filter((item) => docker || item.id !== "docker");
  const position = steps.findIndex((item) => item.id === step);
  const plainOptions = activeOptions.filter((option) => option.kind !== "version");
  const versionOptions = activeOptions.filter((option) => option.kind === "version");
  const defaultImage = /^\s*FROM\s+(\S+)/im.exec(plan?.docker?.dockerfile ?? "")?.[1];
  /** These files carry the project name and the stack, so the text to edit has to come from a plan of this very project. */
  const editable = shownPlan?.input.name === input?.name && shownPlan?.input.stack === input?.stack;
  const filesView = shownPlan ? <FilesView plan={shownPlan} edits={instructions} editable={editable} busy={busy} selected={selectedFile} view={fileView} onSelect={setSelectedFile} onView={setFileView} onEdit={editInstructions} /> : null;

  return (
    <div className="grid w-full min-w-0 flex-1 gap-4 xl:min-h-0 xl:grid-cols-[minmax(28rem,36rem)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)]">
      {error ? <ErrorToast key={failures} title={t("Project could not be created")} message={error} onDismiss={() => setError(undefined)} /> : null}
      <Card className="scrollbar-soft min-w-0 overflow-hidden xl:min-h-0 xl:overflow-y-auto">
        <nav aria-label={t("Creation steps")} className="border-b px-4 py-3 md:px-5">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {steps.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === step ? "step" : undefined}
                  disabled={index > 0 && !input}
                  onClick={() => setStep(item.id)}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[current=step]:font-medium aria-[current=step]:text-foreground"
                >
                  <span aria-hidden="true" className="grid size-5 place-items-center rounded-full border text-xs tabular-nums">
                    {index < position ? <Check className="size-3" /> : index + 1}
                  </span>
                  {item.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex-1 space-y-4 p-4 md:p-5">
          {step === "project" ? (
            <>
              <ToggleGroup.Root
                type="single"
                aria-label={t("Stack")}
                value={stack.id}
                onValueChange={(next) => {
                  if (!next) return;
                  // Modes, options, services and image changes belong to a stack: nothing carries over to the next one.
                  changed(setStackId)(next);
                  setMode(stacks.data?.find((item) => item.id === next)?.modes[0] ?? "docker");
                  setChoices({});
                  setServices([]);
                  setVersions({});
                  setImage("");
                  setPackages([]);
                  setExtensions([]);
                  setDockerfile(undefined);
                }}
                className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2"
              >
                {(stacks.data ?? []).map((item) => (
                  <ToggleGroup.Item
                    key={item.id}
                    value={item.id}
                    className="flex h-20 flex-col items-center justify-center gap-2 rounded-lg border border-input text-sm font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:border-foreground data-[state=on]:bg-muted"
                  >
                    <ServiceIcon name={item.id} className="size-6" />
                    {item.name}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>
              <p className="text-xs text-muted-foreground">{translate(stack.description)}</p>
              <Segmented
                label={t("Mode")}
                value={mode}
                onChange={(next) => { changed(setMode)(next as CreateMode); }}
                items={MODES.filter((item) => stack.modes.includes(item.id)).map(({ id, label, icon: Icon }) => ({ value: id, label, icon: <Icon aria-hidden="true" className="size-4 shrink-0" /> }))}
              />
              <p className="text-xs text-muted-foreground">{MODES.find((item) => item.id === mode)?.description}</p>
              {plainOptions.map((option) => (
                <div key={option.id} className="grid gap-1.5 sm:grid-cols-[10.5rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                  <span id={`create-${option.id}`} className="text-sm font-medium">{translate(option.label)}</span>
                  {option.choices.length === 1 ? (
                    <div role="group" aria-labelledby={`create-${option.id}`} className="flex min-h-8 items-center gap-2 text-sm">
                      <ServiceIcon name={option.choices[0]!.value} />
                      {translate(option.choices[0]!.label)}
                    </div>
                  ) : (
                    <Segmented
                      label={translate(option.label)}
                      value={options[option.id] ?? option.default}
                      onChange={(value) => changed(setChoices)({ ...choices, [option.id]: value })}
                      items={option.choices.map((choice) => ({ value: choice.value, label: translate(choice.label), icon: <ServiceIcon name={choice.value} /> }))}
                    />
                  )}
                </div>
              ))}
              {versionOptions.length > 0 ? (
                <VersionTable
                  options={versionOptions}
                  values={options}
                  report={report.data ?? undefined}
                  onChange={(id, value) => changed(setChoices)({ ...choices, [id]: value })}
                />
              ) : null}
              {!docker ? <p className="text-xs text-muted-foreground">{t("On this machine, the installed runtime is used.")}</p> : null}
              {dockerfile !== undefined ? <p className="text-xs text-muted-foreground">{t("Your edited Dockerfile stays as it is: the choices above do not change it.")}</p> : null}
              {Object.keys(instructions).length > 0 ? <p className="text-xs text-muted-foreground">{t("Your edited agent instructions stay as they are: the choices and the name of the project do not change them.")}</p> : null}
              <div className="space-y-1.5">
                <Label htmlFor="create-name">{t("Project name")}</Label>
                <Input id="create-name" value={name} autoComplete="off" onChange={(event) => changed(setName)(event.target.value)} />
                <p className="text-xs text-muted-foreground">{t("The project is created in a new folder named after it.")}</p>
              </div>
              {rootList.length > 0 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="create-root">{t("Parent folder")}</Label>
                  <Select value={root?.id} onValueChange={changed(setRootId)}>
                    <SelectTrigger id="create-root"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {rootList.map((item) => <SelectItem key={item.id} value={item.id}>{item.path}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <Button type="button" variant={rootList.length > 0 ? "ghost" : "outline"} size="sm" className={rootList.length > 0 ? "-ml-2 text-muted-foreground" : undefined} onClick={() => setPickingRoot(true)}>
                <FolderPlus aria-hidden="true" />
                {rootList.length > 0 ? t("Approve another folder") : t("Approve a parent folder")}
              </Button>
              <FolderPicker
                open={pickingRoot}
                roots={rootList}
                onOpenChange={setPickingRoot}
                onPicked={(picked) => {
                  roots.update((current = []) => current.some((item) => item.id === picked.id) ? current : [...current, picked]);
                  changed(setRootId)(picked.id);
                  setPickingRoot(false);
                }}
              />
              <SwitchRow id="create-git" label={t("Initialize a Git repository")} checked={git} onChange={changed(setGit)} />
            </>
          ) : null}

          {step === "services" ? (
            <>
              <p className="text-xs text-muted-foreground">{t("Projects on the same version share one instance. Another version gets its own, with its own volume and port.")}</p>
              {stack.services.map((service) => {
                const on = services.includes(service.id) || required.includes(service.id);
                return (
                  <SwitchRow
                    key={service.id}
                    id={`create-service-${service.id}`}
                    label={service.name}
                    icon={<ServiceIcon name={service.id} className="text-muted-foreground" />}
                    checked={on}
                    disabled={required.includes(service.id)}
                    onChange={(next) => changed(setServices)(next ? [...services, service.id] : services.filter((item) => item !== service.id))}
                  >
                    {service.versions.length > 1 ? (
                      <Select value={versions[service.id] ?? service.default} disabled={!on} onValueChange={(version) => changed(setVersions)({ ...versions, [service.id]: version })}>
                        <SelectTrigger aria-label={t("Version of {name}", { name: service.name })} className="w-40 font-mono text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {service.versions.map((version) => <SelectItem key={version} value={version}>{version === service.default ? t("{version} (shared)", { version }) : version}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : <span className="w-40 px-2.5 font-mono text-xs text-muted-foreground">{service.default}</span>}
                  </SwitchRow>
                );
              })}
            </>
          ) : null}

          {step === "docker" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="create-image">{t("Base image")}</Label>
                <Input id="create-image" className="font-mono" value={image} placeholder={defaultImage} disabled={dockerfile !== undefined} autoComplete="off" onChange={(event) => changed(setImage)(event.target.value)} />
                <p className="text-xs text-muted-foreground">{t("Leave empty to follow the version you chose.")}</p>
              </div>
              <NameList id="create-packages" label={t("System packages")} items={packages} disabled={dockerfile !== undefined} onChange={changed(setPackages)} />
              {stack.id === "php" ? <NameList id="create-extensions" label={t("PHP extensions")} items={extensions} disabled={dockerfile !== undefined} onChange={changed(setExtensions)} /> : null}
              <SwitchRow
                id="create-edit-dockerfile"
                label={t("Edit the file")}
                checked={dockerfile !== undefined}
                disabled={dockerfile === undefined && !shownDocker}
                onChange={(on) => changed(setDockerfile)(on ? shownDocker?.dockerfile : undefined)}
              />
              <p className="text-xs text-muted-foreground">{t("The Dockerfile is saved at the root of the project. It runs on this machine when the image builds.")}</p>
              {dockerfile !== undefined ? <p className="text-xs text-muted-foreground">{t("Keep the line that creates the folders: the project runs as your user and installs into them.")}</p> : null}
            </>
          ) : null}

          {step === "create" ? (
            plan ? (
              <div className="space-y-3 text-xs">
                <p className="text-muted-foreground">{translate(plan.isolation)}</p>
                <dl className="divide-y">
                  {[[t("Folder"), plan.path], ["URL", plan.url], [t("Install"), plan.install], [t("Dev"), plan.dev], ...(plan.database ? [[t("Database"), plan.database]] : [])].map(([label, value]) => (
                    <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-mono [overflow-wrap:anywhere]">{value}</dd>
                    </div>
                  ))}
                </dl>
                {plan.input.services.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {plan.input.services.map((service) => <Badge key={service} variant="outline"><ServiceIcon name={service} className="size-3" />{stack.services.find((item) => item.id === service)?.name ?? service}</Badge>)}
                  </div>
                ) : null}
              </div>
            ) : <PlanState error={previewError} onRetry={() => setAttempt((count) => count + 1)} />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 md:px-5">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
          <div className="flex flex-wrap gap-2">
            {position > 0 ? <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(steps[position - 1]!.id)}>{t("Back")}</Button> : null}
            {position < steps.length - 1 ? (
              <Button type="button" disabled={!input} onClick={() => setStep(steps[position + 1]!.id)}>{t("Continue")}</Button>
            ) : (
              <Button
                type="button"
                disabled={!plan || busy}
                onClick={() => void task(async (signal) => { const created = await createNewProject(plan!.input, signal); onCreated(created.project, created.operation); })}
              >
                <Play aria-hidden="true" />
                {t("Create and start")}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <aside aria-label={t("Files DevHub will write")} className="min-w-0 xl:min-h-0">
        <Card className="h-full min-w-0 overflow-hidden">
          {shownDocker ? (
            <Tabs defaultValue="dockerfile" className="flex min-h-0 flex-1 flex-col gap-0">
              <div className="border-b px-4 py-2 md:px-5">
                <TabsList aria-label={t("Files DevHub will write")}>
                  <TabsTrigger value="dockerfile">Dockerfile</TabsTrigger>
                  <TabsTrigger value="files">{t("Files")}</TabsTrigger>
                  <TabsTrigger value="compose">compose.yml</TabsTrigger>
                  <TabsTrigger value="env">{t("Variables")}</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="dockerfile" className="scrollbar-soft min-h-0 flex-1 xl:overflow-auto">
                {dockerfile !== undefined ? (
                  <Textarea aria-label="Dockerfile" spellCheck={false} value={dockerfile} onChange={(event) => changed(setDockerfile)(event.target.value)} className="scrollbar-soft h-full min-h-80 resize-none rounded-none border-0 p-4 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0 md:px-5" />
                ) : <CodeBlock language="docker">{shownDocker.dockerfile}</CodeBlock>}
              </TabsContent>
              <TabsContent value="files" className="flex min-h-0 flex-1 flex-col">{filesView}</TabsContent>
              <TabsContent value="compose" className="scrollbar-soft min-h-0 flex-1 xl:overflow-auto"><CodeBlock language="yaml">{shownDocker.compose}</CodeBlock></TabsContent>
              <TabsContent value="env" className="scrollbar-soft min-h-0 flex-1 xl:overflow-auto"><CodeBlock language="properties">{Object.entries(shownDocker.env).map(([key, value]) => `${key}=${value}`).join("\n")}</CodeBlock></TabsContent>
              <div className="space-y-1 border-t px-4 py-2.5 text-xs text-muted-foreground md:px-5">
                {previewError ? <PlanState error={previewError} onRetry={() => setAttempt((count) => count + 1)} /> : null}
                <p>{t("Managed by DevHub, not editable: non-root user, no capabilities, ports on this machine only.")}</p>
                <p>{t("Addresses and passwords of the services are added at creation.")}</p>
              </div>
            </Tabs>
          ) : shownPlan ? (
            <div className="flex min-h-80 flex-1 flex-col xl:min-h-0">
              {filesView}
              {previewError ? <div className="border-t px-4 py-2.5 md:px-5"><PlanState error={previewError} onRetry={() => setAttempt((count) => count + 1)} /></div> : null}
              <dl className="space-y-1 border-t px-4 py-3 text-xs md:px-5">
                {[[t("Install"), shownPlan.install], [t("Dev"), shownPlan.dev]].map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd><CodeBlock language="bash" className="">{value!}</CodeBlock></dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <div className="p-4 md:p-5"><PlanState error={previewError} onRetry={() => setAttempt((count) => count + 1)} /></div>
          )}
        </Card>
      </aside>
    </div>
  );
}
