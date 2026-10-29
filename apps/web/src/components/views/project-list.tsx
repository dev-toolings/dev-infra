import { FolderGit2, Plus } from "lucide-react";
import type { PublicProject } from "../../../../../src/contracts";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ViewHeading, formatDateTime } from "./shared";

export interface ProjectListProps {
  projects: PublicProject[];
  selectedProjectId?: string;
  loading?: boolean;
  error?: string;
  onSelect: (projectId: string) => void | Promise<void>;
  onAddProject?: () => void | Promise<void>;
}

export function ProjectList({ projects, selectedProjectId, loading = false, error, onSelect, onAddProject }: ProjectListProps) {
  return (
    <section className="space-y-4" aria-labelledby="projects-heading">
      <ViewHeading
        title="Projects"
        titleId="projects-heading"
        description="Choose a registered project to inspect its components and recent operations."
        className="[&_h2]:text-lg"
        action={onAddProject && projects.length > 0 ? (
          <Button type="button" onClick={onAddProject}>
            <Plus aria-hidden="true" />
            Add project
          </Button>
        ) : undefined}
      />
      {error ? <ErrorState description={error} /> : loading ? <LoadingState label="Loading projects" rows={4} /> : null}

      {!error && !loading && projects.length === 0 ? (
        <EmptyState
          title="No projects registered"
          description="Add an existing project folder to see its components and status here."
          icon={<FolderGit2 aria-hidden="true" className="size-5" />}
          action={onAddProject ? <Button type="button" onClick={onAddProject}><Plus aria-hidden="true" />Add project</Button> : undefined}
        />
      ) : null}

      {!error && !loading && projects.length > 0 ? (
        <ul className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
          {projects.map((project) => {
            const selected = project.id === selectedProjectId;
            return (
              <li key={project.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(project.id)}
                  className={cn(
                    "flex min-h-28 w-full min-w-0 flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    selected ? "border-primary/60 bg-primary/5" : "border-border",
                  )}
                >
                  <span className="flex w-full min-w-0 items-start justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-primary" />
                      <span className="truncate font-medium">{project.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {project.components.length} {project.components.length === 1 ? "component" : "components"}
                    </span>
                  </span>
                  <code className="block w-full break-all text-xs leading-5 text-muted-foreground">{project.root}</code>
                  <span className="text-xs text-muted-foreground">Added {formatDateTime(project.createdAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
