import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DevHubError } from "../contracts";
import type { Recipe } from "./types";

type Fields = Record<string, unknown>;
export const recipeId = /^[a-z][a-z0-9-]{0,47}$/;
const identifier = /^[a-z][a-z0-9_-]{0,47}$/;
const serviceName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const variable = /^[A-Z_][A-Z0-9_]*$/;
const reservedVariablePrefix = /^(COMPOSE_|DOCKER_|BUILDX_|DEVHUB_REPO_|GIT_)/;
// Docker's default set: a hardened service can keep some of them back, never gain more.
const keptCapability = /^(?:AUDIT_WRITE|CHOWN|DAC_OVERRIDE|FOWNER|FSETID|KILL|MKNOD|NET_BIND_SERVICE|NET_RAW|SETFCAP|SETGID|SETPCAP|SETUID|SYS_CHROOT)$/;
const pathPattern = /^\/(?:[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*)?$/;

export function recipeError(message: string): never { throw new DevHubError(message, "invalid_recipe", 400); }
export function inside(base: string, path: string): boolean {
  const tail = relative(base, path);
  return tail !== ".." && !tail.startsWith(".." + sep) && !isAbsolute(tail);
}
function object(value: unknown, name: string, allowed?: string[]): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) recipeError(`${name} must be an object`);
  const result = value as Fields;
  if (allowed && Object.keys(result).some((key) => !allowed.includes(key))) recipeError(`${name} contains an unknown field`);
  return result;
}
function string(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value) || (pattern && !pattern.test(value))) recipeError(`Invalid ${name}`);
  return value;
}
function array<T>(value: unknown, name: string, map: (item: unknown) => T, maximum = 64): T[] {
  if (!Array.isArray(value) || value.length > maximum) recipeError(`${name} must be an array with at most ${maximum} entries`);
  return value.map(map);
}
function number(value: unknown, name: string, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) recipeError(`Invalid ${name} (use ${min} to ${max})`);
  return value;
}
function absolute(value: unknown, name: string): string {
  const path = string(value, name);
  if (!isAbsolute(path) || resolve(path) !== path) recipeError(`${name} must be a canonical absolute path on the Docker host`);
  return path;
}
function relativePath(value: unknown, name: string): string {
  const path = string(value, name);
  if (isAbsolute(path) || path.split("/").some((part) => !part || [".", "..", ".git"].includes(part))) recipeError(`${name} must be a checkout-relative path`);
  return path;
}
function fromRecord<T>(raw: unknown, name: string, parse: (key: string, value: unknown) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(object(raw, name)).map(([key, value]) => [key, parse(key, value)]));
}
function distinct<T>(items: T[], name: string): T[] {
  if (new Set(items).size !== items.length) recipeError(`${name} must be unique`);
  return items;
}
function routePath(raw: unknown): string {
  const path = string(raw, "route path", pathPattern);
  if (path.split("/").some((part) => part === "." || part === "..")) recipeError("Route paths cannot contain traversal");
  return path;
}
export function readRecipe(directory: string, id: string): Recipe {
  if (!recipeId.test(id)) recipeError("Invalid recipe ID");
  const path = join(directory, id + ".json");
  let raw: unknown;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) recipeError("Recipe must be a regular JSON file up to 128 KiB");
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DevHubError(`Recipe ${id} was not found`, "recipe_not_found", 404);
    if (error instanceof DevHubError) throw error;
    recipeError("Could not read recipe JSON");
  }
  return parseRecipe(raw);
}
export function listRecipes(directory: string): { id: string }[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((file) => file.isFile() && file.name.endsWith(".json") && recipeId.test(file.name.slice(0, -5)))
      .map((file) => ({ id: file.name.slice(0, -5) })).sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export function parseRecipe(raw: unknown): Recipe {
  const input = object(raw, "recipe", ["version", "repositories", "compose", "routes", "steps", "shared", "isolation", "capabilities", "internet", "resources", "idleMinutes", "localFiles", "previewDomain"]);
  if (input.version !== 1) recipeError("Only recipe version 1 is supported");
  const repositories = fromRecord(input.repositories, "repositories", (name, rawRepo) => {
    string(name, "repository name", identifier);
    const repo = object(rawRepo, "repository", ["path", "ref"]);
    return { path: absolute(repo.path, "repository path"), ref: string(repo.ref, "Git ref") };
  });
  const names = Object.keys(repositories);
  if (!names.length || names.length > 8) recipeError("A recipe needs one to eight repositories");
  distinct(names.map((name) => name.replace(/-/g, "_").toUpperCase()), "Repository interpolation names");
  const repoName = (rawName: unknown) => {
    const name = string(rawName, "repository name", identifier);
    if (!Object.hasOwn(repositories, name)) recipeError("Compose file or local file refers to an unknown repository");
    return name;
  };
  const compose = object(input.compose, "compose", ["repository", "files", "profiles", "services", "vars", "secretFiles"]);
  const files = array(compose.files, "compose.files", (rawFile) => {
    const file = object(rawFile, "compose file", ["repository", "path"]);
    return { repository: repoName(file.repository), path: relativePath(file.path, "Compose file") };
  }, 12);
  if (!files.length) recipeError("At least one Compose file is required");
  const vars = fromRecord(compose.vars ?? {}, "compose.vars", (name, value) => {
    if (!variable.test(name) || reservedVariablePrefix.test(name)) recipeError("Invalid or reserved interpolation variable");
    if (typeof value !== "string" || value.includes("\0") || value.length > 16384) recipeError("Interpolation values must be strings up to 16 KiB");
    return value;
  });
  const secretFiles = fromRecord(compose.secretFiles ?? {}, "compose.secretFiles", (name, value) => {
    if (!variable.test(name) || reservedVariablePrefix.test(name) || Object.hasOwn(vars, name)) recipeError("Invalid, reserved or duplicate secret variable");
    return absolute(value, "secret file");
  });
  const service = (value: unknown) => string(value, "Compose service", serviceName);
  const services = distinct(array(compose.services ?? [], "compose.services", service), "Compose services");
  const routes = array(input.routes ?? [], "routes", (rawRoute) => {
    const route = object(rawRoute, "route", ["path", "service", "port", "healthPath"]);
    return { path: routePath(route.path), service: service(route.service), port: number(route.port, "route port", 1, 65535),
      ...(route.healthPath === undefined ? {} : { healthPath: routePath(route.healthPath) }) };
  }, 12);
  distinct(routes.map((route) => route.path), "Route paths");
  const steps = array(input.steps ?? [], "steps", (rawStep) => {
    const step = object(rawStep, "step", ["id", "phase", "service", "argv", "cwd", "timeoutSeconds", "retry"]);
    const phase = string(step.phase, "step phase", /^(install|migrate|seed|check|test)$/) as Recipe["steps"][number]["phase"];
    const argv = array(step.argv, "step argv", (arg) => {
      if (typeof arg !== "string" || arg.includes("\0") || arg.length > 8192) recipeError("Invalid step argument");
      return arg;
    });
    if (!argv[0] || argv[0].startsWith("-")) recipeError("Step argv must start with a command");
    const retry = step.retry === undefined ? (phase === "seed" ? "manual" : "safe") : string(step.retry, "step retry", /^(safe|manual)$/) as "safe" | "manual";
    return { id: string(step.id, "step ID", identifier), phase, service: service(step.service), argv,
      ...(step.cwd === undefined ? {} : { cwd: string(step.cwd, "container working directory", pathPattern) }),
      timeoutSeconds: number(step.timeoutSeconds ?? 60, "step timeout", 1, 600), retry };
  });
  distinct(steps.map((step) => step.id), "Step IDs");
  const shared = object(input.shared ?? {}, "shared", ["networks", "volumes"]);
  const sharedNames = (value: unknown, name: string) => distinct(array(value ?? [], name, (item) => string(item, name, serviceName)), name);
  const sharedResources = { networks: sharedNames(shared.networks, "shared.networks"), volumes: sharedNames(shared.volumes, "shared.volumes") };
  const isolation = string(input.isolation ?? "shared", "isolation", /^(shared|dedicated|hardened)$/) as Recipe["isolation"];
  if (isolation !== "shared" && (sharedResources.networks.length || sharedResources.volumes.length)) recipeError("Only the shared isolation level can use shared networks or volumes");
  if (isolation !== "hardened" && (input.capabilities !== undefined || input.internet !== undefined)) recipeError("capabilities and internet apply to the hardened isolation level only");
  const capabilities = fromRecord(input.capabilities ?? {}, "capabilities", (name, value) => {
    service(name);
    return distinct(array(value, "capabilities", (item) => string(item, "capability", keptCapability)), "capabilities");
  });
  const internet = distinct(array(input.internet ?? [], "internet", service), "internet");
  const resources = object(input.resources ?? {}, "resources", ["cpus", "memoryMiB"]);
  const localFiles = array(input.localFiles ?? [], "localFiles", (rawFile) => {
    const file = object(rawFile, "local file", ["repository", "source", "target"]);
    return { repository: repoName(file.repository), source: absolute(file.source, "local file source"), target: relativePath(file.target, "local file target") };
  });
  distinct(localFiles.map((file) => file.repository + "/" + file.target), "Local file targets");
  const previewDomain = input.previewDomain === undefined ? undefined : string(input.previewDomain, "preview domain",
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  if (previewDomain === "localhost" || previewDomain?.endsWith(".localhost") || (previewDomain && previewDomain.length > 180)) recipeError("Use a routable domain suffix for previewDomain");
  return {
    version: 1, repositories,
    compose: { repository: repoName(compose.repository), files, services, vars, secretFiles,
      profiles: distinct(array(compose.profiles ?? [], "compose.profiles", (name) => string(name, "Compose profile", serviceName)), "Compose profiles") },
    routes, steps, shared: sharedResources, isolation, capabilities, internet,
    resources: { cpus: number(resources.cpus ?? 1, "CPU limit", 0.1, 64, false), memoryMiB: number(resources.memoryMiB ?? 256, "memory limit", 32, 65536) },
    idleMinutes: number(input.idleMinutes ?? 1440, "idle minutes", 1, 43200), localFiles, previewDomain,
  };
}
