# Changelog

All notable changes to DevHub are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New FastAPI projects start with the same base as Hono projects: a `notes` example to copy,
  one JSON error shape, request ids, readable request logs, `/health` with its dependencies,
  tests, type checks and lint, in both code structures, with optional SQLAlchemy and Alembic.
- New Symfony and Laravel projects get that base without an example resource, in both code
  structures, with optional Doctrine or Eloquent. `standard` is their default structure.
- Symfony projects can start with API Platform: resources under `/api`, docs at `/api/docs`,
  CORS, with Doctrine or with providers and processors of their own. The errors of a
  resource stay in its own format.
- Symfony and Laravel projects keep their official environment files and variable names: a
  committed `.env` and a local `.env.local` for Symfony, `.env.example` and `.env` for Laravel.
- PHP projects run on FrankenPHP in Docker, Symfony in worker mode and Laravel under Octane,
  and reload on a code change. A custom base image has to be a Debian `dunglas/frankenphp` tag.
- New Hono projects start with a complete architecture in both code structures: chained
  REST routes with a `notes` example to copy, Zod request validation, one JSON error shape,
  request ids, secure headers, Pino request logs and an exported `AppType` for typed clients.
  `modules` stays the default, and adds domain, application and infrastructure layers with
  a repository port. With Drizzle, `notes` is stored in Postgres in both structures.
- The file preview of a new project shows a Markdown file rendered or as code, with colors
  that follow the type of each file.
- The create form starts with the stack, then the name and folder, and its file preview shows
  from the start, under a stand-in name until the project has one.
- `AGENTS.md` can be edited in the file preview of a new project, and the
  Layout section of `AGENTS.md` is now a bullet list in every stack.
- The `AGENTS.md` of a new project now carries the rules of its framework, runtime, ORM, mode
  and services: the exact command for the `app` container, what Symfony and Laravel leave out
  here, and how to share Redis, Meilisearch and RabbitMQ.
- New projects include an `add-feature` skill with the steps of their stack and code structure.
- `bun run check:scaffolds` generates each code option of the catalog, bare and with
  services, and runs the checks of each new project, and the `update-scaffolds` skill keeps the templates current.
- Folder picker in the panel: `GET /api/v1/directories` lists the subfolders of the
  machine running DevHub, so a folder can be browsed and approved from the create and
  add project forms, locally or through an SSH tunnel. The path stays editable.
- Project pages in the panel: `/projects` is now a grid of cards with the state of each
  project, and `/projects/:id` is a page of its own with a breadcrumb and project
  switcher, one state for the whole project, Start, Stop and Restart for all its
  components, aligned component rows, and two tabs for live logs and recent operations.
- `GET /api/v1/projects/:id/operations` returns the 20 newest operations of a project.
- MariaDB as a shared service (`infra-mariadb`, port 3307).
- New projects can use MySQL, MariaDB, Meilisearch and RabbitMQ, and choose the version of
  each service, in the panel or with `--service postgres@17`. Another version runs in its
  own instance, with its own volume and port, shared by the projects on that version.
- `devhub versions` and the Versions tab of the Maintenance page report end of life, LTS,
  CVEs and new releases for every version DevHub pins, from a small Go tool in
  `tools/versionwatch`. Pinned versions now live in `data/versions.json`.
- New projects can use Python (FastAPI with uv) and PHP (Symfony 7.4 LTS or Laravel), in Docker
  or native mode, from the panel and from `devhub new`.
- New projects include instructions for coding agents: `AGENTS.md`, `.claude`
  and `.agents`. The creation page lets you read every generated file before creating.
- New project page redesigned as a workshop: steps on the left, and on the right the
  Dockerfile, Compose file and variables DevHub will write, updated as you type and with
  syntax colors. You can choose release lines (LTS, latest, others) and customize the
  Docker image, or edit the Dockerfile, which now lives at the root of the project.
- State colors follow the BoardUI status tokens, and `DESIGN.md` lists the light and
  dark color values. Stopped projects and containers are now yellow, not gray.
