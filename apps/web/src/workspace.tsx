import { t } from "./lib/i18n";
import * as React from "react";
import { getProjectStatus, listContainers, listProjectOperations, listProjects } from "./lib/api";
import { useAddProject } from "./lib/use-add-project";
import { useLifecycle } from "./lib/use-lifecycle";
import { useLifetime } from "./lib/use-lifetime";
import { useLogStream } from "./lib/use-log-stream";
import { useMaintenance } from "./lib/use-maintenance";
import { useResource } from "./lib/use-resource";
import type { Operation } from "../../../src/contracts";
import { DEFAULT_CONTAINER_STATE, useRoute, type MaintenanceTab } from "./lib/router";
import { ErrorToast } from "./components/error-toast";
import { ProjectPicker } from "./components/project-picker";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Plus } from "lucide-react";
import {
  AddProjectDialog,
  AppShell,
  ContainersView,
  CreateProjectView,
  VersionsView,
  LogsView,
  ProjectBreadcrumb,
  ProjectDetail,
  ProjectDetailSkeleton,
  ProjectList,
  RemediationPanel,
  ScansView,
  type AppView,
} from "./components/views";

const STATUS_REFRESH_MS = 8000;
const CONTAINERS_REFRESH_MS = 10_000;

const viewCopy: Record<AppView, { title: string; description: string }> = {
  projects: { title: t("Projects"), description: t("Registered projects, their components and current status.") },
  containers: { title: t("Containers"), description: t("Docker containers observed on this machine.") },
  logs: { title: t("Logs"), description: t("Live merged output for one project.") },
  maintenance: { title: t("Maintenance"), description: t("Image scans and reviewed image reference changes.") },
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
  const { route, navigate } = useRoute();
  const view = route.view;
  const [logFilter, setLogFilter] = React.useState<{ projectId: string; componentId: string }>();
  const [paused, setPaused] = React.useState(false);

  const projects = useResource(listProjects, "projects", { refreshMs: STATUS_REFRESH_MS });
  const projectList = projects.data ?? [];
  const creating = Boolean(route.create);
  const selected = projectList.find((project) => project.id === route.projectId) ?? projectList[0];
  const selectedId = selected?.id;
  const onProjects = view === "projects" && !creating;
  const detail = onProjects && selected?.id === route.projectId ? selected : undefined;
  const listing = onProjects && !route.projectId;

  React.useEffect(() => {
    document.title = `${viewCopy[view].title} | DevHub`;
  }, [view]);

  React.useEffect(() => {
    if (projects.data && route.projectId && !projectList.some((project) => project.id === route.projectId)) {
      navigate({ view }, { replace: true });
    }
  }, [navigate, projectList, projects.data, route.projectId, view]);

  const status = useResource(
    (signal) => getProjectStatus(detail?.id ?? "", signal),
    detail ? `status:${detail.id}` : undefined,
    { refreshMs: STATUS_REFRESH_MS },
  );
  const history = useResource(
    (signal) => listProjectOperations(detail?.id ?? "", signal),
    detail ? `operations:${detail.id}` : undefined,
    { refreshMs: STATUS_REFRESH_MS },
  );
  const statuses = useResource(
    (signal) => Promise.all(projectList.map((project) => getProjectStatus(project.id, signal).catch(() => undefined))),
    listing && projectList.length > 0 ? `statuses:${projectList.map((project) => project.id).join()}` : undefined,
    { refreshMs: STATUS_REFRESH_MS },
  );
  const containers = useResource(
    listContainers,
    view === "containers" || view === "maintenance" ? "containers" : undefined,
    { refreshMs: view === "containers" ? CONTAINERS_REFRESH_MS : undefined },
  );
  const lifecycle = useLifecycle(lifetime, () => { status.reload(); history.reload(); });
  const maintenance = useMaintenance(lifetime, view === "maintenance");
  const logs = useLogStream(selectedId, (view === "logs" && !paused) || Boolean(detail));
  const addProject = useAddProject(lifetime, (project) => {
    projects.update((current) => [...(current ?? []).filter((item) => item.id !== project.id), project]);
    projects.reload();
    navigate({ view: "projects", projectId: project.id });
  });

  const componentFilter = logFilter && logFilter.projectId === selectedId ? logFilter.componentId : undefined;
  const lifecycleError = lifecycle.error && lifecycle.error.projectId === selectedId ? lifecycle.error.message : undefined;
  // The server keeps the history and this page follows its own operations: the latest copy of each one wins.
  const newest = new Map<string, Operation>();
  for (const operation of [...(history.data ?? []), ...lifecycle.operations]) {
    const known = newest.get(operation.id);
    if (!known || Date.parse(operation.updatedAt) >= Date.parse(known.updatedAt)) newest.set(operation.id, operation);
  }
  const operations = Array.from(newest.values());
  // The server runs one operation per project, whichever component it targets and whoever started it.
  const projectBusy = operations.some((operation) => operation.projectId === detail?.id && (operation.state === "queued" || operation.state === "running"));

  function openProject(projectId: string) {
    navigate({ view: "projects", projectId });
  }

  function selectProject(projectId: string) {
    navigate({ view, projectId });
  }

  const projectActions = (
    <>
      <Button type="button" variant="outline" onClick={addProject.requestOpen}>{t("Add existing")}</Button>
      <Button type="button" onClick={() => navigate({ view: "projects", create: true })}><Plus aria-hidden="true" />{t("New project")}</Button>
    </>
  );

  const picker = projectList.length > 1 ? (
    <ProjectPicker projects={projectList} selectedProjectId={selectedId} onSelect={selectProject} />
  ) : null;

  return (
    <AppShell
      activeView={view}
      onNavigate={(nextView) => navigate({ view: nextView, projectId: nextView === "logs" ? selectedId : undefined })}
      title={creating ? t("New project") : viewCopy[view].title}
      description={creating ? t("Create a project and start it in Docker or on this machine.") : viewCopy[view].description}
      breadcrumb={detail ? <ProjectBreadcrumb project={detail} projects={projectList} onList={() => navigate({ view: "projects" })} onSelect={openProject} /> : undefined}
      toolbar={listing && projectList.length > 0 ? projectActions : undefined}
      onLogout={onLogout}
    >
      {creating ? (
        <CreateProjectView
          lifetime={lifetime}
          onCancel={() => navigate({ view: "projects" })}
          onCreated={(project, operation) => {
            projects.update((current) => [...(current ?? []).filter((item) => item.id !== project.id), project]);
            projects.reload();
            navigate({ view: "projects", projectId: project.id });
            void lifecycle.follow(operation);
          }}
        />
      ) : detail ? (
        <div className="container mx-auto flex min-w-0 flex-1 flex-col gap-3">
          {lifecycleError ? <ErrorToast title={t("Component action failed")} message={lifecycleError} onDismiss={lifecycle.dismissError} /> : null}
          {status.error ? <ErrorToast title={t("Status could not be refreshed")} message={status.error} /> : null}
          {history.error ? <ErrorToast title={t("Operation history could not be loaded")} message={history.error} /> : null}
          {logs.error && logs.entries.length > 0 ? <ErrorToast title={t("Log stream interrupted")} message={logs.error} /> : null}
          <ProjectDetail
            project={detail}
            status={status.data}
            statusLoading={status.loading}
            operations={operations}
            operationsLoading={history.loading}
            logEntries={logs.entries}
            logsLoading={logs.loading}
            logsError={logs.error}
            busyComponentIds={projectBusy ? detail.components.map((component) => component.id) : lifecycle.busyComponentIds(detail.id)}
            onAction={(action, componentIds) => lifecycle.run(detail.id, action, componentIds)}
            onOpenLogs={() => navigate({ view: "logs", projectId: detail.id })}
          />
        </div>
      ) : onProjects && route.projectId && !projects.error ? (
        projects.loading ? <div className="container mx-auto"><ProjectDetailSkeleton /></div> : null
      ) : view === "projects" ? (
        <ProjectList
          projects={projectList}
          statuses={statuses.data}
          statusLoading={statuses.loading}
          loading={projects.loading}
          error={projects.error && projectList.length === 0 ? projects.error : undefined}
          actions={projectActions}
          onSelect={openProject}
        />
      ) : null}

      {view === "containers" ? (
        <ContainersView
          containers={containers.data ?? []}
          loading={containers.loading}
          error={containers.error && !containers.data ? containers.error : undefined}
          filter={route.containerState ?? DEFAULT_CONTAINER_STATE}
          onFilterChange={(containerState) => navigate({ view: "containers", containerState }, { replace: true })}
          onSelectProject={openProject}
          onSelectComponent={openProject}
        />
      ) : null}

      {view === "logs" ? (
        <div className="min-w-0 space-y-4">
          {picker}
          {selected ? (
            <>
              {logs.error && logs.entries.length > 0 ? <ErrorToast title={t("Log stream interrupted")} message={logs.error} /> : null}
              <LogsView
                entries={logs.entries}
                loading={logs.loading}
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
            <EmptyState title={t("No project selected")} description={t("Register a project to follow its logs here.")} />
          )}
        </div>
      ) : null}

      {view === "maintenance" ? (
        <div className="min-w-0 space-y-4">
          {maintenance.error ? <ErrorToast title={t("Maintenance action failed")} message={maintenance.error} onDismiss={maintenance.dismissError} /> : null}
          {containers.error ? <ErrorToast title={t("Container inventory unavailable")} message={containers.error} /> : null}
          <Tabs value={route.tab ?? "scans"} onValueChange={(tab) => navigate({ view: "maintenance", tab: tab as MaintenanceTab })}>
            <TabsList aria-label={t("Maintenance sections")}>
              <TabsTrigger value="scans">{t("Image scans")}</TabsTrigger>
              <TabsTrigger value="versions">{t("Versions")}</TabsTrigger>
              <TabsTrigger value="remediation">{t("Source remediation")}</TabsTrigger>
            </TabsList>
            <TabsContent value="scans">
              <ScansView
                scans={maintenance.scans}
                changes={maintenance.changes}
                containers={containers.data ?? []}
                inventoryLoading={containers.loading}
                loading={maintenance.loading}
                busy={maintenance.busy}
                scanningImageId={maintenance.scanningImageId}
                error={maintenance.loadError}
                onScan={maintenance.scan}
              />
            </TabsContent>
            <TabsContent value="versions">
              <VersionsView lifetime={lifetime} />
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
        onRootApproved={addProject.onRootApproved}
      />
    </AppShell>
  );
}
