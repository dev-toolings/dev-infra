import { t } from "../../lib/i18n";
import * as React from "react";
import { FolderGit2, LoaderCircle, Trash2 } from "lucide-react";
import type { ProjectStatus, PublicProject } from "../../../../../src/contracts";
import { ApiRequestError, errorMessage, isAbortError } from "../../lib/api";
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
  /** Stops a worktree and removes its containers, folder and database; `force` also drops uncommitted work. */
  onRemoveWorktree: (worktreeId: string, force: boolean) => Promise<void>;
}

export function ProjectList({ projects, statuses, statusLoading = false, loading = false, error, actions, onSelect, onRemove, onRemoveWorktree }: ProjectListProps) {
  const [removing, setRemoving] = React.useState<PublicProject>();
  const [busy, setBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string>();
  /** The server refused a worktree with work Git would delete: the next try may force it. */
  const [canForce, setCanForce] = React.useState(false);

  function closeDialog() {
    setRemoving(undefined);
    setRemoveError(undefined);
    setCanForce(false);
  }

  async function confirmRemoval(project: PublicProject, force = false) {
    setBusy(true);
    setRemoveError(undefined);
    try {
      if (project.worktree) await onRemoveWorktree(project.id, force);
      else await onRemove(project.id);
      closeDialog();
    } catch (caught) {
      if (isAbortError(caught)) return;
      setRemoveError(errorMessage(caught));
      setCanForce(!!project.worktree && caught instanceof ApiRequestError && caught.code === "dirty_worktree");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t("Projects")}>
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
          {/* A worktree follows the project it was checked out from. */}
          {[...projects].sort((a, b) => (a.worktree?.parent ?? a.id).localeCompare(b.worktree?.parent ?? b.id) || Number(!!a.worktree) - Number(!!b.worktree)).map((project) => {
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
                  {project.worktree ? <span className="truncate text-xs text-muted-foreground">{t("Worktree of {parent}, branch {branch}", { parent: project.worktree.parent, branch: project.worktree.branch })}</span> : null}
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
                  onClick={() => setRemoving(project)}
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="break-words">{removing.worktree ? t("Delete the worktree {name}?", { name: removing.name }) : t("Remove {name} from DevHub?", { name: removing.name })}</DialogTitle>
              <DialogDescription>
                {removing.worktree
                  ? t("DevHub stops the worktree, removes its containers, its folder and its database copy. The branch {branch} and its commits stay, as does the dependencies volume.", { branch: removing.worktree.branch })
                  : t("The project leaves this list and its operation history is deleted. Its files stay on disk and its services keep running.")}
              </DialogDescription>
            </DialogHeader>
            <code className="block break-all rounded-md bg-muted/60 p-3 text-xs">{removing.root}</code>
            {removeError ? (
              <Alert variant="destructive">
                <AlertTitle>{removing.worktree ? t("The worktree could not be removed") : t("The project could not be removed")}</AlertTitle>
                <AlertDescription>{removeError}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={closeDialog}>{t("Cancel")}</Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => confirmRemoval(removing, canForce)}>
                {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Trash2 aria-hidden="true" />}
                {canForce ? t("Remove and lose this work") : t("Remove")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
