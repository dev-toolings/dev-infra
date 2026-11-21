export interface Recipe {
  version: 1;
  repositories: Record<string, { path: string; ref: string }>;
  compose: {
    repository: string;
    files: { repository: string; path: string }[];
    profiles: string[];
    services: string[];
    vars: Record<string, string>;
    secretFiles: Record<string, string>;
  };
  routes: { path: string; service: string; port: number; healthPath?: string }[];
  steps: {
    id: string;
    phase: "install" | "migrate" | "seed" | "check" | "test";
    service: string;
    argv: string[];
    cwd?: string;
    timeoutSeconds?: number;
    retry?: "safe" | "manual";
  }[];
  shared: { networks: string[]; volumes: string[] };
  /** shared may use approved external resources; dedicated refuses them; hardened also drops privileges and Internet access. */
  isolation: "shared" | "dedicated" | "hardened";
  /** hardened only: capabilities kept per service, and services that keep Internet access. */
  capabilities: Record<string, string[]>;
  internet: string[];
  resources: { cpus: number; memoryMiB: number };
  idleMinutes: number;
  localFiles: { repository: string; source: string; target: string }[];
  previewDomain?: string;
  /** Set by DevHub, never read from a recipe file: the recipe was derived from this DevHub project. */
  generated?: { project: string };
}

export interface CreateEnvironment {
  project: string;
  feature: string;
  refs?: Record<string, string>;
  branches?: Record<string, string>;
  idempotencyKey?: string;
  build?: boolean;
}
export interface DestroyOptions { purgeData?: boolean; removeWorktrees?: boolean; force?: boolean }

export type Observed = "creating" | "starting" | "ready" | "degraded" | "error" | "stopping" | "stopped" | "destroying" | "destroyed";
export interface EnvironmentRepo {
  name: string; source: string; path: string; ref: string; sha: string;
  branch: string; attach: boolean; prepared: boolean; removed?: boolean;
}
export interface EnvironmentOperation {
  id: string;
  action: "create" | "start" | "stop" | "destroy" | "test" | "exec";
  state: "running" | "succeeded" | "failed" | "interrupted";
  step: string;
  startedAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}
export interface EnvironmentResources {
  containers: { id: string; name: string; service: string; state: string; health?: string; imageId: string }[];
  networks: { name: string; id: string }[];
  volumes: { name: string }[];
  images: { reference: string; id: string }[];
}
export interface Preview {
  url: string;
  port: number;
  tunnel: { remoteHost: "127.0.0.1"; remotePort: number };
  domainUrl?: string;
}
export interface Environment {
  id: string; project: string; feature: string; slug: string; composeProject: string;
  provider: "docker-compose"; host: string;
  repos: EnvironmentRepo[];
  desired: "running" | "stopped" | "destroyed";
  observed: Observed;
  operation?: EnvironmentOperation;
  observationError?: { code: string; message: string };
  createdAt: string; activeAt: string; idleMinutes: number;
  configuration?: {
    fingerprint: string; services: string[]; volumes: string[];
    networks: string[]; images: string[]; serviceImages: Record<string, string>;
  };
  resources: EnvironmentResources;
  preview?: Preview;
  bootstrap: Record<string, "running" | "done" | "failed">;
  /** Private Postgres database of a feature of a DevHub project, kept until purged. */
  database?: string;
}

export interface EnvironmentsPort {
  recipes(): { id: string }[];
  create(input: CreateEnvironment): Promise<Environment>;
  list(): Environment[];
  status(id: string): Promise<Environment>;
  start(id: string, build?: boolean, retryStep?: string): Promise<Environment>;
  stop(id: string): Promise<Environment>;
  destroy(id: string, options?: DestroyOptions): Promise<Environment>;
  logs(id: string, service?: string, tail?: number): Promise<{ service: string; stdout: string; stderr: string }[]>;
  exec(id: string, service: string, argv: string[], timeout?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  test(id: string): Promise<Environment>;
  preview(id: string): Promise<Preview>;
  reconcile(): Promise<Environment[]>;
  doctor(): Promise<unknown>;
  installTimer(): Promise<unknown>;
}
