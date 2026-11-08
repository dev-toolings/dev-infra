# DevHub local manager

DevHub keeps the shared infrastructure CLI and adds a local project manager. The
manager operates on projects in their existing folders. It is a local
development tool, not a hosted service or a hostile-code sandbox.

## Install and setup

From a checkout, run:

```sh
data/scripts/install.sh
devhub setup
```

The installer requires Bun and installs the locked project dependencies. It
does not install system packages or use sudo. State is stored under
`$XDG_STATE_HOME/devhub` when that variable is an absolute path, otherwise under
`~/.local/state/devhub`. Uninstall removes the CLI shell integration only. Stop
applications before uninstalling; projects, state, native units, and running
applications are not removed by uninstall.

## Approve and register projects

Add only workspace roots you trust. Discovery reads known metadata and does not
run project scripts, Make targets, hooks, or builds.

```sh
devhub root add ~/code --label workspaces
devhub project discover ~/code
devhub presets
devhub project add --path ~/code/store --name store --preset compose-existing
devhub project add --path ~/code/store --name store --preset compose-existing --apply
devhub project list
devhub project show store
```

Project add without `--apply` prints a preview. Interactive additions prompt
for missing values in a terminal. Use `--group` to select detected folders for
one local project. A trusted local JSON configuration can be registered with
`project add --file PATH --apply`; component directories must remain inside the
registered project root. Removing a project unregisters it and does not remove
its files or stop its services.

## Create a project

Create a project from the panel page `/projects/new`, or from the CLI. Both use the
same catalog of stacks and options. The stacks are `node`, `python` and `php`. A preview
shows what will change first: the page updates it as you fill the form.

```sh
devhub new node shop --root ~/code                      # preview, changes nothing
devhub new node shop --root ~/code --apply              # Docker, Bun, modular structure
devhub new node shop --root ~/code --mode native --option runtime=node,orm=drizzle \
  --service redis,mailpit --apply
devhub new python api --root ~/code --option pattern=standard --service postgres --apply
devhub new php site --root ~/code --option framework=laravel --apply
```

`--service` takes `postgres`, `mysql`, `mariadb`, `redis`, `meilisearch`, `rabbitmq` and
`mailpit`, with an optional version: `--service postgres@17,redis`. Without one, the
project uses the shared container. Another version runs in its own instance
(`infra-postgres-17`), started on demand, with its own volume and a free port from 15000;
its Compose file stays in the state directory, under `services/`. Projects on the same
version share that instance.

The project gets its connection in its environment: `DATABASE_URL`, `MYSQL_URL`,
`MARIADB_URL`, `REDIS_URL`, `RABBITMQ_URL`, `MEILISEARCH_URL`, `MEILISEARCH_API_KEY` and
`SMTP_HOST`. PostgreSQL, MySQL and MariaDB get a private database and user. The generated
code has a client only for PostgreSQL, Redis and Mailpit.

`--root` must be an approved folder (`devhub root add`, or the folder picker of the
page). The project is created in a new folder named after it.

Every project includes `AGENTS.md`, read by Codex, Grok and Claude Code, with the rules of
its framework, runtime, mode and services,
`.claude/settings.json`, and the `project-checks` and `add-feature` skills in `.claude/skills`
and `.agents/skills`.

The page shows every file before creation: click one in the tree to read it. The
Dockerfile tab also customizes the Docker image: base image, system packages, PHP extensions,
or the whole Dockerfile. New Docker projects keep their Dockerfile at their root, and it runs
on this machine when the image builds. What confines the container stays in a Compose
file DevHub manages: non-root user, no capabilities, ports on this machine only.

The generated Dockerfile declares what can change as `ARG` at its top or above the line that
uses it: image versions (`PHP_VERSION`, `NODE_VERSION`, `PYTHON_VERSION`, `BUN_VERSION`,
`FRANKENPHP_VERSION`, `COMPOSER_VERSION`), `DEBIAN_RELEASE`, `SYSTEM_PACKAGES` and
`PHP_EXTENSIONS`. An image DevHub cannot split stays whole in `BASE_IMAGE`. The Dockerfile tab
edits them beside the file, along with the variables of the container and new ones. `HOST`,
`PORT`, service addresses and secrets stay with DevHub. Add a secret, or a value with spaces,
quotes, `#` or `$`, to `app.env` after creation.
To change an `ARG` after creation, edit it in the Dockerfile and rebuild: a changed Dockerfile
also reinstalls the dependencies.