- Control panel in English and French, following the browser, with a switch in the
  session menu.
- Project creation: a `/projects/new` page in the panel and `devhub new STACK NAME
  --root PATH` create a project in Docker or native mode and start it. Node.js with
  Hono comes first (Bun or Node, modular or standard structure, Drizzle, Postgres,
  Redis, Mailpit). Parent folders can now be approved from the panel.
- `devhub import PATH [--apply]`: run a Hono project (bun or npm) with no Compose
  file in a generated dev container. It installs dependencies in the container,
  watches for changes, and gives the project its own Postgres role and database,
  its own Docker network joined only by the shared services it needs, and a free
  loopback port. Generated files stay in the state directory.
- Live Docker logs in the container detail panel, now a wide side panel, with
  `?state=` filters on `/containers`; `make dev` and `make pair`.
- Foundation for the approved local DevHub manager: shared TypeScript contracts,
  Bun dependencies, React/Vite tooling and isolated worker implementation branches.
- Local project manager: SQLite catalog of approved roots and in-place projects,
  static discovery with presets (`symfony-docker`, `laravel-docker`,
  `node-docker`, `compose-existing`, `native`, `custom`), Compose and user
  systemd runtimes, dependency-aware operations with merged redacted logs,
  `root`/`project`/`maintenance` CLI commands, an authenticated loopback API
  (`devhub serve`, `devhub pair`) and a connected React control panel.

### Changed
- New Symfony and Laravel projects test with Pest in place of PHPUnit, and Symfony projects
  add `phpstan-symfony` to PHPStan. Their `AGENTS.md` now states the PSR, PHPDoc, PHPStan and
  Pest rules.
- Action and refresh failures in the panel now appear as one toast per source in the
  bottom right corner, instead of banners and a repeated error on each recent operation
  row. Hover a row to read its error.
- Control panel restyled on the shared design system: neutral tokens, local
  Inter font, floating collapsible sidebar, page header bar, light/dark/system
  theme in the session menu (which now holds Log out), colored status badges
  and the radar favicon. Radix primitives now come from the `radix-ui` package.
- Control panel loading states are page-shaped skeletons (shell, projects, project
  detail, containers, logs, scans) instead of generic rows; component status,
  readiness and the scan image selector show placeholders while they load, and the
  log view shows a connecting state until the stream opens. `DESIGN.md` now
  documents the control panel design system.
- Project page: components and operations are compact full-width rows, with
  state-aware actions and direct links to the logs and the app. The add-project dialog
  is shorter, with a scrollable list of detected folders.
- `devhub serve --dev` restarts the API when a source file changes, so the panel
  and the API stay on the same code.
- `devhub serve --dev` (and `--dev-origin`) now starts the Vite panel server
  itself, reuses one already answering on the dev origin, and stops it with the
  controller. The Vite proxy follows `--port` through `DEVHUB_API_PORT` instead of
  always targeting 8040.
- Control panel pages have their own URLs (`/projects/:id`, `/containers`,
  `/logs/:id`, `/maintenance`, `/maintenance/remediation`) with working reload,
  new tab and back/forward. Containers and image scans are now filterable
  inventories: stat tiles that filter, search, one table, and a detail sheet for
  IDs, ports and findings. The image selector that listed every image with all
  its containers is replaced by a per-image Scan action. Stopped containers no
  longer count as unhealthy from their last health result.
- `devhub up` / `devhub restart` now start the `async` profile (RabbitMQ) by
  default alongside `core`. Projects relying on AMQP no longer crash-loop after
  a plain `devhub up`. `make up-async` remains an alias of `make up`.
- Limit DevHub to its eight shared services; remove application templates, agent
  generation, project/worktree commands, runtime commands and the Node profile.
  Remove the obsolete local overrides, generated Docker files and project registry
  after explicit approval, including their unused directories and ignore rules.
- Make the Redis ACL path configurable, persist RabbitMQ node identity, pin
  formerly floating latest images and rotate container logs (3 files of 10 MiB).
