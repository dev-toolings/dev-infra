import { DevHubError, type Change, type Project, type PublicChange, type PublicProject, type PublicSetupPlan, type SetupPlan } from "./contracts";

/** Explicit browser projection: execution arguments and environment never cross it. */
export function publicProject(project: Project): PublicProject {
  return { id: project.id, name: project.name, root: project.root, createdAt: project.createdAt,
    components: project.components.map((component) => ({
      id: component.id, name: component.name, kind: component.kind, cwd: component.cwd,
      compose: component.compose ? { files: [...component.compose.files], projectName: component.compose.projectName, profiles: [...component.compose.profiles], services: [...component.compose.services] } : undefined,
      dependsOn: [...component.dependsOn], url: component.url,
      health: component.health ? { url: component.health.url } : undefined,
      limits: component.limits ? { memoryMb: component.limits.memoryMb, cpuPercent: component.limits.cpuPercent, tasks: component.limits.tasks } : undefined,
    })),
  };
}
export function publicSetupPlan(plan: SetupPlan): PublicSetupPlan {
  const { createdAt: _, ...project } = publicProject({ ...plan.project, createdAt: plan.createdAt });
  return { id: plan.id, project, files: plan.files, warnings: plan.warnings, createdAt: plan.createdAt };
}
function reference(line: string): string {
  const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
  if (from) return from[1]!;
  const image = /^\s*image\s*:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^#\s]+))/.exec(line);
  if (image) return image[1] ?? image[2] ?? image[3]!;
  throw new DevHubError("Only a single image reference change can be previewed", "unsupported_patch", 409);
}
export function publicChange(change: Change): PublicChange {
  const before = change.original.split(/\r?\n/), after = change.proposed.split(/\r?\n/);
  const lines = before.flatMap((line, index) => line === after[index] ? [] : [index]);
  if (before.length !== after.length || lines.length !== 1) throw new DevHubError("Only a single image reference change can be previewed", "unsupported_patch", 409);
  const index = lines[0]!;
  return { id: change.id, projectId: change.projectId, componentId: change.componentId,
    file: change.file, sourceHash: change.sourceHash, replacement: change.replacement,
    branch: change.branch, state: change.state, createdAt: change.createdAt,
    imageId: change.imageId, scanId: change.scanId,
    ...(change.error ? { error: "Maintenance failed. Inspect the local CLI details." } : {}),
    changedLine: { line: index + 1, before: reference(before[index]!), after: reference(after[index]!) },
  };
}
