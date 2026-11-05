export type AgentOptions = { name: string; stack: string; checks: string[]; layout: string[]; rules: string[]; feature: string[]; services: string[]; docker: boolean };

/** The steps of the `add-feature` skill. Each one was run on a generated project: an untested step does not belong here. */
export const AGENT_FEATURE = {
  hono: (pattern: string, tool: string, drizzle: boolean) => [
    pattern === "modules" ? "Copy `src/modules/notes` to `src/modules/<name>` and rename it." : "Copy `src/routes/notes.ts`, `src/schemas/notes.ts` and `src/services/notes.ts`, and rename them.",
    `In \`src/app.ts\`, import it, add its ${pattern === "modules" ? "repository" : "store"} to \`AppDeps\`, and mount its routes with \`.route()\`.`,
    `Pass its ${pattern === "modules" ? "repository" : "store"} in \`src/index.ts\` and in each \`createApp()\` of \`src/app.test.ts\`.`,
    "Add a test to `src/app.test.ts`.",
    ...(drizzle ? [`${pattern === "modules" ? "Rename the table in the copied `schema.ts`" : "Add the table to `src/lib/schema.ts` and copy `src/services/drizzle-note-store.ts`"}, then run \`${tool} run db:generate\` and \`${tool} run db:migrate\`.`] : []),
    `Format with \`${tool === "bun" ? "bun run lint --write" : "npm run lint -- --write"}\`.`,
  ],
  fastapi: (pattern: string, sqlalchemy: boolean) => [
    pattern === "modules" ? "Copy `app/modules/notes` to `app/modules/<name>` and rename it, its imports included." : "Copy `app/routes/notes.py`, `app/schemas/notes.py` and `app/services/notes.py`, and rename them.",
    `In \`app/app.py\`, add its ${pattern === "modules" ? "repository" : "store"} to \`create_app()\`, keep it on \`app.state\`, and add \`app.include_router()\`.`,
    `Pass its ${pattern === "modules" ? "repository" : "store"} in \`app/main.py\` and in each \`create_app()\` of \`tests/test_app.py\`.`,
    "Add a test to `tests/test_app.py`.",
    ...(sqlalchemy ? [`${pattern === "modules" ? "Rename the table in the copied `schema.py`" : "Add the table to `app/lib/schema.py` and copy `app/services/sqlalchemy_note_store.py`"}, then run \`uv run alembic revision --autogenerate -m "<name>"\` and \`uv run alembic upgrade head\`.`] : []),
    "Format with `uv run ruff format .`.",
  ],
  symfony: (modules: boolean, doctrine: boolean) => [
    modules ? "Copy `src/Modules/Notes` to `src/Modules/<Name>`, and rename it." : "Copy `src/Controller/NoteController.php`, `src/Dto/NoteInput.php`, `src/Model/Note.php`, `src/Service/NoteService.php` and the files of `src/Repository`, and rename them.",
    "In `config/services.php`, exclude its plain classes from `load()`, and set the alias of its port. In `config/services_test.php`, point the port at its memory store.",
    "Add a test to `tests/AppTest.php`.",
    ...(doctrine ? [`${modules ? "Rename the table in the copied `NoteRecord.php`" : "Copy `src/Entity/NoteRecord.php`, and rename its table"}, then run \`php bin/console doctrine:migrations:diff\` and \`php bin/console doctrine:migrations:migrate --no-interaction\`. The first needs the database.`] : []),
    "Package: run `composer require <package>:<exact version>`. A hand edit of `composer.json` leaves the lock stale, and `composer validate` fails.",
    "Bundle: also add it to `config/bundles.php`, and configure it in `config/packages`.",
    "Format with `vendor/bin/php-cs-fixer fix`.",
  ],
  laravel: (modules: boolean, eloquent: boolean) => [
    modules ? "Copy `app/Modules/Notes` to `app/Modules/<Name>`, and rename it." : "Copy `app/Http/Controllers/NoteController.php`, `app/Http/Requests/NoteRequest.php`, `app/Models/Note.php`, `app/Services/NoteService.php` and the files of `app/Repositories`, and rename them.",
    "Add its routes to `routes/api.php`, without an `/api` prefix.",
    "Bind its port in `app/Providers/AppServiceProvider.php`, and to its memory store in `setUp()` of `tests/AppTest.php`.",
    "Add a test to `tests/AppTest.php`.",
    ...(eloquent ? ["Run `php artisan make:migration create_<name>_table`, write it, then run `php artisan migrate`."] : []),
    "Configuration: create `config/<name>.php` and read it with `config('<name>.key')`.",
    "Format with `vendor/bin/pint`.",
  ],
};

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
    "`bun --hot` runs modules again on each save: keep clients such as the database or Redis on `globalThis`.",
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
    "Raise `AppError` for an expected failure and let the rest reach `access_log`: no `try`/`except` that hides it.",
    "Test with `TestClient` on `create_app()`: no running server.",
    "FastAPI guide for agents: https://github.com/fastapi/fastapi/blob/master/fastapi/.agents/skills/fastapi/SKILL.md",
  ],
  sqlalchemy: [
    "Apply schema changes with `uv run alembic revision --autogenerate`, then `uv run alembic upgrade head`: never `create_all()`.",
    "Commit all of `migrations/`, and never edit a migration once applied: generate a new one.",
  ],
  symfony: [
    "There is no Flex: `composer require` applies no recipe, so add each bundle to `config/bundles.php` and configure it in `config/packages`.",
    "Declare routes with `#[Route]` attributes on a controller, and read a body with `#[MapRequestPayload]`.",
    "Throw `AppError` for an expected failure and let the rest reach `ErrorSubscriber`: no `try`/`catch` that hides it.",
    "A running app gets its environment from DevHub: `.env` is read only by `bin/console`, in native mode.",
    "Docker runs the app in FrankenPHP worker mode: a service outlives the request, so keep no request state on it, or implement `ResetInterface`.",
    "FrankenPHP docs: https://frankenphp.dev/docs/symfony/",
  ],
  laravel: [
    "Routes have no `/api` prefix (`apiPrefix: ''`): do not add one.",
    "Call `env()` only in `config/*.php`; elsewhere use `config()`.",
    "Throw `AppError` for an expected failure and let the rest reach `ErrorResponse`: no `try`/`catch` that hides it.",
    "Validate each request with a `FormRequest`.",
    "Docker runs the app under Octane: a singleton outlives the request, so never inject the request, the container or the config repository into one. Bind what needs them with `scoped()`.",
    "Laravel docs for agents: https://laravel.com/docs/octane",
  ],
};

