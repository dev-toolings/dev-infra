import { DevHubError } from "../contracts";

const MAX_VERSION_LENGTH = 512;
const MAX_MAKE_BYTES = 1024 * 1024;
const MAX_TARGETS = 100;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object") return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataValue(record: PlainRecord, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasDependency(record: unknown, name: string): boolean {
  if (!isPlainRecord(record)) return false;
  const version = ownDataValue(record, name);
  return typeof version === "string" && version.length > 0 && version.length <= MAX_VERSION_LENGTH;
}

function hasAnyDependency(manifest: PlainRecord, sections: readonly string[], name: string): boolean {
  return sections.some((section) => hasDependency(ownDataValue(manifest, section), name));
}

export function classifyManifests(packageJson?: unknown, composerJson?: unknown): string[] {
  const packageManifest = isPlainRecord(packageJson) ? packageJson : undefined;
  const composerManifest = isPlainRecord(composerJson) ? composerJson : undefined;
  const labels: string[] = [];

  if (composerManifest) labels.push("php");
  if (composerManifest && hasAnyDependency(composerManifest, ["require", "require-dev"], "symfony/framework-bundle")) {
    labels.push("symfony");
  }
  if (composerManifest && hasAnyDependency(composerManifest, ["require", "require-dev"], "laravel/framework")) {
    labels.push("laravel");
  }
  if (packageManifest) labels.push("node");
  if (packageManifest && hasAnyDependency(packageManifest, ["dependencies", "devDependencies"], "react")) {
    labels.push("react");
  }
  if (packageManifest && hasAnyDependency(packageManifest, ["dependencies", "devDependencies"], "vite")) {
    labels.push("vite");
  }

  return labels;
}

function utf8LengthExceedsLimit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

function hasLineContinuation(line: string): boolean {
  let slashCount = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function stripComment(line: string): string {
  const comment = line.indexOf("#");
  return comment === -1 ? line : line.slice(0, comment);
}

function isAssignmentOperatorAfterColon(line: string, colon: number): boolean {
  const remainder = line.slice(colon + 1);
  return remainder.startsWith("=") || remainder.startsWith(":=") || remainder.startsWith("::=");
}

function isTargetSpecificAssignment(line: string, colon: number): boolean {
  const remainder = line.slice(colon + 1);
  return /^\s*[A-Za-z_][A-Za-z0-9_.-]*\s*(?::=|::=|:::=|\?=|\+=|=)/.test(remainder);
}

export function parseMakeTargets(text: string): { targets: string[]; truncated: boolean } {
  if (typeof text !== "string") throw new DevHubError("Invalid Make metadata", "invalid", 400);
  if (utf8LengthExceedsLimit(text, MAX_MAKE_BYTES)) return { targets: [], truncated: true };

  const targets: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  let skippingContinuation = false;

  for (const physicalLine of lines) {
    const line = physicalLine.endsWith("\r") ? physicalLine.slice(0, -1) : physicalLine;
    if (skippingContinuation) {
      if (!hasLineContinuation(line)) skippingContinuation = false;
      continue;
    }
    if (hasLineContinuation(line)) {
      skippingContinuation = true;
      continue;
    }
    if (line.startsWith("\t")) continue;

    const uncommented = stripComment(line).trim();
    if (!uncommented) continue;
    const colon = uncommented.indexOf(":");
    if (colon < 0 || isAssignmentOperatorAfterColon(uncommented, colon) || isTargetSpecificAssignment(uncommented, colon)) continue;

    const names = uncommented.slice(0, colon).trim().split(/\s+/);
    for (const name of names) {
      if (!TARGET_PATTERN.test(name) || seen.has(name)) continue;
      if (targets.length === MAX_TARGETS) return { targets, truncated: true };
      seen.add(name);
      targets.push(name);
    }
  }

  return { targets, truncated: false };
}
