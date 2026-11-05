export type AgentOptions = { name: string; stack: string; checks: string[]; layout: string[]; rules: string[]; services: string[]; docker: boolean };

/** Only what an agent cannot read from the code or would get wrong by default: a longer file costs more and helps less. */
export const AGENT_RULES = {
  hono: [
    "Chain routes on the Hono instance and write each handler inline after its path: `AppType` only sees chained routes.",
    "Validate each request with `zValidator` and `rejectInvalid`.",
    "Let errors reach `app.onError`: no `try`/`catch` that hides them.",
    "Test with `app.request()` on `createApp()`, `node:test` and `node:assert/strict`: no running server.",
    "Hono docs for agents: https://hono.dev/llms.txt",
  ],
  bun: [
    "Use `bun` and `bunx` only: `bun.lock` is the lockfile.",
    "`bun --hot` runs modules again on each save: keep clients such as the logger or the database on `globalThis`.",
    "Bun docs for agents: https://bun.com/llms.txt",
  ],
  node: [
    "Use `npm` only, and commit `package-lock.json`.",
    "Node strips types without checking them: erasable TypeScript only (no `enum`, no parameter properties), `.ts` in relative imports, `import type` for types, no tsconfig `paths`.",
  ],
  drizzle: (tool: string) => [
    `Apply schema changes with \`${tool} run db:generate\`, then \`${tool} run db:migrate\`: never \`drizzle-kit push\`.`,
    "Commit all of `drizzle/`, `meta` included, and never edit a migration once applied: generate a new one.",
    "Drizzle docs for agents: https://orm.drizzle.team/llms.txt",
  ],
  fastapi: [
    "Add dependencies with `uv add` (`--dev` for tools), commit `uv.lock`, and run Python through `uv run`: never `pip`.",
    "Use `async def` only for routes that await: a route that blocks (driver, file) uses plain `def`.",
    "Declare dependencies with `Annotated[T, Depends(...)]`.",
    "Run startup and shutdown code in a `lifespan`, never `@app.on_event`, and test it with `with TestClient(app)`.",
    "FastAPI guide for agents: https://github.com/fastapi/fastapi/blob/master/fastapi/.agents/skills/fastapi/SKILL.md",
  ],
  symfony: [
    "This is a minimal kernel: no `bin/console`, no Flex, no `symfony/dotenv`. `composer require` applies no recipe, so register each bundle in `Kernel::registerBundles()` and configure it in `configureContainer()`.",
    "Only `src/Controller` is loaded as services: extend the `load()` call in `configureContainer()` before adding a service elsewhere.",
    "Declare routes with `#[Route]` attributes in `src/Controller`.",
    "`.env` files are not loaded: read variables from the process with `%env(NAME)%`.",
  ],
  laravel: [
    "Routes have no `/api` prefix (`apiPrefix: ''`): do not add one.",
    "Call `env()` only in `config/*.php`; elsewhere use `config()`.",
    "This is a minimal app: no `app/` yet, no `config/app.php`, no tests and no `APP_KEY`. Set `APP_KEY` before using encryption, sessions or cookies.",
  ],
};

/** The services are shared with other projects, and only some of them enforce it. */
const serviceRules = (name: string): Record<string, string> => ({
  postgres: "PostgreSQL: connect with `DATABASE_URL`. This database and its role are the only ones this project may change.",
  mysql: "MySQL: connect with `MYSQL_URL`. This database and its user are the only ones this project may change.",
  mariadb: "MariaDB: connect with `MARIADB_URL`. This database and its user are the only ones this project may change.",
  redis: "Redis is shared: read `REDIS_URL`, start every key with `REDIS_PREFIX`, and never run `FLUSHALL`, `FLUSHDB` or `KEYS *`. Keys can be evicted: keep nothing there that you cannot rebuild.",
  meilisearch: "Meilisearch is shared and the key is the master key: read `MEILISEARCH_URL` and `MEILISEARCH_API_KEY`, and start every index with `MEILISEARCH_INDEX_PREFIX`.",
  rabbitmq: `RabbitMQ is shared, on the \`/\` vhost: read \`RABBITMQ_URL\`, and start every queue and exchange with \`${name}.\`.`,
  mailpit: "Send mail through `SMTP_HOST` and `SMTP_PORT`: Mailpit catches it, nothing leaves this machine.",
});

const fence = (commands: string[]) => ["```sh", ...commands, "```"];

/**
 * Instructions for coding agents. AGENTS.md is the source: Codex, Grok and Claude Code read it.
 * Skills go in `.agents/skills` for Codex and `.claude/skills` for Claude Code, which Grok also reads.
 */
export function agentFiles({ name, stack, checks, layout, rules, services, docker }: AgentOptions): Record<string, string> {
  const skill = [
    "---", "name: project-checks",
    `description: Use before calling a change done in ${name}. Runs the checks of this project and reports each result.`,
    "---", "", "# Project checks", "",
    "Run each command and report its result. Fix a failure before calling the work done.", "",
    ...fence(checks), "",
    ...(docker ? ["Dependencies live in the container: run these inside the `app` container.", ""] : []),
  ].join("\n");
  return {
    "AGENTS.md": [
      `# ${name}`, "",
      `${stack} project created with DevHub.`, "",
      "## Run it", "",
      ...fence([`devhub project start ${name}`, `devhub project logs ${name}`]), "",
      ...(docker ? [
        "It runs in Docker. Run every command of this file in the `app` container:", "",
        ...fence([`docker compose -p devhub-${name} exec app <command>`]), "",
        "Never install dependencies on the host: their folder is a Docker volume, and the host copy stays empty.",
        `After editing a manifest by hand, \`devhub project restart ${name}\` reinstalls.`, "",
      ] : ["It runs on this machine, in a systemd service.", ""]),
      "## Check a change", "",
      ...fence(checks), "",
      "## Layout", "",
      ...layout.map((item) => `- ${item}`), "",
      "## Rules", "",
      docker ? "- Keep `/health` working: it reports whether the dependencies answer." : "- Keep `/health` working: DevHub uses it to know the project is up.",
      "- Read configuration from the environment. Never commit `.env`.",
      "- Pin exact dependency versions.",
      ...[...rules, ...services.map((service) => serviceRules(name)[service]!)].map((rule) => `- ${rule}`),
      "",
    ].join("\n"),
    ".claude/settings.json": `${JSON.stringify({ permissions: { allow: checks.map((command) => `Bash(${command}:*)`) } }, null, 2)}\n`,
    ".claude/skills/project-checks/SKILL.md": skill,
    ".agents/skills/project-checks/SKILL.md": skill,
  };
}
