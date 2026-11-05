import * as React from "react";
import type { AppView } from "../components/views/app-shell";

export type MaintenanceTab = "scans" | "versions" | "remediation";

const CONTAINER_STATES = ["all", "running", "unhealthy", "stopped", "linked"] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];
export const DEFAULT_CONTAINER_STATE: ContainerState = "running";

export interface Route {
  view: AppView;
  projectId?: string;
  /** The creation page, inside the Projects section. */
  create?: boolean;
  tab?: MaintenanceTab;
  containerState?: ContainerState;
}

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseRoute(pathname: string, search = ""): Route | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (path === "/projects") return { view: "projects" };
  if (path === "/projects/new") return { view: "projects", create: true };
  if (path === "/containers") {
    const state = CONTAINER_STATES.find((item) => item === new URLSearchParams(search).get("state"));
    return { view: "containers", containerState: state ?? DEFAULT_CONTAINER_STATE };
  }
  if (path === "/logs") return { view: "logs" };
  if (path === "/maintenance" || path === "/maintenance/scans") return { view: "maintenance", tab: "scans" };
  if (path === "/maintenance/versions") return { view: "maintenance", tab: "versions" };
  if (path === "/maintenance/remediation") return { view: "maintenance", tab: "remediation" };

  const projectMatch = path.match(/^\/(projects|logs)\/([^/]+)$/);
  if (projectMatch && PROJECT_ID_PATTERN.test(projectMatch[2])) {
    return { view: projectMatch[1] as "projects" | "logs", projectId: projectMatch[2] };
  }
  return undefined;
}

export function routePath(route: Route): string {
  if (route.create) return "/projects/new";
  if (route.view === "maintenance") {
    return route.tab === "scans" || !route.tab ? "/maintenance" : `/maintenance/${route.tab}`;
  }
  if ((route.view === "projects" || route.view === "logs") && route.projectId) {
    return `/${route.view}/${route.projectId}`;
  }
  if (route.view === "containers") return `/containers?state=${route.containerState ?? DEFAULT_CONTAINER_STATE}`;
  return `/${route.view}`;
}

/** Keeps a plain click inside the app; a modified click still opens the real link in a new tab. */
export function plainClick(event: React.MouseEvent, navigate: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

function getLocation() {
  return window.location.pathname + window.location.search;
}

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getServerLocation() {
  return "/projects";
}

export function useRoute(): { route: Route; navigate: (route: Route, options?: { replace?: boolean }) => void } {
  const location = React.useSyncExternalStore(subscribe, getLocation, getServerLocation);
  const [pathname, search] = location.split("?");
  const route = parseRoute(pathname, search) ?? { view: "projects" as const };

  // Unknown paths fall back to /projects; /containers always shows its state filter in the URL.
  React.useEffect(() => {
    const parsed = parseRoute(pathname, search);
    const canonical = !parsed ? "/projects" : parsed.view === "containers" ? routePath(parsed) : location;
    if (canonical !== location) {
      window.history.replaceState(null, "", canonical);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [location, pathname, search]);

  const navigate = React.useCallback((nextRoute: Route, options?: { replace?: boolean }) => {
    const path = routePath(nextRoute);
    if (path === getLocation()) return;
    if (options?.replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return { route, navigate };
}
