import versions from "../../data/versions.json";
import type { StackDefinition } from "../contracts";
import { SERVICE_OPTIONS } from "../services";

/** One definition feeds the panel form, the CLI and the validation of both. */
export const STACKS: StackDefinition[] = [{
  id: "node",
  name: "Node.js",
  description: "TypeScript API with strict settings, Zod configuration, Biome and tests.",
  modes: ["docker", "native"],
  services: SERVICE_OPTIONS,
  options: [
    { id: "framework", label: "Framework", default: "hono", choices: [{ value: "hono", label: "Hono" }] },
    { id: "runtime", label: "Runtime", default: "bun", choices: [{ value: "bun", label: "Bun" }, { value: "node", label: "Node.js with npm" }] },
    { id: "nodeVersion", label: "Node.js", kind: "version", docker: true, when: { option: "runtime", value: "node" }, default: "24", choices: [
      { value: "24", label: "24", tag: "lts", check: { name: "node", version: "24" } },
      { value: "26", label: "26", tag: "latest", check: { name: "node", version: "26" } },
    ] },
    { id: "pattern", label: "Code structure", default: "modules", choices: [{ value: "modules", label: "Modules by domain" }, { value: "standard", label: "Standard routes" }] },
    { id: "orm", label: "Database layer", default: "none", choices: [{ value: "none", label: "SQL client only" }, { value: "drizzle", label: "Drizzle ORM", services: ["postgres"] }] },
  ],
}, {
  id: "python",
  name: "Python",
  description: "FastAPI API managed by uv, with typed settings, Ruff, mypy and tests.",
  modes: ["docker", "native"],
  services: SERVICE_OPTIONS,
  options: [
    { id: "framework", label: "Framework", default: "fastapi", choices: [{ value: "fastapi", label: "FastAPI" }] },
    { id: "pythonVersion", label: "Python", kind: "version", docker: true, default: "3.14", choices: [
      { value: "3.14", label: "3.14", tag: "latest", check: { name: "ghcr.io/astral-sh/uv", version: "3.14" } },
      { value: "3.13", label: "3.13", check: { name: "ghcr.io/astral-sh/uv", version: "3.13" } },
    ] },
    { id: "pattern", label: "Code structure", default: "modules", choices: [{ value: "modules", label: "Modules by domain" }, { value: "standard", label: "Standard routes" }] },
    { id: "orm", label: "Database layer", default: "none", choices: [{ value: "none", label: "SQL client only" }, { value: "sqlalchemy", label: "SQLAlchemy with Alembic", services: ["postgres"] }] },
  ],
}, {
  id: "php",
  name: "PHP",
  description: "API with a health route, logs, one error shape, static analysis and tests, managed by Composer.",
  modes: ["docker", "native"],
  services: SERVICE_OPTIONS,
  options: [
    { id: "framework", label: "Framework", default: "symfony", choices: [{ value: "symfony", label: "Symfony" }, { value: "laravel", label: "Laravel" }] },
    { id: "phpVersion", label: "PHP", kind: "version", docker: true, default: "8.5", choices: [
      { value: "8.5", label: "8.5", tag: "latest", check: { name: "dunglas/frankenphp", version: "8.5" } },
      { value: "8.4", label: "8.4", check: { name: "dunglas/frankenphp", version: "8.4" } },
    ] },
    { id: "symfonyVersion", label: "Symfony", kind: "version", when: { option: "framework", value: "symfony" }, default: "7.4", choices: [
      { value: "7.4", label: "7.4", tag: "lts", check: { name: "symfony/framework-bundle", version: versions.lines.symfony["7.4"]["symfony/framework-bundle"] } },
      { value: "8.1", label: "8.1", tag: "latest", check: { name: "symfony/framework-bundle", version: versions.lines.symfony["8.1"]["symfony/framework-bundle"] } },
    ] },
    { id: "pattern", label: "Code structure", default: "standard", choices: [{ value: "standard", label: "Framework layout" }, { value: "modules", label: "Modules by domain" }] },
    { id: "symfonyOrm", label: "Database layer", when: { option: "framework", value: "symfony" }, default: "none", choices: [{ value: "none", label: "None" }, { value: "doctrine", label: "Doctrine ORM", services: ["postgres"] }] },
    { id: "laravelOrm", label: "Database layer", when: { option: "framework", value: "laravel" }, default: "none", choices: [{ value: "none", label: "None" }, { value: "eloquent", label: "Eloquent", services: ["postgres"] }] },
  ],
}];