Every project gets a `Makefile` grouped by section: `make help` lists the targets, `make check`
runs the checks of the stack. In Docker its commands run in the `app` container, which has to be
started; `DEVHUB` and `EXEC` can be overridden.

The Dockerfile has three stages. `base` holds what never differs: runtime, system packages, PHP
extensions. `dev` is what DevHub runs, with the project mounted. `prod` adds the code and the
production dependencies, and runs as UID 1000: `docker build --target prod .` gives the image
for preprod and prod, which differ only by their variables. It needs the lockfile that the first
start writes. A whole Dockerfile without a `dev` stage is built as it is.

| Stack | Option | Values (default first) |
|---|---|---|
| `node` | `framework` | `hono` |
| `node` | `runtime` | `bun`, `node` (npm) |
| `node` | `pattern` | `modules` (`domain`, `application`, `infrastructure`), `standard` (`routes`, `schemas`, `services`, `middleware`). Both ship a `notes` REST example, Zod validation, JSON errors and request logs. With Drizzle, `notes` uses Postgres, after `db:generate` and `db:migrate` |
| `node` | `orm` | `none`, `drizzle` (selects Postgres) |
| `node` | `nodeVersion` | `24`, `26` (Docker, with `runtime=node`) |
| `python` | `framework` | `fastapi` |
| `python` | `pattern` | `modules`, `standard`. Same `notes` example, JSON errors and request logs as Node |
| `python` | `orm` | `none`, `sqlalchemy` (selects Postgres; `notes` needs `uv run alembic upgrade head`) |
| `python` | `pythonVersion` | `3.14`, `3.13` (Docker) |
| `php` | `framework` | `symfony`, `laravel` |
| `php` | `phpVersion` | `8.5`, `8.4` (Docker) |
| `php` | `symfonyVersion` | `7.4` (LTS), `8.1` |
| `php` | `pattern` | `standard` (the framework layout), `modules`. Same JSON errors and request logs as Node, with no example resource |
| `php` | `symfonyOrm` | `none`, `doctrine` (selects Postgres) |
| `php` | `symfonyApi` | `none`, `api-platform` (the API under `/api`, its docs at `/api/docs`, CORS) |
| `php` | `laravelOrm` | `none`, `eloquent` (selects Postgres) |

Services are `postgres`, `redis` and `mailpit`. Every project has a `/health` route and
exact dependency versions. Node projects use strict TypeScript, Zod for configuration and
Biome. Python projects use uv, typed settings, Ruff, mypy and pytest. PHP projects use
Composer, PHPStan and Pest, with PHP-CS-Fixer and `phpstan-symfony` on Symfony, Pint and
Larastan on Laravel. They start from an API of their own, not the full framework skeleton.

Symfony and Laravel keep their official environment files and variable names. Symfony
commits `.env` with defaults and keeps the values of the machine in `.env.local`. Laravel
commits `.env.example` and keeps them in `.env`, where `DB_URL`, `REDIS_HOST` and `MAIL_HOST`
replace the `DATABASE_URL`, `REDIS_URL` and `SMTP_HOST` of the other stacks.

PHP projects run on FrankenPHP in Docker: Symfony in worker mode, Laravel under Octane. Both
restart their workers on a code change. A custom base image has to be a `dunglas/frankenphp`
Debian tag; a whole Dockerfile stays free. In native mode, PHP projects use the PHP built-in server.

Native mode needs the stack's tools on this machine: `uv` for Python, `php` and `composer`
for PHP, with `pdo_pgsql` when it uses Postgres. Docker mode needs none of them. Choosing a service provisions it and sets its
environment variables. Node, Python and PHP add their Postgres, Redis and mail clients,
and report Postgres and Redis in `/health`. The clients of other services are yours to write.

| Mode | Runs in | Generated environment |
|---|---|---|
| `docker` | The isolated container described under import | `$STATE/imports/<id>/app.env` |
| `native` | A user systemd service, with no isolation from your session | `.env` in the project, mode 600, ignored by Git |

Both modes get a dedicated port and, with Postgres, a private database and role.
Native mode needs Linux and the runtime on your machine.

## Import a Hono project

`devhub import` runs a Hono project that has no Compose file, in dev mode, in one
step. The project must sit inside an approved root.

```sh
devhub root add ~/code --label workspaces
devhub import ~/code/api             # preview, changes nothing
devhub import ~/code/api --apply     # provision, register and start
devhub project logs api
```

The preview shows the image, install and dev commands, URL, database and the
variables you still have to fill in. With `--apply`, DevHub:

