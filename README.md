# DevHub

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Bash](https://img.shields.io/badge/Shell-Bash-4EAA25?logo=gnubash&logoColor=white)
[![Docs](https://img.shields.io/badge/docs-makfly.github.io%2Fdev--infra-blueviolet)](https://makfly.github.io/dev-infra/)

**Shared local Docker infrastructure: PostgreSQL, MySQL, Redis, Meilisearch,
Mailpit, Adminer, Dozzle and RabbitMQ.**

DevHub is a Docker Compose development stack controlled by a single Bash CLI.
Instead of defining database, cache, mail, search, and queue services in every
project, you start them once with `devhub up` and connect any application through
a shared Docker network.

Full documentation: [makfly.github.io/dev-infra](https://makfly.github.io/dev-infra/)

The `feat/devhub` branch is also implementing a local project manager. This
work is in progress: the shared-infrastructure CLI above remains the working
entry point until the project modules are integrated.

The project manager keeps existing repositories where they are. You approve
workspace folders, register a project and describe its components. A project can
combine a Docker backend with a native frontend, or use an existing Compose
stack. The CLI and the optional React control panel use the same project
catalog and lifecycle engine.

Projects keep their own Dockerfiles, Compose configuration, application checks
and data. Shared DevHub services remain a separate infrastructure stack.
Registering a project does not move it, change its Compose identity or adopt
unmatched containers. Unregistering removes catalog metadata only.

Project-manager dependencies are installed with Bun using the committed lockfile.
Native process management targets Linux user systemd services. The controller
uses a loopback listener and a one-time local pairing code; project execution
runs trusted local code and does not provide a hostile-code sandbox. Image
maintenance is a separate, explicit workflow with a source preview, candidate
validation and activation of the exact validated image. A scan alone does not
prove that a vulnerability has been corrected.

## Table of Contents

- [Why DevHub](#why-devhub)
- [Services](#services)
- [Profiles](#profiles)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Database Management](#database-management)
- [Connecting External Projects](#connecting-external-projects)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Releasing](#releasing)
- [Security](#security)
- [License](#license)

Documentation sources live in `docs/` and use Tailwind CSS. Rebuild the
compiled stylesheet with:

```bash
bun install
bun run docs:build
```

Built for teams and solo developers working on multiple web applications, APIs,
or background workers that need common local infrastructure without per-project
duplication.

## Why DevHub

- **Start once, use everywhere**: share databases, cache, search, mail and queues.
- **Stable addresses**: fixed `infra-*` container names and configurable host ports.
- **Two profiles**: `core` and `async`, both started by `devhub up`.
- **Persistent data**: named volumes survive container replacement.

## Services

| Service | Container | Port(s) | UI | Profile |
|---|---|---|---|---|
| PostgreSQL 16 | `infra-postgres` | `5432` | - | core |
| MySQL 8 | `infra-mysql` | `3306` | - | core |
| Redis 7 | `infra-redis` | `6379` | - | core |
| Meilisearch | `infra-meilisearch` | `7700` | [localhost:7700](http://localhost:7700) | core |
| Mailpit | `infra-mailpit` | `1025` / `8025` | [localhost:8025](http://localhost:8025) | core |
| Adminer | `infra-adminer` | `9080` | [localhost:9080](http://localhost:9080) | core |
| Dozzle | `infra-dozzle` | `8888` | [localhost:8888](http://localhost:8888) | core |
| RabbitMQ 4 | `infra-rabbitmq` | `5672` / `15672` | [localhost:15672](http://localhost:15672) | async |

## Profiles

| Profile | Services | Default |
|---|---|---|
| `core` | PostgreSQL, MySQL, Redis, Meilisearch, Mailpit, Adminer, Dozzle | Yes |
| `async` | RabbitMQ | Yes |

```bash
devhub up                  # core + async (RabbitMQ)
```

## Requirements

- Docker Engine 24+ with Compose v2
- Bash
- `jq` (for `devhub open` and `devhub doctor`)
- Optional: `make`, `xdg-open` (Linux) or `open` (macOS)

## Installation

**One-liner** (installs the latest release to `~/.local/share/devhub`, no sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/dev-toolings/dev-infra/main/install-remote.sh | bash
```

Pin a specific version, or track the bleeding-edge `main` branch:

```bash
# exact release
DEVHUB_VERSION=v0.0.1 curl -fsSL https://raw.githubusercontent.com/dev-toolings/dev-infra/main/install-remote.sh | bash

# always-latest development branch (unpinned, not reproducible)
DEVHUB_VERSION=main  curl -fsSL https://raw.githubusercontent.com/dev-toolings/dev-infra/main/install-remote.sh | bash
```

`DEVHUB_VERSION` defaults to `latest` (newest published GitHub Release). If no
release exists yet, the installer falls back to `main` with a warning.

Custom install path:

```bash
DEVHUB_DIR=~/tools/devhub curl -fsSL https://raw.githubusercontent.com/dev-toolings/dev-infra/main/install-remote.sh | bash
```

**Manual** (if you prefer git clone):

```bash
git clone git@github.com:dev-toolings/dev-infra.git dev-infra
cd dev-infra
cp .env.example .env
make install
```

Both methods symlink the CLI to `~/.local/bin/devhub` and add zsh shortcuts
(`dh`, `dhup`, `dhps`, `dhdown`) via `~/.config/devhub/devhub.zsh`.

To skip shell integration, run the CLI directly:

```bash
./bin/devhub help
```

## Quick Start

```bash
devhub up               # start core + async services
devhub ps               # show container status
devhub doctor           # health, network, and port diagnostics
devhub open adminer     # open Adminer in browser
devhub db create myapp  # create a PostgreSQL database + role
```

## CLI Reference

| Command | Description |
|---|---|
| `devhub up [--with profile,...]` | Start shared services (default: `core,async`) |
| `devhub down` | Stop and remove all shared containers |
| `devhub restart [--with profile,...]` | Restart services |
| `devhub ps` | Show service status |
| `devhub logs [service]` | Follow logs |
| `devhub open <target>` | Open a service UI (`mailpit`, `adminer`, `dozzle`, `rabbitmq`, `meili`) |
| `devhub db create <db> [user] [pass]` | Create PostgreSQL database and role |
| `devhub db import [args]` | Run custom import script (`data/scripts/import-db.sh` or `DEVHUB_IMPORT_SCRIPT`) |
| `devhub db list` | List PostgreSQL databases |
| `devhub doctor` | Diagnostics: health, network, ports |
| `devhub help` | Show help |

**Make shortcuts:**

```bash
make up                          # start core + async
make up-async                    # same as `make up` (kept for compat)
make down                        # stop all
make ps                          # status
make doctor                      # diagnostics
```

## Database Management

```bash
devhub db create myapp                    # db=myapp, user=myapp, pass=myapp
devhub db create myapp myuser mypassword  # explicit credentials
devhub db list                            # list all databases
```

Default connection strings:

```text
PostgreSQL  postgres://test:test@localhost:5432/devhub
MySQL       mysql://test:test@localhost:3306/trading
Redis       redis://localhost:6379
Meilisearch http://localhost:7700
Mailpit     smtp://localhost:1025
```

## Connecting External Projects

Any Docker Compose project can reach DevHub services by joining the shared
network:

```yaml
# in your project's docker-compose.yml
networks:
  dev-shared-net:
    external: true
```

Then reference services by container name: `infra-postgres`, `infra-mysql`,
`infra-redis`, `infra-meilisearch`, `infra-mailpit`, `infra-rabbitmq`.

The existing `data/scripts/connect-project-network.sh <container>` helper can
connect a running application container to `dev-shared-net`. Application lifecycle
is managed in its own repository.

## Configuration

Copy `.env.example` to `.env` and override any default:

```bash
cp .env.example .env
```

Ports and service credentials are configurable; `MEILI_IMAGE` overrides the search image. Common variables:

```dotenv
POSTGRES_PORT=5432
MYSQL_PORT=3306
MYSQL_ROOT_PASSWORD=root
REDIS_PORT=6379
MEILI_PORT=7700
MAILPIT_UI_PORT=8025
```

### Redis ACL provisioning

`REDIS_ACL_FILE` is a path **inside the Redis container**, normally under `/data`
(the existing named volume). Leave it empty on a fresh local installation to use
Redis's built-in default user. This default permits unauthenticated access from
localhost and containers on the shared network.

For an ACL deployment, provision a private ACL file in that volume, readable by
the Redis user, then set `REDIS_ACL_FILE=/data/users.acl` in the ignored `.env`.
Do not commit ACL contents or credentials. A configured missing or invalid file
must fail startup; DevHub never silently disables it or creates replacement rules.
Existing deployments must keep their current path and users. Changing users with
`ACL SETUSER` requires `ACL SAVE` for persistence when using an external ACL file
([Redis ACL documentation](https://redis.io/docs/latest/management/security/acl/)).
The default health probe requires that the default user can execute `PING`.

### RabbitMQ identity and logs

RabbitMQ uses hostname `infra-rabbitmq`, node `rabbit@infra-rabbitmq` and the
existing `/var/lib/rabbitmq` volume. Keep that identity when recreating a container;
changing it can select an empty node directory. No temporary override is needed.

All eight services use `json-file` logs with at most three files of 10 MiB each.
Mailpit, Adminer and Dozzle are pinned to the versions and image digests observed
on this host, without an upgrade. These settings apply on a later container
recreation, not to containers already running.

The local consolidation inventory and pending application changes are recorded
in [the maintenance report](docs/maintenance.md).

### Validation

```bash
for script in bin/devhub install-remote.sh data/scripts/*.sh; do bash -n "$script"; done
shellcheck -x --severity=warning bin/devhub install-remote.sh data/scripts/*.sh
for profiles in core async core,async; do
  COMPOSE_PROFILES="$profiles" docker compose --env-file .env.example -f compose.yml config --quiet
done
bats tests
```

The project-manager source has separate static and backend checks:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test src
python3 tests/infra-contract.py
```

These checks do not start the controller, compile the frontend or recreate
containers. The infrastructure contract renders the retained profiles and
compares names, ports, mounts, network and RabbitMQ identity with the baseline.

Install ShellCheck and Bats to run these checks. CLI tests simulate Docker and
never change running services. `doctor` returns nonzero for missing, stopped,
starting or unhealthy services and missing networks, while still printing ports.
Services without a healthcheck are accepted when running.

## Troubleshooting

```bash
devhub doctor          # full diagnostics
devhub ps              # container status
devhub logs postgres   # follow a single service
```

- **Network missing**: `devhub up` and `devhub db create` create `dev-shared-net`.
  `devhub doctor` only inspects it and returns a failure when it is missing.
- **Port conflict**: edit `.env` and change the matching `*_PORT` variable.

## Releasing

DevHub follows [Semantic Versioning](https://semver.org/). The `VERSION` file at
the repo root is the single source of truth; `devhub version` prints it.

Cut a release from a clean `main`:

```bash
make release              # patch bump: 0.0.1 -> 0.0.2 (default)
make release BUMP=minor   # 0.0.x -> 0.1.0
make release BUMP=major   # 0.x.y -> 1.0.0
make release BUMP=1.0.0   # explicit version

# preview without touching anything
./data/scripts/release.sh patch --dry-run
```

The script bumps `VERSION`, commits `chore(release): vX.Y.Z`, creates an
annotated `vX.Y.Z` tag, and (after confirmation) pushes. Pushing the tag triggers
the `Release` workflow, which verifies the tag matches `VERSION`, builds a
tarball, and publishes the GitHub Release with auto-generated notes. Document
user-facing changes in `CHANGELOG.md`.

## Security

This stack is for **local development only**. Default credentials in
`.env.example` are intentionally simple. `.env` is gitignored and stays local.
Dozzle mounts the Docker socket for log access. Named volumes hold developer
data: do not remove them unless you want to delete local databases.

## License

MIT
