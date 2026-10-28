import { homedir } from "node:os";
import { resolve, join } from "node:path";
import type { AppServices, CatalogPort, DiscoveryPort, RuntimePort, OperationsPort, MaintenancePort, Executor } from "./contracts";

export const LISTEN_HOST = "127.0.0.1" as const;
export const DEFAULT_PORT = 8040;
export function stateDirectory(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "devhub");
}
type ListenerOptions = { hostname: string; port: number; fetch: (request: Request) => Response | Promise<Response> };
export function listen(fetch: ListenerOptions["fetch"], port = DEFAULT_PORT, serve: (options: ListenerOptions) => unknown = (options) => Bun.serve(options)): unknown {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer between 1024 and 65535");
  return serve({ hostname: LISTEN_HOST, port, fetch });
}

// Fixed module paths keep foundation independently typecheckable before worker integration.
async function moduleAt(name: string) { return import(`./${name}/index.ts`); }
export async function services(stateDir = stateDirectory()): Promise<AppServices> {
  const [catalogModule, discoveryModule, runtimeModule, operationsModule, securityModule] = await Promise.all(["catalog", "discovery", "runtime", "operations", "security"].map(moduleAt));
  const { execCommand } = await import("./runtime/" + "executor.ts") as { execCommand: Executor };
  const infraDir = resolve(import.meta.dir, "..");
  const catalog: CatalogPort = new catalogModule.Catalog({ stateDir, infraDir });
  const runtime: RuntimePort = new runtimeModule.Runtime({ run: execCommand, stateDir, assertAllowedPath: catalog.assertAllowedPath.bind(catalog) });
  const discovery: DiscoveryPort = new discoveryModule.Discovery({ catalog, run: execCommand });
  const operations: OperationsPort = new operationsModule.Operations({ catalog, runtime });
  const maintenance: MaintenancePort = new securityModule.Maintenance({ catalog, runtime, run: execCommand, stateDir });
  return { catalog, discovery, operations, maintenance };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const stateDir = stateDirectory();
  const api = argv[0] === "serve" || argv[0] === "pair" ? await moduleAt("api") : undefined;
  if (argv[0] === "pair") {
    const pairing = api!.issuePairingCode(stateDir) as { code: string; expiresAt: string };
    process.stdout.write(`Pairing code: ${pairing.code}\nExpires: ${pairing.expiresAt}\n`);
    return 0;
  }
  const appServices = await services(stateDir);
  if (argv[0] === "serve") {
    if (argv.length > 1 && (argv.length !== 3 || argv[1] !== "--port")) throw new Error("Usage: devhub serve [--port 8040]");
    const port = argv[1] === "--port" ? Number(argv[2]) : DEFAULT_PORT;
    api!.issuePairingCode(stateDir);
    const app = api!.createApp(appServices, { stateDir, hostnames: [`127.0.0.1:${port}`, `localhost:${port}`, "127.0.0.1:5175", "localhost:5175"], origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:5175", "http://localhost:5175"] });
    listen((request) => app.fetch(request), port);
    process.stdout.write(`DevHub listening on http://${LISTEN_HOST}:${port}\nRun devhub pair to obtain a one-time pairing code.\n`);
    return 0;
  }
  try {
    const cli = await moduleAt("cli");
    const { execCommand } = await import("./runtime/" + "executor.ts") as { execCommand: Executor };
    return await cli.runCli(argv, appServices, { stateDir, infraDir: resolve(import.meta.dir, ".."), run: execCommand });
  } finally { appServices.catalog.close(); }
}
if (import.meta.main) main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`devhub: ${error instanceof Error ? error.message : "Operation failed"}\n`);
  process.exitCode = 1;
});
