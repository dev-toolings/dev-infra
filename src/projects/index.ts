import { join } from "node:path";
import { DevHubError, type CatalogPort, type Executor, type ExecResult, type ProjectToolsPort } from "../contracts";
import { syncProxy } from "../proxy";

type Options = { catalog: CatalogPort; run: Executor; stateDir: string; infraDir: string };

/** Commands on a project DevHub runs in Docker, and the proxy names of every project. */
export class ProjectTools implements ProjectToolsPort {
  constructor(private readonly options: Options) {}

  /** Runs in the app container of the project, never on this machine. */
  async exec(projectId: string, command: string, timeoutMs = 120_000): Promise<ExecResult> {
    const { catalog, run, stateDir } = this.options;
    const project = catalog.getProject(projectId);
    const component = project.components[0];
    if (project.components.length !== 1 || !component?.compose?.managed) throw new DevHubError("exec supports projects DevHub runs in Docker (created with devhub new or devhub import)", "unsupported_project", 409);
    if (!command.trim() || command.length > 8_000) throw new DevHubError("Give a command of at most 8000 characters");
    return run(["docker", "compose", "-p", component.compose.projectName, `--project-directory=${component.cwd}`, `--file=${join(stateDir, "imports", projectId, "compose.yml")}`, "exec", "-T", "app", "sh", "-c", command], { timeoutMs, maxOutputBytes: 1_000_000 });
  }

  /** Caddy names every project; it is optional, so a stopped proxy is not an error. */
  syncProxy() { return syncProxy(this.options.run, this.options.infraDir, this.options.catalog.listProjects()); }
}
