// Shared interfaces owned by the lead. Workers implement, never change these.
export type ComponentKind = "compose" | "native";
export type Action = "start" | "stop" | "restart" | "check";
export type State = "stopped" | "starting" | "running" | "unhealthy" | "unknown";
export interface Root { id: string; path: string; label: string }
export interface SourceRef { file: string; service?: string; stage?: string }
export interface Component {
 id: string; name: string; kind: ComponentKind; cwd: string; argv?: string[];
 compose?: { files: string[]; projectName: string; profiles: string[]; services: string[] };
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
export interface CatalogPort {
 listRoots(): Root[]; addRoot(path: string, label?: string): Root; removeRoot(id: string): void;
 assertAllowedPath(path: string, mustExist?: boolean): string;
 listProjects(): Project[]; getProject(id: string): Project; saveProject(input: ProjectInput): Project; removeProject(id: string): void;
 claimOperation(projectId: string, action: Action, componentIds: string[], idempotencyKey?: string): Operation;
 updateOperation(id: string, patch: Partial<Pick<Operation,"state"|"error">>): Operation;
 getOperation(id: string): Operation; listOperations(projectId?: string): Operation[]; recoverOperations(): void;
 putRecord<T>(namespace: string, id: string, value: T): void; getRecord<T>(namespace: string, id: string): T | undefined; listRecords<T>(namespace: string): T[];
 close(): void;
}
export interface RuntimePort {
 check(project: Project, component: Component): Promise<ComponentStatus>;
 start(project: Project, component: Component): Promise<void>;
 stop(project: Project, component: Component): Promise<void>;
 logs(project: Project, component: Component, limit?: number): Promise<LogEntry[]>;
 inventory(projects: Project[]): Promise<ContainerInfo[]>;
}
export interface OperationsPort {
 submit(projectId: string, action: Action, componentIds?: string[], idempotencyKey?: string): Operation;
 execute(projectId: string, action: Action, componentIds?: string[], idempotencyKey?: string): Promise<Operation>;
 status(projectId: string): Promise<ProjectStatus>;
 logs(projectId: string, options?: LogOptions): Promise<LogEntry[]>;
 getOperation(id: string): Operation; listOperations(projectId?: string): Operation[];
 inventory(): Promise<ContainerInfo[]>;
}
export interface Detection { path: string; name: string; git: "repository"|"worktree"|"none"; stacks: string[]; composeFiles: string[]; makeTargets: string[]; components: Component[]; warnings: string[] }
export interface Preset { id: string; name: string; description: string }
export interface SetupInput { path: string; name: string; preset: string; id?: string; composeProjectName?: string }
export interface PlannedFile { path: string; content: string }
export interface SetupPlan { id: string; project: ProjectInput; files: PlannedFile[]; warnings: string[]; createdAt: string }
export interface DiscoveryPort {
 scan(path: string, depth?: number): Promise<Detection[]>; inspect(path: string): Promise<Detection>;
 presets(): Preset[]; preview(input: SetupInput): Promise<SetupPlan>; apply(planId: string): Promise<Project>;
}
export interface Finding { id: string; package: string; installedVersion: string; fixedVersion?: string; severity: string; title: string; target: string }
export interface Scan { id: string; imageId: string; state: "succeeded"|"failed"; scannedAt: string; scanner: string; databaseUpdatedAt?: string; findings: Finding[]; error?: string }
export interface RemediationInput { projectId: string; componentId: string; file: string; replacement: string; service?: string; stage?: string }
export interface Change {
 id: string; projectId: string; componentId: string; file: string; sourceHash: string;
 original: string; proposed: string; replacement: string; branch?: string;
 state: "preview"|"applied"|"validated"|"failed"|"activated";
 createdAt: string; imageId?: string; scanId?: string; error?: string;
}
export interface MaintenancePort {
 scan(imageId: string): Promise<Scan>; listScans(): Scan[]; getScan(id: string): Scan;
 preview(input: RemediationInput): Promise<Change>; apply(changeId: string): Promise<Change>;
 validate(changeId: string): Promise<Change>; activate(changeId: string): Promise<Change>;
 listChanges(): Change[];
}
export interface AppServices { catalog: CatalogPort; discovery: DiscoveryPort; operations: OperationsPort; maintenance: MaintenancePort }
export class DevHubError extends Error {
 constructor(message: string, public readonly code = "invalid", public readonly status = 400) { super(message); this.name = "DevHubError"; }
}

export type PublicComponent = Pick<Component,"id"|"name"|"kind"|"cwd"|"compose"|"dependsOn"|"url"|"health"|"limits">;
export type PublicProject = Omit<Project,"components"> & { components: PublicComponent[] };

export interface ApiSuccess<T> { data: T }
export interface ApiError { error: { code: string; message: string } }
export type PublicDetection = Omit<Detection,"components"> & { components: PublicComponent[] };
export type PublicSetupPlan = Omit<SetupPlan,"project"> & { project: Omit<PublicProject,"createdAt"> };

export type PublicChange = Omit<Change,"original"|"proposed"> & { changedLine: { line: number; before: string; after: string } };
