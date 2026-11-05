import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DevHubError, type Executor, type VersionReport, type VersionsPort } from "../contracts";
import { redactText } from "../operations/logger";

type Options = { run: Executor; stateDir: string; infraDir: string };

/** Keeps the last report on disk: a check calls public services, so reading it must not. */
export class Versions implements VersionsPort {
  private readonly file: string;
  private running?: Promise<VersionReport>;
  constructor(private readonly options: Options) { this.file = join(options.stateDir, "versions.json"); }

  /** A file that cannot be read counts as no report: the next check replaces it. */
  latest(): VersionReport | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const report = JSON.parse(readFileSync(this.file, "utf8")) as VersionReport;
      return report.items.every((item) => Array.isArray(item.vulns) && Array.isArray(item.errors)) ? report : undefined;
    } catch { return undefined; }
  }

  /** A second click or tab joins the check in progress. */
  check(): Promise<VersionReport> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(): Promise<VersionReport> {
    const { run, infraDir } = this.options;
    const go = await run(["which", "go"], { timeoutMs: 5_000, maxOutputBytes: 4_000 });
    if (go.code !== 0) throw new DevHubError("Go is needed to check versions; install it and try again", "missing_tool", 409);
    const root = resolve(infraDir);
    // Findings also exit non-zero, so only an empty report is a failure.
    const result = await run(["go", "run", ".", "--json", "--root", root], { cwd: join(root, "tools/versionwatch"), timeoutMs: 180_000, maxOutputBytes: 4_000_000 });
    if (!result.stdout.trim()) throw new DevHubError(`Version check failed: ${redactText(result.stderr.slice(-500))}`, "check_failed", 502);
    const report = JSON.parse(result.stdout) as VersionReport;
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 });
    renameSync(temporary, this.file);
    return report;
  }
}
