import { t } from "../../lib/i18n";
import type { ReactNode } from "react";
import { FolderGit2 } from "lucide-react";
import type { ProjectStatus, PublicProject } from "../../../../../src/contracts";
import { plainClick, routePath } from "../../lib/router";
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
  actions?: ReactNode;
  onSelect: (projectId: string) => void | Promise<void>;
}

export function ProjectList({ projects, statuses, statusLoading = false, loading = false, error, actions, onSelect }: ProjectListProps) {
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
              <li key={project.id} className="min-w-0">
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
                  <span className="mt-auto flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
                    <span>{project.components.length === 1 ? t("1 component") : t("{count} components", { count: project.components.length })}</span>
                    <span>{t("Added {date}", { date: formatDateTime(project.createdAt) })}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