- Resolve UI and diagnostic ports from Compose; return failure from diagnostics
  for missing or unhealthy services without creating the network.

### Fixed
- The check of new PHP projects no longer fails on publishing rules: they are private
  projects, so it runs `composer validate --no-check-publish`.
- Native units put `StartLimitIntervalSec` and `StartLimitBurst` in `[Unit]`: systemd
  ignored the interval and logged a warning at each status check, which showed up as
  project logs. A project stops logging it at its next start.

## [0.0.3] - 2026-07-18

### Added
- Mission lanes on top of worktrees, kept as derived state (no separate
  manifest): `devhub wt add` gains `--group <slug>` (tag lanes of one mission)
  and `--owns <glob[,glob]>` (declare a lane's file fence). `wt list` gains
  `--group` filtering and exposes `group`/`owns` in `--json`.
- `devhub wt conflicts <project> [--group <slug>] [--against <ref>] [--json]`:
  read-only, stateless conflict oracle. For each lane it diffs changed files
  against a base ref and reports overlaps (same file touched by two lanes),
  out-of-scope changes (outside the lane's `--owns` fence), and migrations
  touched by more than one lane. Exit `6` when conflicts are detected.

### Changed
- Worktree registry lines are now a fixed 7-column format
  (`slug|port|branch|path|app_ports|group|owns`); existing 4/5-column entries
  remain readable (missing columns are treated as empty).

## [0.0.2] - 2026-07-10

### Added
- `devhub project adopt <path>`: one-shot migration of an existing Git checkout
  into a worktree hub: stack auto-detection (root and `apps/*`/`packages/*`
  workspaces), bare clone, project registration, `main` worktree, untracked
  env-file carry-over, and a generated `CLAUDE.md`/`AGENTS.md` agent guide at
  the hub root (one worktree per terminal/agent via `devhub wt add`).
- Multi-app worktree runtime: monorepos with several bun/python apps are
  adopted as one project (`PROJECT_APPS` registry field, `templates/multi/`
  polyglot image). Each worktree gets one port per app, per-app env rendering,
  and cross-app URL injection (`DEVHUB_<APP>_URL`, `API_URL`,
  `NEXT_PUBLIC_API_URL`); `wt add`/`wt list --json` expose the `apps` map.
- Generated agent workspace (`templates/claude/`, rendered by both
  `project init` and `project adopt` at the hub root): `CLAUDE.md`/`AGENTS.md`
  worktree rules, `.claude/agents/` (implementer, implementer-ui/-backend/
  -tests, security-review, perf), `.claude/skills/orchestrate` and
  `orchestrate-fast` (one implementation lane = one worktree), and
  `.claude/settings.json` with a devhub command allowlist.
- Generated hub `Makefile` (project name baked in): `run`, `stop`, `status`,
  `ls`, `urls`, `add BRANCH=`, `rm SLUG=`, `logs`, `pull-main`,
  `pr BRANCH=`; new dev-infra Makefile targets `adopt`, `wt-add`, `wt-rm`,
  `wt-status`, `test`.
- Multi runtime hardening: the override publishes only allocated ports
  (re-rendered on `wt add`/`wt rm` with container recreate) instead of the
  whole project range, so a busy host port inside the range no longer blocks
  the container; the runtime runs as the host UID/GID so `node_modules`,
  `.venv` and build output stay removable by `wt rm` on the host.

## [0.0.1] - 2026-07-10

### Added
- First tagged release: shared Docker development infrastructure (`compose.yml`),
  the `bin/devhub` CLI, project/worktree tooling, and the remote installer.
- Versioned release system: `VERSION` source of truth, `devhub version` command,
  `data/scripts/release.sh`, and the `Release` GitHub Actions workflow.

[Unreleased]: https://github.com/dev-toolings/dev-infra/compare/v0.0.3...HEAD
[0.0.3]: https://github.com/dev-toolings/dev-infra/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/dev-toolings/dev-infra/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/dev-toolings/dev-infra/releases/tag/v0.0.1
