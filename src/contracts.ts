// Shared interfaces owned by the lead. Workers implement, never change these.
export type ComponentKind = "compose" | "native";
export type Action = "start" | "stop" | "restart" | "check";
export type State = "stopped" | "starting" | "running" | "unhealthy" | "unknown";
export interface Root { id: string; path: string; label: string }
/** Folders of the machine running DevHub. The server builds every path, so clients never parse one. */
export interface DirectoryListing { path: string; parent: string | null; places: string[]; entries: { name: string; path: string }[] }
export interface SourceRef { file: string; service?: string; stage?: string }
export interface Component {
 id: string; name: string; kind: ComponentKind; cwd: string; argv?: string[];
 compose?: { files: string[]; projectName: string; profiles: string[]; services: string[]; /** DevHub generated this stack: its Compose file lives in the state directory, not the project. */ managed?: { infra: string[] } };
 dependsOn: string[]; envFiles?: string[]; url?: string; health?: { url: string };
 limits?: { memoryMb?: number; cpuPercent?: number; tasks?: number };
 sources?: SourceRef[]; validation?: { argv: string[] };
}
export interface ProjectInput { id: string; name: string; root: string; components: Component[] }
export interface Project extends ProjectInput { createdAt: string }
export interface ComponentStatus { componentId: string; state: State; ready: boolean; detail?: string; url?: string }
export interface ProjectStatus { projectId: string; components: ComponentStatus[] }
export interface Operation {
 id: string; projectId: string; action: Action; componentIds: string[];
 state: "queued" | "running" | "succeeded" | "failed" | "unknown";
 createdAt: string; updatedAt: string; error?: string; idempotencyKey?: string;
}
export interface OperationClaim { operation: Operation; acquired: boolean }
export interface LogEntry { seq: number; time: string; projectId: string; componentId: string; stream: "stdout" | "stderr"; message: string; sourceId?: string }
export interface LogOptions { componentId?: string; cursor?: number; limit?: number }
export interface ContainerInfo {
 id: string; name: string; imageId: string; image: string; state: string; health?: string;
 projectId?: string; componentId?: string; composeProject?: string;
 ports: string[]; memoryBytes?: number; cpuPercent?: number;
}
export interface ExecOptions { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: Record<string,string> }
export interface ExecResult { code: number; stdout: string; stderr: string }
export type Executor = (argv: string[], options?: ExecOptions) => Promise<ExecResult>;
export type LogStreamName = "stdout" | "stderr";
export interface FollowHandle { stop: () => void; /** Resolves with the exit code. */ done: Promise<number> }
/** Runs a long-lived read-only command and hands over its output line by line. */
export type Follower = (argv: string[], onLine: (line: string, stream: LogStreamName) => void) => FollowHandle;
export interface ContainerLogLine { time: string; stream: LogStreamName; message: string }
export interface CatalogPort {
 listRoots(): Root[]; addRoot(path: string, label?: string): Root; removeRoot(id: string): void;
 listDirectories(path?: string): Promise<DirectoryListing>;
 assertAllowedPath(path: string, mustExist?: boolean): string;
 listProjects(): Project[]; getProject(id: string): Project; createProject(input: ProjectInput): Project; saveProject(input: ProjectInput): Project; removeProject(id: string): void;
 claimOperation(projectId: string, action: Action, componentIds: string[], idempotencyKey?: string): OperationClaim;
 updateOperation(id: string, patch: Partial<Pick<Operation,"state"|"error">>): Operation;
 getOperation(id: string): Operation; listOperations(projectId?: string): Operation[]; recoverOperations(): void;
 putRecord<T>(namespace: string, id: string, value: T): void;
 updateRecord<T>(namespace: string, id: string, update: (current: T | undefined) => T): T; getRecord<T>(namespace: string, id: string): T | undefined; listRecords<T>(namespace: string): T[];
 deleteRecord(namespace: string, id: string): void;
 close(): void;
}
export interface RuntimePort {
 check(project: Project, component: Component): Promise<ComponentStatus>;
 start(project: Project, component: Component): Promise<void>;
 stop(project: Project, component: Component): Promise<void>;
 logs(project: Project, component: Component, limit?: number): Promise<LogEntry[]>;
 inventory(projects: Project[]): Promise<ContainerInfo[]>;
 followContainer(id: string, since: string | undefined, onLine: (line: ContainerLogLine) => void): Promise<FollowHandle>;
}
export interface OperationsPort {
 submit(projectId: string, action: Action, componentIds?: string[], idempotencyKey?: string): Operation;
 execute(projectId: string, action: Action, componentIds?: string[], idempotencyKey?: string): Promise<Operation>;
 status(projectId: string): Promise<ProjectStatus>;
 logs(projectId: string, options?: LogOptions): Promise<LogEntry[]>;
 getOperation(id: string): Operation; listOperations(projectId?: string): Operation[];
 inventory(): Promise<ContainerInfo[]>;
 followContainer(id: string, since: string | undefined, onLine: (line: ContainerLogLine) => void): Promise<FollowHandle>;
}
export interface Detection { path: string; name: string; git: "repository"|"worktree"|"none"; stacks: string[]; composeFiles: string[]; makeTargets: string[]; components: Component[]; warnings: string[] }
export interface Preset { id: string; name: string; description: string }
export interface SetupInput { path: string; name: string; preset: string; id?: string; composeProjectName?: string }
export interface PlannedFile { path: string; content: string }
export interface SetupPlan { id: string; project: ProjectInput; files: PlannedFile[]; warnings: string[]; createdAt: string }
export interface DiscoveryPort {
 scan(path: string, depth?: number): Promise<Detection[]>; inspect(path: string): Promise<Detection>;
 presets(): Preset[]; preview(input: SetupInput): Promise<SetupPlan>; apply(planId: string): Promise<Project>;
 freePort(start: number): Promise<number>;
}
export interface ImportInput { path: string; name?: string; id?: string; toolchain?: "bun"|"npm"; /** A new project has no lockfile yet: the first install writes it. */ fresh?: boolean }
export type Toolchain = "bun"|"npm"|"uv"|"composer";
export interface ImportPlan {
 project: ProjectInput; toolchain: Toolchain; image: string; /** From DevHub names to the ones the framework reads. */ translateEnv?: (env: Record<string,string>) => Record<string,string>; /** The project keeps its own Dockerfile at its root. */ ownDockerfile?: boolean; /** The stage to run, when the Dockerfile has several. */ buildTarget?: string; install: string; dev: string; lockfile?: string; url: string; containerPort: number;
 infra: string[]; database?: string; /** Where the database runs, when it is not the shared Postgres. */ databaseHost?: string; databaseAdmin?: string; env: Record<string,string>; /** Replaces what a previous import left in the env file: these services were just provisioned. */ linkedEnv?: Record<string,string>; missing: string[]; warnings: string[];
}
export interface ImportResult { project: Project; operation: Operation; url: string; missing: string[] }
/** A project DevHub just generated: its toolchain and services are known, nothing is detected. */
export interface ScaffoldInput { root: string; name: string; id: string; toolchain: Toolchain; image: string; url: string; install: string; dev: string; services: string[]; env: Record<string,string> }
export interface ImportPort { plan(input: ImportInput): Promise<ImportPlan>; scaffold(input: ScaffoldInput): ImportPlan; compose(plan: ImportPlan): string; prepare(plan: ImportPlan): Promise<Project>; apply(plan: ImportPlan): Promise<ImportResult> }
export type CreateMode = "docker"|"native";
export interface StackChoice {
 value: string; label: string; /** Selected with this choice, whatever the form says. */ services?: string[];
 tag?: "lts"|"latest"; /** Where `devhub versions` reports on this version. */ check?: { name: string; version: string };
}
export interface StackOption {
 id: string; label: string; default: string; choices: StackChoice[]; kind?: "version";
 /** Only the image uses it: on this machine the installed version applies. */ docker?: boolean;
 /** Applies only with this value of another option. */ when?: { option: string; value: string };
}
/** What a project changes in its Docker image. A whole `dockerfile` replaces the other fields. */
export interface DockerCustom { image?: string; packages?: string[]; extensions?: string[]; dockerfile?: string; /** New defaults for the ARG lines of the generated Dockerfile. */ args?: Record<string,string>; /** Added to the variables of the container. */ env?: Record<string,string> }
export interface DockerPreview { dockerfile: string; /** The image of the chosen version, before any custom one. */ image: string; compose: string; env: Record<string,string>; /** Variables DevHub sets itself: they cannot be edited. */ locked: string[] }
export interface ServiceOption { id: string; name: string; versions: string[]; /** The version of the shared container: any other one runs in an instance of its own. */ default: string }
export interface ServiceInstance { container: string; /** Inside the Docker network. */ port: number; hostPort: number; /** Set when the Postgres admin is not the one of the shared container. */ admin?: string }
export interface SharedServicesPort { ensure(id: string, version: string): Promise<ServiceInstance>; containerEnv(container: string, name: string): Promise<string> }
export interface StackDefinition { id: string; name: string; description: string; modes: CreateMode[]; services: ServiceOption[]; options: StackOption[] }
export interface CreateInput { stack: string; name: string; rootId: string; mode: CreateMode; options: Record<string,string>; services: string[]; /** By service; a missing one means the shared version. */ versions?: Record<string,string>; docker?: DockerCustom; /** By file, AGENTS.md: the user's own text in place of the generated one. */ instructions?: Record<string,string>; git: boolean }
/** The choices of a form that names no project yet: enough to preview the files, never to create them. */
export type CreateDraft = Omit<CreateInput, "name" | "rootId"> & { rootId?: string };
export interface CreatePlan { input: CreateInput; id: string; path: string; url: string; files: string[]; /** By file: what creation writes. */ contents: Record<string,string>; /** AGENTS.md as generated, whatever the user edited. */ generatedInstructions: Record<string,string>; install: string; dev: string; database?: string; isolation: string; docker?: DockerPreview }
export interface CreateResult { project: Project; operation: Operation; url: string }
export interface CreatePort { stacks(): StackDefinition[]; /** A `draft` plan only shows the files: its folder is neither required nor checked. */ plan(input: CreateInput, draft?: boolean): Promise<CreatePlan>; apply(plan: CreatePlan, wait: boolean): Promise<CreateResult> }
export interface Finding { id: string; package: string; installedVersion: string; fixedVersion?: string; severity: string; title: string; target: string }
export interface Scan { id: string; imageId: string; state: "succeeded"|"failed"; scannedAt: string; scanner: string; databaseUpdatedAt?: string; findings: Finding[]; error?: string }
export interface RemediationInput { projectId: string; componentId: string; file: string; replacement: string; service?: string; stage?: string }
export interface ValidationEvidence {
 baselineImageId: string; candidateImageId: string; baselineScanId: string; candidateScanId: string;
 sourceHash: string; runtimeHash: string; containerIds: string[];
 volumes: { name: string; destination: string }[];
 checksPassed: boolean; findingsImproved: boolean; validatedAt: string;
}
export interface Change {
 id: string; projectId: string; componentId: string; file: string; sourceHash: string;
 original: string; proposed: string; replacement: string; branch?: string;
 state: "preview"|"applied"|"validated"|"failed"|"activated";
 createdAt: string; imageId?: string; scanId?: string; error?: string;
 evidence?: ValidationEvidence;
}
export interface MaintenancePort {
 scan(imageId: string): Promise<Scan>; listScans(): Scan[]; getScan(id: string): Scan;
 preview(input: RemediationInput): Promise<Change>; apply(changeId: string): Promise<Change>;
 validate(changeId: string): Promise<Change>; activate(changeId: string): Promise<Change>;
 listChanges(): Change[];
}
export interface VersionVuln { id: string; cve?: string; summary: string; severity?: string; fixed?: string }
export type VersionState = "ok"|"outdated"|"eol-soon"|"eol"|"vulnerable"|"untracked"|"unknown";
export interface VersionItem {
 kind: "package"|"image"; ecosystem?: string; name: string; version: string; source: string; state: VersionState;
 latest?: string; cycle?: string; lts: boolean; eol?: string; vulns: VersionVuln[]; errors: string[];
}
export interface VersionReport { checkedAt: string; items: VersionItem[] }
/** Lifecycle and advisories of every version DevHub pins, from `tools/versionwatch`. */
export interface VersionsPort { latest(): VersionReport | undefined; check(): Promise<VersionReport> }
/** A branch of a project checked out next to it, running as a project of its own. */
export interface Worktree { id: string; parent: string; branch: string; slug: string; path: string; createdAt: string; activeAt: string; expiresAt?: string }
export interface WorktreePlan { id: string; parent: string; branch: string; slug: string; path: string; url: string; host: string; newBranch: boolean; database?: string; expiresAt?: string }
export interface WorktreeResult { worktree: Worktree; project: Project; operation: Operation; url: string; host: string }
export interface WorktreesPort {
 list(): Worktree[]; get(id: string): Worktree | undefined;
 plan(projectId: string, branch: string, expireHours?: number): Promise<WorktreePlan>; add(plan: WorktreePlan): Promise<WorktreeResult>;
 remove(id: string, force?: boolean): Promise<{ removed: string; keptVolume?: string }>;
 /** Runs in the app container of a project DevHub runs in Docker. */
 exec(projectId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
 sweep(now?: number): Promise<{ stopped: string[]; removed: string[] }>;
 /** Rewrites the Caddy sites of every project; `reloaded` is false when the proxy profile is not running. */
 syncProxy(): Promise<{ sites: { host: string; upstream: string }[]; reloaded: boolean }>;
}
export interface AppServices { catalog: CatalogPort; discovery: DiscoveryPort; operations: OperationsPort; maintenance: MaintenancePort; imports: ImportPort; create: CreatePort; versions: VersionsPort; worktrees: WorktreesPort }
export class DevHubError extends Error {
 constructor(message: string, public readonly code = "invalid", public readonly status = 400) { super(message); this.name = "DevHubError"; }
}

export type PublicComponent = Pick<Component,"id"|"name"|"kind"|"cwd"|"compose"|"dependsOn"|"url"|"health"|"limits">;
export type PublicProject = Omit<Project,"components"> & { components: PublicComponent[]; /** Set on a worktree: the project it was checked out from. */ worktree?: { parent: string; branch: string } };

export interface ApiSuccess<T> { data: T }
export interface ApiError { error: { code: string; message: string } }
export type PublicDetection = Omit<Detection,"components"> & { components: PublicComponent[] };
export type PublicSetupPlan = Omit<SetupPlan,"project"> & { project: Omit<PublicProject,"createdAt"> };

export type PublicChange = Omit<Change,"original"|"proposed"|"evidence"> & { changedLine: { line: number; before: string; after: string } };