- writes `compose.yml`, `app.env` and the image files under
  `$STATE/imports/<id>/`, never in the repository (`app.env` holds the secrets,
  mode 600; edit it to fill in the listed variables, then restart the project);
- reads `.env.example` for defaults and never reads your `.env` (the mounted
  `.env` stays visible to the app, generated variables take priority);
- creates a Postgres database and role `dh_<id>` when the project uses Postgres;
  only that role can connect to that database;
- starts the app as your user, with no Linux capability, with only the project
  mounted and without the Docker socket;
- keeps `node_modules` in a volume, leaving an empty `node_modules` folder in the
  project (a host `node_modules` stays on disk but is hidden from the container),
  and installs again only when `package.json` or the lockfile
  changes.

Each imported project gets its own network, `devhub-<id>-<hash>`, and only the shared services
it uses join that network: imported projects cannot reach each other. Docker
connects those `infra-*` containers to the network on every project start and on
`devhub up`.

Limits: bun and npm projects only (pnpm and yarn are refused), local paths only,
no `wrangler` or `vite` dev script, and no Compose file in the project (use
`project add`). RabbitMQ and Meilisearch
are not provisioned. Redis gets a `REDIS_PREFIX`, which is a convention and not an
access control, as the Redis default user stays open. The Postgres admin login
stays reachable from the project network: if `.env` keeps the default password,
an imported project can use it. `project remove` leaves the
containers, network, database and generated files in place.

## Operate projects

```sh
devhub project start store
devhub project status store
devhub project check store
devhub project logs store --limit 100
devhub project restart store --component backend
devhub project stop store
```

Project operations apply only to registered components. Startup follows
component dependencies. If a component fails to start, components already
started remain running for diagnosis. Docker operations require a verified
local Unix-socket context. Native processes use the current user's systemd and
D-Bus session. Project `.env` may set `COMPOSE_PROJECT_NAME` and
`COMPOSE_PROFILES`; other execution-changing `COMPOSE_*` values are refused.

## Worktrees for parallel agents

A worktree runs another branch of a project DevHub runs in Docker (created with `devhub new`
in Docker mode, or imported), beside the project and at the same time. Each agent works in
its own folder, on its own port and its own copy of the database.

```sh
devhub worktree add shop fix/auth             # preview, changes nothing
devhub worktree add shop fix/auth --apply     # check out, copy, start
devhub worktree add shop spike --expire 48 --apply
devhub worktree list
devhub exec shop--fix-auth -- bun test
devhub worktree remove shop--fix-auth         # --force drops uncommitted work
```

`add` creates the branch from the current `HEAD` when it does not exist, and checks it out
in `<parent folder>/<project>.worktrees/<slug>`, where the slug is the branch in lowercase
with dashes (`fix/auth` gives `fix-auth`); that folder must stay in an approved root. The
worktree is a project of its own, `shop--fix-auth`, with a free port from 4100, its own
`app.env`, its own Compose project and network, and a private database copied from the one of
its parent with `pg_dump` (the copy belongs to the role of the worktree). A project on MySQL or
MariaDB gets no worktree: only Postgres is copied. In `app.env`, the URL of the parent
(`APP_URL`, `DEFAULT_URI`) becomes the one of the worktree, and the Redis and Meilisearch
prefixes get the worktree ID. The shared services stay shared.

A worktree nobody started, stopped or ran a command in for 24 hours is stopped by
`devhub serve`, which checks every 15 minutes. With `--expire HOURS` it is removed once that
time is over, unless it has uncommitted changes. Otherwise it stays until `worktree remove`,
which stops it, removes its containers and network, drops its database and role, removes its
folder and keeps its branch. DevHub
never deletes a named volume: `remove` prints the dependencies volume to delete by hand. The
panel shows a worktree after its parent; `project remove` refuses it, since unregistering
alone would leave its database and folder.

`devhub exec PROJECT -- COMMAND` runs `sh -c COMMAND` in the `app` container of a project
DevHub runs in Docker, never on this machine. A single word after `--` is a command line
(`-- "bun test && bun run lint"`); several words are quoted one by one, so
`-- grep "a b" src` searches for `a b`. The default timeout is 120 seconds (`--timeout`, at most 3600).

## Names with Caddy

The `proxy` profile runs Caddy in `infra-caddy`. It gives every project with a local URL a
name: `http://shop.localhost`, and `http://fix-auth.shop.localhost` for a worktree.
Browsers resolve `*.localhost` to this machine without any DNS setting.

```sh
devhub up --with proxy
devhub proxy sync
```

