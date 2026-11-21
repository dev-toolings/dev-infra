import { t } from "../../lib/i18n";
import * as React from "react";
import { FolderGit2, LoaderCircle, Trash2 } from "lucide-react";
import type { ProjectStatus, PublicProject } from "../../../../../src/contracts";
import { errorMessage, isAbortError } from "../../lib/api";
import { plainClick, routePath } from "../../lib/router";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState, ErrorState } from "../ui/state";
import { ProjectListSkeleton } from "./skeletons";
import { ProjectMark, StateBadge, formatDateTime, projectState, safeHttpUrl } from "./shared";

export interface ProjectListProps {
  projects: PublicProject[];
  /** One entry per project; a project whose status could not be read has none. */
  statuses?: (ProjectStatus | undefined)[];
  statusLoading?: boolean;
  loading?: boolean;
  error?: string;
  /** Shown in the empty state; the page header holds them otherwise. */
  actions?: React.ReactNode;
  onSelect: (projectId: string) => void | Promise<void>;
  onRemove: (projectId: string) => Promise<void>;
}

export function ProjectList({ projects, statuses, statusLoading = false, loading = false, error, actions, onSelect, onRemove }: ProjectListProps) {
  const [removing, setRemoving] = React.useState<PublicProject>();
  const [busy, setBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string>();
  /** The dialog is mounted apart from its button: focus goes back to it, or to the list once its card is gone. */
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const list = React.useRef<HTMLElement>(null);

  function closeDialog() {
    setRemoving(undefined);
    setRemoveError(undefined);
  }

  async function confirmRemoval(project: PublicProject) {
    setBusy(true);
    setRemoveError(undefined);
    try {
      await onRemove(project.id);
      closeDialog();
    } catch (caught) {
      if (isAbortError(caught)) return;
      setRemoveError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section ref={list} tabIndex={-1} aria-label={t("Projects")} className="outline-none">
      {error ? <ErrorState description={error} /> : loading ? <ProjectListSkeleton /> : null}

      {!error && !loading && projects.length === 0 ? (
        <EmptyState
          title={t("No projects registered")}
          description={t("Create a project, or add an existing folder, to see its components and status here.")}
          icon={<FolderGit2 aria-hidden="true" className="size-5" />}
          action={actions}
        />
      ) : null}

      {!error && !loading && projects.length > 0 ? (
        <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 min-[110rem]:grid-cols-4">
          {[...projects].sort((a, b) => a.id.localeCompare(b.id)).map((project) => {
            const address = project.components.map((component) => safeHttpUrl(component.url)).find(Boolean)?.replace(/^https?:\/\//, "").replace(/\/$/, "");
            const status = statuses?.find((item) => item?.projectId === project.id);
            return (
              <li key={project.id} className="relative min-w-0">
                <a
                  href={routePath({ view: "projects", projectId: project.id })}
                  onClick={(event) => plainClick(event, () => onSelect(project.id))}
                  className="flex h-full min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-3">
                      <ProjectMark name={project.name} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{project.name}</span>
                        {address ? <span className="block truncate font-mono text-xs text-muted-foreground">{address}</span> : null}
                      </span>
                    </span>
                    {project.components.length > 0 ? <StateBadge state={projectState(project, status)} loading={statusLoading} /> : null}
                  </span>
                  <code className="block w-full truncate text-xs leading-5 text-muted-foreground" title={project.root}>{project.root}</code>
                  <span className="mt-auto flex flex-wrap items-center justify-between gap-x-3 pr-7 text-xs text-muted-foreground">
                    <span>{project.components.length === 1 ? t("1 component") : t("{count} components", { count: project.components.length })}</span>
                    <span>{t("Added {date}", { date: formatDateTime(project.createdAt) })}</span>
                  </span>
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-2.5 bottom-2.5 text-muted-foreground hover:text-destructive"
                  aria-label={t("Remove {name}", { name: project.name })}
                  title={t("Remove {name}", { name: project.name })}
                  onClick={(event) => { trigger.current = event.currentTarget; setRemoving(project); }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {removing ? (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) closeDialog(); }}>
          <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); (trigger.current?.isConnected ? trigger.current : list.current)?.focus(); }}>
            <DialogHeader>
              <DialogTitle className="break-words">{t("Remove {name} from DevHub?", { name: removing.name })}</DialogTitle>
              <DialogDescription>
                {t("The project leaves this list and its operation history is deleted. Its files stay on disk and its services keep running.")}
              </DialogDescription>
            </DialogHeader>
            <code className="block break-all rounded-md bg-muted/60 p-3 text-xs">{removing.root}</code>
            {removeError ? (
              <Alert variant="destructive">
                <AlertTitle>{t("The project could not be removed")}</AlertTitle>
                <AlertDescription>{removeError}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={closeDialog}>{t("Cancel")}</Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => confirmRemoval(removing)}>
                {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Trash2 aria-hidden="true" />}
                {t("Remove")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
