import * as React from "react";
import type { AppView } from "../components/views/app-shell";

export type MaintenanceTab = "scans" | "remediation";

export interface Route {
  view: AppView;
  projectId?: string;
  tab?: MaintenanceTab;
}

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseRoute(pathname: string): Route | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (path === "/projects") return { view: "projects" };
  if (path === "/containers") return { view: "containers" };
  if (path === "/logs") return { view: "logs" };
  if (path === "/maintenance" || path === "/maintenance/scans") return { view: "maintenance", tab: "scans" };
  if (path === "/maintenance/remediation") return { view: "maintenance", tab: "remediation" };

  const projectMatch = path.match(/^\/(projects|logs)\/([^/]+)$/);
  if (projectMatch && PROJECT_ID_PATTERN.test(projectMatch[2])) {
    return { view: projectMatch[1] as "projects" | "logs", projectId: projectMatch[2] };
  }
  return undefined;
}

export function routePath(route: Route): string {
  if (route.view === "maintenance") {
    return route.tab === "remediation" ? "/maintenance/remediation" : "/maintenance";
  }
  if ((route.view === "projects" || route.view === "logs") && route.projectId) {
    return `/${route.view}/${route.projectId}`;
  }
  return `/${route.view}`;
}

function getPathname() {
  return window.location.pathname;
}

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getServerPathname() {
  return "/projects";
}

export function useRoute(): { route: Route; navigate: (route: Route, options?: { replace?: boolean }) => void } {
  const pathname = React.useSyncExternalStore(subscribe, getPathname, getServerPathname);
  const route = parseRoute(pathname) ?? { view: "projects" as const };

  React.useEffect(() => {
    if (!parseRoute(window.location.pathname)) {
      window.history.replaceState(null, "", "/projects");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, []);

  const navigate = React.useCallback((nextRoute: Route, options?: { replace?: boolean }) => {
    const path = routePath(nextRoute);
    if (path === window.location.pathname) return;
    if (options?.replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return { route, navigate };
}