Caddy uses the host network to reach the projects on `127.0.0.1`, and binds port 80
(`CADDY_HTTP_PORT`) and its admin API (`CADDY_ADMIN_PORT`, 2019) on loopback only. DevHub writes
`data/caddy/sites/devhub.caddy` in its checkout and reloads Caddy after `worktree add` and
`remove`; `devhub serve` syncs it every 15 minutes, and `proxy sync` does it at once. The
sites are not HTTPS.

## MCP server for agents

`devhub mcp` serves the Model Context Protocol on stdio, so an agent drives its own worktree.
Its tools: `projects_list`, `worktree_add`, `worktree_remove`, `project_action`,
`project_status`, `project_logs` and `exec`. It runs as your user, like the CLI, so it takes
no pairing code: any process that can start it can already run `devhub`. Secrets in command
output and errors are redacted.

```sh
claude mcp add devhub -- devhub mcp
```

## Maintenance

```sh
devhub maintenance inventory
devhub maintenance scan sha256:LOCAL_IMAGE_ID
devhub maintenance scans
devhub maintenance preview --project store --component backend \
  --file compose.yml --service app --replacement example/app:2.4
devhub maintenance apply CHANGE_ID
devhub maintenance validate CHANGE_ID
devhub maintenance activate CHANGE_ID
```

Scanning uses an explicitly selected local image and an installed scanner. It
does not install scanners, log into registries, or upload images. A scan result
does not prove a vulnerability was fixed. Source changes are reviewed before
apply; validation and activation are separate explicit steps. Unsupported or
unsafe validation fails instead of reporting success.

## Machine output and controller

Add `--json` to supported manager commands for stable JSON output. JSON
projections omit execution arguments and environment contents. `devhub serve`
binds only to loopback and does not create a pairing code. Run `devhub pair`
explicitly to create a one-time code. The development UI origin is trusted only
when passed explicitly, for example:

```sh
devhub serve --dev          # same as --dev-origin http://localhost:5175
bun run web:dev             # second terminal: Vite on http://localhost:5175
devhub pair                 # third terminal: one-time code for the panel
```

`localhost` and `127.0.0.1` are accepted for the same loopback port. Without
`--dev`, build the panel once with `bun run web:build` and `devhub serve` serves
it on `http://localhost:8040`.

The control panel is not exposed on the network. Pairing codes and credentials
must not be copied into shell history or shared logs.

To reach a panel running on another machine, forward its port over SSH and keep the
same local port, because any other `Host` is refused:

```sh
ssh -L 8040:127.0.0.1:8040 you@server
```

The folder picker of the panel lists the folders of the machine running DevHub, never
those of the machine running the browser, so it works the same in both cases. A
paired session can browse folder names on the whole disk, except protected DevHub
data. Dot folders and symbolic links are not listed: type their path instead. The
disk root cannot be approved.

The manager runs on Linux, which includes WSL2 (Windows drives are under `/mnt/c`).
It does not start on macOS or native Windows yet: the catalog reads `/proc`, the state
checks need `process.getuid`, and `bin/devhub` needs Bash.

## Check pinned versions

`devhub versions` checks every version DevHub pins (`data/versions.json` and the images
of `compose.yml`) and exits 1 when one is past its end of life, has a known advisory, or
could not be checked.
The panel shows the same report under Maintenance, Versions. It needs Go on this machine.

```sh
devhub versions          # versions to look at
devhub versions --json   # the full report
```

| Source | Used for |
|---|---|
| endoflife.date | end of support and LTS, for runtimes, services, Symfony and Laravel |
| OSV.dev | CVEs and advisories of npm, PyPI and Packagist packages |
| npm, PyPI, Packagist | latest release of each package |

Only package names and versions leave the machine. This checks what DevHub pins, not the
dependencies of your projects, and advisories cover packages only: to find CVEs inside a
Docker image, use the image scans of the same page. A source that fails shows as Unknown,
never as up to date. To move a version, edit `data/versions.json`.

`bun run check:scaffolds [node|python|php]` generates each code option of the catalog, bare
and with services, and runs the checks of each new project. The `update-scaffolds` skill gives agents the whole
procedure, from pins to official practice.

## Existing infrastructure commands

The existing Bash commands remain available without Bun:
`devhub up`, `down`, `restart`, `ps`, `logs`, `open`, `db`, `doctor`, `version`,
and `help`. `devhub infra COMMAND ...` forwards to the same Bash implementation.
The shared Compose project, service names, ports, volumes, and external network
remain managed by those existing commands.
