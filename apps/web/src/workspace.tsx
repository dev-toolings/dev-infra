import * as React from "react";
import { getProjectStatus, listContainers, listProjects } from "./lib/api";
import { useAddProject } from "./lib/use-add-project";
import { useLifecycle } from "./lib/use-lifecycle";
import { useLifetime } from "./lib/use-lifetime";
import { useLogStream } from "./lib/use-log-stream";
import { useMaintenance } from "./lib/use-maintenance";
import { useResource } from "./lib/use-resource";
import { ActionBanner } from "./components/action-banner";
import { ProjectPicker } from "./components/project-picker";
import { EmptyState } from "./components/ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  AddProjectDialog,
  AppShell,
  ContainersView,
  LogsView,
  ProjectDetail,
  ProjectList,
  RemediationPanel,
  ScansView,
  type AppView,
} from "./components/views";

const STATUS_REFRESH_MS = 8000;
const CONTAINERS_REFRESH_MS = 10_000;

const viewCopy: Record<AppView, { title: string; description: string }> = {
  projects: { title: "Projects", description: "Registered projects, their components and current status." },
  containers: { title: "Containers", description: "Docker containers observed on this machine." },
  logs: { title: "Logs", description: "Live merged output for one project." },
  maintenance: { title: "Maintenance", description: "Image scans and reviewed image reference changes." },
};

export interface WorkspaceProps {
  onLogout: () => void;
}

/**
 * Everything shown after authentication. All data lives in this component's state, so
 * unmounting it on logout or a lost session drops every cached value and aborts every request.
 */
export function Workspace({ onLogout }: WorkspaceProps) {
  const lifetime = useLifetime();
  const [view, setView] = React.useState<AppView>("projects");
  const [chosenProjectId, setChosenProjectId] = React.useState<string>();
  const [logFilter, setLogFilter] = React.useState<{ projectId: string; componentId: string }>();
  const [paused, setPaused] = React.useState(false);

  const projects = useResource(listProjects, "projects");
  const projectList = projects.data ?? [];
  const selected = projectList.find((project) => project.id === chosenProjectId) ?? projectList[0];
  const selectedId = selected?.id;

  const status = useResource(
    (signal) => getProjectStatus(selectedId ?? "", signal),
    selectedId && view === "projects" ? `status:${selectedId}` : undefined,
    { refreshMs: STATUS_REFRESH_MS },
  );
  const containers = useResource(
    listContainers,
    view === "containers" || view === "maintenance" ? "containers" : undefined,
    { refreshMs: view === "containers" ? CONTAINERS_REFRESH_MS : undefined },
  );
  const lifecycle = useLifecycle(lifetime, () => status.reload());
  const maintenance = useMaintenance(lifetime, view === "maintenance");
  const logs = useLogStream(selectedId, view === "logs" && !paused);
  const addProject = useAddProject(lifetime, (project) => {
    projects.update((current) => [...(current ?? []).filter((item) => item.id !== project.id), project]);
    projects.reload();
    setChosenProjectId(project.id);
    setView("projects");
  });

  const componentFilter = logFilter && logFilter.projectId === selectedId ? logFilter.componentId : undefined;
  const lifecycleError = lifecycle.error && lifecycle.error.projectId === selectedId ? lifecycle.error.message : undefined;

  function openProject(projectId: string) {
    setChosenProjectId(projectId);
    setView("projects");
  }

  const picker = projectList.length > 1 ? (
    <ProjectPicker projects={projectList} selectedProjectId={selectedId} onSelect={setChosenProjectId} />
  ) : null;

  return (
    <AppShell
      activeView={view}
      onNavigate={setView}
      title={viewCopy[view].title}
      description={viewCopy[view].description}
      onLogout={onLogout}
    >
      {view === "projects" ? (
        <div className={projectList.length > 0 ? "grid min-w-0 gap-6 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]" : "min-w-0"}>
          <ProjectList
            projects={projectList}
            selectedProjectId={selectedId}
            loading={projects.loading}
            error={projects.error && projectList.length === 0 ? projects.error : undefined}
            compact
            onSelect={setChosenProjectId}
            onAddProject={addProject.requestOpen}
          />
          {selected ? (
            <div className="min-w-0 space-y-3">
              {lifecycleError ? <ActionBanner title="Component action failed" message={lifecycleError} onDismiss={lifecycle.dismissError} /> : null}
              {status.error ? <ActionBanner title="Status could not be refreshed" message={status.error} /> : null}
              <ProjectDetail
                project={selected}
                status={status.data}
                operations={lifecycle.operations}
                busyComponentIds={lifecycle.busyComponentIds(selectedId)}
                onAction={(action, componentIds) => lifecycle.run(selected.id, action, componentIds)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {view === "containers" ? (
        <ContainersView
          containers={containers.data ?? []}
          loading={containers.loading}
          error={containers.error && !containers.data ? containers.error : undefined}
          onSelectProject={openProject}
          onSelectComponent={openProject}
        />
      ) : null}

      {view === "logs" ? (
        <div className="min-w-0 space-y-4">
          {picker}
          {selected ? (
            <>
              {logs.error && logs.entries.length > 0 ? <ActionBanner title="Log stream interrupted" message={logs.error} /> : null}
              <LogsView
                entries={logs.entries}
                componentFilter={componentFilter}
                components={selected.components}
                paused={paused}
                error={logs.entries.length === 0 ? logs.error : undefined}
                onComponentFilterChange={(componentId) => setLogFilter(componentId ? { projectId: selected.id, componentId } : undefined)}
                onPausedChange={setPaused}
                onClear={logs.clear}
              />
            </>
          ) : (
            <EmptyState title="No project selected" description="Register a project to follow its logs here." />
          )}
        </div>
      ) : null}

      {view === "maintenance" ? (
        <div className="min-w-0 space-y-4">
          {maintenance.error ? <ActionBanner title="Maintenance action failed" message={maintenance.error} onDismiss={maintenance.dismissError} /> : null}
          {containers.error ? <ActionBanner title="Container inventory unavailable" message={containers.error} /> : null}
          <Tabs defaultValue="scans">
            <TabsList aria-label="Maintenance sections">
              <TabsTrigger value="scans">Image scans</TabsTrigger>
              <TabsTrigger value="remediation">Source remediation</TabsTrigger>
            </TabsList>
            <TabsContent value="scans">
              <ScansView
                scans={maintenance.scans}
                changes={maintenance.changes}
                containers={containers.data ?? []}
                loading={maintenance.loading}
                busy={maintenance.busy}
                scanningImageId={maintenance.scanningImageId}
                error={maintenance.loadError}
                onScan={maintenance.scan}
              />
            </TabsContent>
            <TabsContent value="remediation">
              <RemediationPanel
                projects={projectList}
                changes={maintenance.changes}
                selectedChangeId={maintenance.selectedChangeId}
                busy={maintenance.busy}
                onSelectChange={maintenance.selectChange}
                onPreview={maintenance.preview}
                onApply={maintenance.apply}
                onValidate={maintenance.validate}
                onActivate={maintenance.activate}
              />
            </TabsContent>
          </Tabs>
        </div>
      ) : null}

      <AddProjectDialog
        open={addProject.open}
        roots={addProject.roots}
        presets={addProject.presets}
        detections={addProject.detections}
        plan={addProject.plan}
        busy={addProject.busy}
        error={addProject.error}
        onDiscover={addProject.onDiscover}
        onPreview={addProject.onPreview}
        onApply={addProject.onApply}
        onOpenChange={addProject.onOpenChange}
      />
    </AppShell>
  );
}
