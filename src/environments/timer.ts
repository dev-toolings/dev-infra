import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { DevHubError, type Executor } from "../contracts";

const timerName = "devhub-feature-reconcile";
const settings = ["DEVHUB_RECIPE_DIR", "DEVHUB_WORKTREE_ROOT", "DEVHUB_FEATURE_MAX_ACTIVE", "DEVHUB_FEATURE_MAX_BUILDS",
  "DEVHUB_FEATURE_MIN_FREE_MIB", "DEVHUB_FEATURE_PROXY_PORT"];
const timer = `[Unit]
Description=Reconcile DevHub feature environments

[Timer]
OnStartupSec=1min
OnUnitInactiveSec=1min
Unit=${timerName}.service

[Install]
WantedBy=timers.target
`;

function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new DevHubError("Invalid systemd setting", "invalid_configuration", 400);
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$") + '"';
}

export async function installFeatureTimer(run: Executor, stateDir: string, infraDir: string) {
  if (process.platform !== "linux") throw new DevHubError("The feature timer requires a Linux systemd user manager", "unsupported", 400);
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (!isAbsolute(config)) throw new DevHubError("XDG_CONFIG_HOME must be absolute", "invalid_configuration", 400);
  const units = join(config, "systemd", "user");
  const environment = ["XDG_STATE_HOME=" + dirname(stateDir), ...["PATH", ...settings].flatMap((name) => process.env[name] === undefined ? [] : [name + "=" + process.env[name]])];
  const service = `[Unit]
Description=Inspect and stop idle DevHub feature environments

[Service]
Type=oneshot
UMask=0077
${environment.map((entry) => "Environment=" + quoted(entry)).join("\n")}
ExecStart=${quoted(process.execPath)} --no-env-file ${quoted(join(infraDir, "src", "main.ts"))} env reconcile --json
`;
  mkdirSync(units, { recursive: true, mode: 0o700 });
  writeFileSync(join(units, timerName + ".service"), service, { mode: 0o600 });
  writeFileSync(join(units, timerName + ".timer"), timer, { mode: 0o600 });
  for (const args of [["daemon-reload"], ["enable", "--now", timerName + ".timer"], ["is-active", timerName + ".timer"]]) {
    const result = await run(["systemctl", "--user", ...args], { timeoutMs: 15_000, maxOutputBytes: 16000 });
    if (result.code !== 0) throw new DevHubError("Feature timer units were written but the systemd user manager could not activate them", "timer_unavailable", 503);
  }
  return { installed: true, unit: timerName + ".timer", directory: units, intervalSeconds: 60 };
}
