import { DevHubError, type Component } from "../contracts";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_COMPONENTS = 64;

function invalidGraph(): never {
  throw new DevHubError("Invalid component graph");
}

function invalidSelection(): never {
  throw new DevHubError("Invalid component selection");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveSelection(
  components: readonly Pick<Component, "id" | "dependsOn">[],
  requested?: readonly string[],
): { requested: string[]; start: string[]; stop: string[] } {
  if (!Array.isArray(components) || components.length < 1 || components.length > MAX_COMPONENTS) {
    invalidGraph();
  }

  const graph = new Map<string, string[]>();
  for (const value of components as readonly unknown[]) {
    if (!isRecord(value)) invalidGraph();

    const id = value.id;
    const dependsOn = value.dependsOn;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || graph.has(id)) invalidGraph();
    if (!Array.isArray(dependsOn) || dependsOn.length > MAX_COMPONENTS) invalidGraph();

    const dependencies = new Set<string>();
    for (const dependency of dependsOn as readonly unknown[]) {
      if (typeof dependency !== "string" || !ID_PATTERN.test(dependency)) invalidGraph();
      dependencies.add(dependency);
    }
    graph.set(id, [...dependencies].sort());
  }

  for (const [id, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!graph.has(dependency) || dependency === id) invalidGraph();
    }
  }

  const ids = [...graph.keys()].sort();
  const visited = new Set<string>();
  const active = new Set<string>();
  const visitGraph = (id: string): void => {
    if (active.has(id)) invalidGraph();
    if (visited.has(id)) return;

    active.add(id);
    for (const dependency of graph.get(id)!) visitGraph(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const id of ids) visitGraph(id);

  let selected: string[];
  if (requested === undefined) {
    selected = ids;
  } else {
    if (!Array.isArray(requested) || requested.length === 0) invalidSelection();
    const unique = new Set<string>();
    for (const id of requested as readonly unknown[]) {
      if (typeof id !== "string" || !ID_PATTERN.test(id) || !graph.has(id) || unique.has(id)) {
        invalidSelection();
      }
      unique.add(id);
    }
    selected = [...unique].sort();
  }

  const start: string[] = [];
  const included = new Set<string>();
  const visitSelection = (id: string): void => {
    if (included.has(id)) return;
    included.add(id);
    for (const dependency of graph.get(id)!) visitSelection(dependency);
    start.push(id);
  };
  for (const id of selected) visitSelection(id);

  const requestedSet = new Set(selected);
  const stop = start.filter((id) => requestedSet.has(id)).reverse();
  return { requested: [...selected], start: [...start], stop: [...stop] };
}