/** The services are shared with other projects, and only some of them enforce it. */
const serviceRules = (name: string): Record<string, string> => ({
  postgres: "PostgreSQL: connect with `DATABASE_URL`. This database and its role are the only ones this project may change.",
  mysql: "MySQL: connect with `MYSQL_URL`. This database and its user are the only ones this project may change.",
  mariadb: "MariaDB: connect with `MARIADB_URL`. This database and its user are the only ones this project may change.",
  redis: "Redis is shared: read `REDIS_URL`, keep every key under `REDIS_PREFIX` (a client with a `keyPrefix` already adds it), and never run `FLUSHALL`, `FLUSHDB` or `KEYS *`. Keys can be evicted: keep nothing there that you cannot rebuild.",
  meilisearch: "Meilisearch is shared and the key is the master key: read `MEILISEARCH_URL` and `MEILISEARCH_API_KEY`, and start every index with `MEILISEARCH_INDEX_PREFIX`.",
  rabbitmq: `RabbitMQ is shared, on the \`/\` vhost: read \`RABBITMQ_URL\`, and start every queue and exchange with \`${name}.\`.`,
  mailpit: "Send mail through `SMTP_HOST` and `SMTP_PORT`: Mailpit catches it, nothing leaves this machine.",
});

const fence = (commands: string[]) => ["```sh", ...commands, "```"];

/**
 * Instructions for coding agents. AGENTS.md is the source: Codex, Grok and Claude Code read it.
 * Skills go in `.agents/skills` for Codex and `.claude/skills` for Claude Code, which Grok also reads.
 */
export function agentFiles({ name, stack, checks, layout, rules, feature, services, docker }: AgentOptions): Record<string, string> {
  const addFeature = [
    "---", "name: add-feature",
    `description: Use when adding a feature, resource, route, service or package to ${name}. Gives the steps of this ${stack} project.`,
    "---", "", "# Add a feature", "",
    ...feature.map((step, index) => `${index + 1}. ${step}`), "",
    ...(docker ? ["Run these commands in the `app` container, as AGENTS.md says.", ""] : []),
    "Then use the `project-checks` skill.", "",
  ].join("\n");
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
        "It runs in Docker. Run the checks and the tools of the project in the `app` container:", "",
        ...fence([`docker compose -p devhub-${name} exec app <command>`]), "",
        "Never install dependencies on the host: their folder is a Docker volume, and the host copy stays empty.",
        "Add dependencies with the tool of the project, in the container: a manifest edited by hand leaves the lockfile stale, which can stop the container at start.", "",
      ] : ["It runs on this machine, in a systemd service.", ""]),
      "## Check a change", "",
      ...fence(checks), "",
      "## Layout", "",
      ...layout.map((item) => `- ${item}`), "",
      "## Rules", "",
      docker ? "- Keep `/health` working." : "- Keep `/health` working: DevHub uses it to know the project is up.",
      "- Read configuration from the environment. Never commit `.env`.",
      "- Pin exact dependency versions.",
      "- To add a feature, use the `add-feature` skill.",
      ...[...rules, ...services.map((service) => serviceRules(name)[service]!)].map((rule) => `- ${rule}`),
      "",
    ].join("\n"),
    ".claude/settings.json": `${JSON.stringify({ permissions: { allow: checks.map((command) => `Bash(${docker ? `docker compose -p devhub-${name} exec app ` : ""}${command}:*)`) } }, null, 2)}\n`,
    ".claude/skills/project-checks/SKILL.md": skill,
    ".agents/skills/project-checks/SKILL.md": skill,
    ".claude/skills/add-feature/SKILL.md": addFeature,
    ".agents/skills/add-feature/SKILL.md": addFeature,
  };
}
