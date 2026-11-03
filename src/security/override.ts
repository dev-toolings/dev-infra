import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Compose records every --file in a container's config_files label, so the override an
 * activation used must stay on disk for the ownership checks that read that label later.
 * A file is approved only at the exact path of its project, component, service and image,
 * with the exact content activation writes. Everything else stays a foreign config file.
 */
export type OverrideScope = { stateDir: string; projectId: string; componentId: string; service: string };

const IMAGE_HEX = /^[a-f0-9]{64}$/;
const directory = (scope: OverrideScope) => join(scope.stateDir, "compose-overrides");
const prefix = ({ projectId, componentId, service }: OverrideScope) => `${createHash("sha256").update(`${projectId}\0${componentId}\0${service}`).digest("hex").slice(0, 32)}-`;

export function overrideFile(scope: OverrideScope, imageId: string): string { return join(directory(scope), `${prefix(scope)}${imageId.slice("sha256:".length)}.yml`); }
/** `!reset` drops the build section so Compose runs the exact validated image ID. */
export function overrideContent(service: string, imageId: string): string { return `services:\n  ${service}:\n    image: ${imageId}\n    build: !reset null\n`; }
export function approvedOverride(scope: OverrideScope, file: string): boolean {
  const start = join(directory(scope), prefix(scope));
  if (!file.startsWith(start) || !file.endsWith(".yml")) return false;
  const imageHex = file.slice(start.length, -".yml".length);
  if (!IMAGE_HEX.test(imageHex)) return false;
  try { return lstatSync(file).isFile() && readFileSync(file, "utf8") === overrideContent(scope.service, `sha256:${imageHex}`); } catch { return false; }
}
/** Only the override of the current containers stays approved for this service. */
export function retireOverrides(scope: OverrideScope, keep: string): void {
  for (const name of readdirSync(directory(scope))) {
    const file = join(directory(scope), name);
    if (name.startsWith(prefix(scope)) && file !== keep) unlinkSync(file);
  }
}
