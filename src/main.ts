import { homedir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { ensureStateDir } from "./state";
import { guardExecutor } from "./guard";
import type { AppServices, CatalogPort, DiscoveryPort, RuntimePort, OperationsPort, MaintenancePort, Executor } from "./contracts";

export const LISTEN_HOST = "127.0.0.1" as const;
export const DEFAULT_PORT = 8040;
export const CONTROLLER_PORTS = [8040, 5175];
export function stateDirectory(): string {
  const configured = process.env.XDG_STATE_HOME;
  return join(configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "state"), "devhub");
}
type ListenerOptions = { hostname: string; port: number; fetch: (request: Request) => Response | Promise<Response> };
export function listen(fetch: ListenerOptions["fetch"], port = DEFAULT_PORT, serve: (options: ListenerOptions) => unknown = (options) => Bun.serve(options)): unknown {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer between 1024 and 65535");
  return serve({ hostname: LISTEN_HOST, port, fetch });
}

// Fixed module paths keep foundation independently typecheckable before worker integration.
async function moduleAt(name: string) { return import(`./${name}/index.ts`); }
export interface ManagerModules {
  Catalog: new (options: {stateDir:string;infraDir:string;reservedPorts:number[]}) => CatalogPort;
  Runtime: new (options: {run:Executor;stateDir:string;assertAllowedPath:CatalogPort["assertAllowedPath"]}) => RuntimePort;
  Discovery: new (options: {catalog:CatalogPort;run:Executor}) => DiscoveryPort;
  Operations: new (options: {catalog:CatalogPort;runtime:RuntimePort}) => OperationsPort;
  Maintenance: new (options: {catalog:CatalogPort;runtime:RuntimePort;run:Executor;stateDir:string}) => MaintenancePort;
}
export function composeServices(modules: ManagerModules, executor: Executor, stateDir: string, infraDir: string, reservedPorts = CONTROLLER_PORTS): AppServices {
  const run = guardExecutor(executor);
  const catalog = new modules.Catalog({ stateDir, infraDir, reservedPorts: [...new Set([...CONTROLLER_PORTS, ...reservedPorts])] });
  const runtime = new modules.Runtime({ run, stateDir, assertAllowedPath: catalog.assertAllowedPath.bind(catalog) });
  const discovery = new modules.Discovery({ catalog, run });
  const operations = new modules.Operations({ catalog, runtime });
  const maintenance = new modules.Maintenance({ catalog, runtime, run, stateDir });
  return { catalog, discovery, operations, maintenance };
}
export async function services(stateDir = stateDirectory(), reservedPorts = CONTROLLER_PORTS): Promise<AppServices> {
  const [catalogModule, discoveryModule, runtimeModule, operationsModule, securityModule] = await Promise.all(["catalog", "discovery", "runtime", "operations", "security"].map(moduleAt));
  const { execCommand } = await import("./runtime/" + "executor.ts") as { execCommand: Executor };
  return composeServices({ Catalog: catalogModule.Catalog, Runtime: runtimeModule.Runtime, Discovery: discoveryModule.Discovery, Operations: operationsModule.Operations, Maintenance: securityModule.Maintenance }, execCommand, stateDir, resolve(import.meta.dir, ".."), reservedPorts);
}

export function parseServeOptions(argv: string[]): { port: number; devOrigin?: string } {
  let port = DEFAULT_PORT, devOrigin: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (!value) throw new Error("Usage: devhub serve [--port 8040] [--dev-origin http://127.0.0.1:5175]");
    if (argv[index] === "--port") port = Number(value);
    else if (argv[index] === "--dev-origin") {
      const url = new URL(value);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Development origin must be an exact loopback HTTP origin");
      devOrigin = url.origin;
    } else throw new Error("Unknown serve option");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid controller port");
  return { port, devOrigin };
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const serveOptions = argv[0] === "serve" ? parseServeOptions(argv.slice(1)) : undefined;
  const stateDir = ensureStateDir(stateDirectory());
  const api = argv[0] === "serve" || argv[0] === "pair" ? await moduleAt("api") : undefined;
  if (argv[0] === "pair") {
    const pairing = api!.issuePairingCode(stateDir) as { code: string; expiresAt: string };
    process.stdout.write(`Pairing code: ${pairing.code}\nExpires: ${pairing.expiresAt}\n`);
    return 0;
  }
  const reservedPorts = [...CONTROLLER_PORTS, serveOptions?.port ?? DEFAULT_PORT, ...(serveOptions?.devOrigin ? [Number(new URL(serveOptions.devOrigin).port || 80)] : [])];
  const appServices = await services(stateDir, reservedPorts);
  if (argv[0] === "serve") {
    const { port, devOrigin } = serveOptions!;
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(devOrigin ? [devOrigin] : [])];
    const hostnames = [`127.0.0.1:${port}`, `localhost:${port}`, ...(devOrigin ? [new URL(devOrigin).host] : [])];
    const app = api!.createApp(appServices, { stateDir, hostnames, origins });
    listen((request) => app.fetch(request), port);
    process.stdout.write(`DevHub listening on http://${LISTEN_HOST}:${port}\nRun devhub pair to obtain a one-time pairing code.\n`);
    return 0;
  }
  try {
    const cli = await moduleAt("cli");
    const { execCommand } = await import("./runtime/" + "executor.ts") as { execCommand: Executor };
    return await cli.runCli(argv, appServices, { stateDir, infraDir: resolve(import.meta.dir, ".."), run: guardExecutor(execCommand) });
  } finally { appServices.catalog.close(); }
}
if (import.meta.main) main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`devhub: ${error instanceof Error ? error.message : "Operation failed"}\n`);
  process.exitCode = 1;
});
