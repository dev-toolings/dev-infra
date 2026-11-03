import { homedir } from "node:os";
import { resolve, join, isAbsolute, sep } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { ensureStateDir } from "./state";
import { parseCliArgs } from "./cli/args";
import { guardExecutor } from "./guard";
import { terminateChildren } from "./runtime/executor";
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
    // --dev is shorthand for the default Vite origin.
    if (argv[index] === "--dev") { devOrigin = "http://localhost:5175"; index -= 1; continue; }
    const value = argv[index + 1];
    if (!value) throw new Error("Usage: devhub serve [--port 8040] [--dev | --dev-origin http://localhost:5175]");
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
const STATIC_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };
/** Serve only regular files inside the built panel directory; unknown routes fall back to index.html. */
export function staticAsset(distDir: string, pathname: string): Response | undefined {
  let root: string;
  try { root = realpathSync(distDir); } catch { return undefined; }
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response("Bad request", { status: 400 }); }
  if (decoded.includes("\0")) return new Response("Bad request", { status: 400 });
  const candidates = decoded === "/" || !/\.[a-z0-9]+$/i.test(decoded) ? ["/index.html"] : [decoded];
  for (const relative of candidates) {
    const target = resolve(root, "." + relative);
    if (!target.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    try {
      const real = realpathSync(target);
      if (!real.startsWith(root + sep) || !lstatSync(real).isFile()) return new Response("Not found", { status: 404 });
      const type = STATIC_TYPES[real.slice(real.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
      return new Response(Bun.file(real), { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    } catch { return new Response("Not found", { status: 404 }); }
  }
  return undefined;
}
export function controllerFetch(api: { fetch: (request: Request) => Response | Promise<Response> }, distDir: string) {
  return (request: Request): Response | Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return staticAsset(distDir, pathname) ?? new Response("DevHub API is running. The control panel is not built: run `bun run web:build` in the DevHub checkout, or use `devhub serve --dev-origin http://127.0.0.1:5175` with the Vite dev server.\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  };
}
type DevPanelSpawn = (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => { exited: Promise<number>; kill: () => void };
/**
 * Development mode owns the Vite panel server, so `devhub serve --dev` alone gives a working panel.
 * A server already answering on the dev origin is reused instead of starting a second one.
 */
export async function startDevPanel(devOrigin: string, checkout: string, apiPort: number, deps: {
  probe?: (origin: string) => Promise<boolean>;
  spawn?: DevPanelSpawn;
  warn?: (message: string) => void;
} = {}): Promise<{ state: "started" | "reused"; stop: () => void }> {
  const probe = deps.probe ?? ((origin: string) => fetch(origin, { signal: AbortSignal.timeout(500) }).then(() => true, () => false));
  if (await probe(devOrigin)) return { state: "reused", stop: () => {} };
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn(argv, { ...options, stdin: "ignore", stdout: "inherit", stderr: "inherit" }));
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  // The Vite proxy reads the API port, so `--port` other than 8040 keeps /api working.
  const child = spawn([process.execPath, "run", "web:dev", "--port", new URL(devOrigin).port || "80"], { cwd: checkout, env: { ...process.env, DEVHUB_API_PORT: String(apiPort) } });
  let stopping = false;
  void child.exited.then((code) => {
    if (!stopping) warn(`devhub: the Vite panel server exited (code ${code}); ${devOrigin} is down. Run \`bun run web:dev\` in ${checkout} to restart it.`);
  });
  return { state: "started", stop: () => { stopping = true; child.kill(); } };
}
const paint = (code: string, text: string, enabled: boolean) => enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
/** Startup summary that says where the API and the panel actually are in each mode. */
export function serveBanner(options: { port: number; devOrigin?: string; devPanel?: "started" | "reused"; panelBuilt: boolean; checkout: string; color?: boolean }): string {
  const color = options.color ?? process.env.NO_COLOR === undefined;
  const label = (text: string) => paint("1", text.padEnd(8), color);
  const url = (text: string) => paint("36", text, color);
  const hint = (text: string) => paint("90", text, color);
  // Bound to 127.0.0.1; shown as localhost, which the API and Vite both accept.
  const api = `http://localhost:${options.port}`;
  const panel = options.devOrigin
    ? `${url(`http://localhost:${new URL(options.devOrigin).port || "80"}`)}  ${hint(options.devPanel === "started" ? "served by Vite, started with the controller" : options.devPanel === "reused" ? "served by the Vite server already running" : `served by Vite: run \`bun run web:dev\` in ${options.checkout}`)}`
    : options.panelBuilt
      ? url(`${api}/`)
      : `${paint("33", "not built", color)}  ${hint(`run \`bun run web:build\` in ${options.checkout}, or use --dev-origin with Vite`)}`;
  return [
    `${paint("1;32", "DevHub controller", color)} ${options.devOrigin ? paint("35", "development mode", color) : hint("ready")}`,
    `  ${label("API")}${url(`${api}/api/v1`)}  ${hint(`loopback only`)}`,
    `  ${label("Panel")}${panel}`,
    `  ${label("Pairing")}${hint("run")} devhub pair ${hint("in another terminal, then paste the code in the panel")}`,
    `  ${label("Logs")}${options.devOrigin ? "colored request log below" : hint("JSON on stderr (DEVHUB_ENV=development for colored logs)")}`,
    `  ${label("Stop")}${hint("Ctrl+C")}`,
    "",
  ].join("\n");
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] !== "serve" && argv[0] !== "pair") {
    let parsed: ReturnType<typeof parseCliArgs>;
    try { parsed = parseCliArgs(argv); }
    catch (error) { process.stderr.write(`devhub: ${error instanceof Error ? error.message : "Invalid command"}\n`); return 2; }
    if (parsed.command === "help") { process.stdout.write(`${parsed.text}\n`); return 0; }
  }
  const serveOptions = argv[0] === "serve" ? parseServeOptions(argv.slice(1)) : undefined;
  // Development mode turns on the colored key=value terminal logger unless the operator chose a mode.
  if (serveOptions?.devOrigin) process.env.DEVHUB_ENV ??= "development";
  const stateDir = ensureStateDir(stateDirectory());
  const api = argv[0] === "serve" || argv[0] === "pair" ? await moduleAt("api") : undefined;
  if (argv[0] === "pair") {
    const pairing = api!.issuePairingCode(stateDir) as { code: string; expiresAt: string };
    const color = process.env.NO_COLOR === undefined;
    process.stdout.write(`${paint("1", "Pairing code", color)}  ${paint("1;32", pairing.code, color)}\n${paint("90", `Single use, expires ${pairing.expiresAt}. Paste it in the DevHub panel.`, color)}\n`);
    return 0;
  }
  // Command children are detached from the terminal: end them before exit, or they keep mutating Docker after the operation lock is gone.
  let stopping = false;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void terminateChildren().finally(() => process.exit(code));
  });
  const reservedPorts = [...CONTROLLER_PORTS, serveOptions?.port ?? DEFAULT_PORT, ...(serveOptions?.devOrigin ? [Number(new URL(serveOptions.devOrigin).port || 80)] : [])];
  const appServices = await services(stateDir, reservedPorts);
  if (argv[0] === "serve") {
    const { port, devOrigin } = serveOptions!;
    // A loopback dev origin is trusted under both names so http://localhost and http://127.0.0.1 behave the same.
    const devPort = devOrigin ? new URL(devOrigin).port || "80" : undefined;
    const devHosts = devPort ? [`127.0.0.1:${devPort}`, `localhost:${devPort}`] : [];
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...devHosts.map((host) => `http://${host}`)];
    const hostnames = [`127.0.0.1:${port}`, `localhost:${port}`, ...devHosts];
    const app = api!.createApp(appServices, { stateDir, hostnames, origins });
    const distDir = resolve(import.meta.dir, "..", "apps", "web", "dist");
    const checkout = resolve(import.meta.dir, "..");
    listen(controllerFetch(app, distDir), port);
    const devPanel = devOrigin ? await startDevPanel(devOrigin, checkout, port) : undefined;
    if (devPanel) {
      // Ctrl+C or a stop signal takes the Vite child down with the controller.
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => devPanel.stop());
      process.once("exit", () => devPanel.stop());
    }
    process.stdout.write(serveBanner({ port, devOrigin, devPanel: devPanel?.state, panelBuilt: existsSync(join(distDir, "index.html")), checkout }));
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
