# Shared infrastructure consolidation

Initial consolidation observed on 2026-10-28. That step prepared the repository and local configuration.
During that initial step, no running container was recreated, no volume was removed and no database was
modified. This is local development infrastructure; production deployments were
not changed or queried.

## Retained contract

Eight containers: `infra-postgres`, `infra-mysql`, `infra-redis`,
`infra-meilisearch`, `infra-mailpit`, `infra-adminer`, `infra-dozzle`,
`infra-rabbitmq`. Profiles remain `core` and `async`; both start by default.
The network remains external `dev-shared-net`.

| Existing volume | Container destination |
|---|---|
| `dev-infra_infra_postgres_data` | `/var/lib/postgresql/data` |
| `dev-infra_infra_mysql_data` | `/var/lib/mysql` |
| `dev-infra_infra_redis_data` | `/data` |
| `dev-infra_infra_meili_data` | `/meili_data` |
| `dev-infra_infra_mailpit_data` | `/data` |
| `dev-infra_infra_rabbitmq_data` | `/var/lib/rabbitmq` |

Compose volume keys and project naming are unchanged. Existing host bindings,
mount destinations and the shared network were compared with the running
containers and the configuration before editing. All match. Dozzle retains its
existing Docker socket mount.

## Redis

The active ACL file is `/data/scrap-agent-users.acl`, persisted in the existing
Redis volume with mode `0600`, owned by Redis. Its two rules match the active ACL
rules. Neither file contents nor credentials were added to this repository.

The ignored local `.env` now explicitly sets
`REDIS_ACL_FILE=/data/scrap-agent-users.acl`. The previous local Compose modification
is preserved through this setting. The repository contains no provisioner for
this historical file; the original provisioning command was not recovered.
Provisioning is external to DevHub: supply a readable private file in the volume
before setting the path. A missing configured file must fail startup.

Fresh installations use an empty `REDIS_ACL_FILE` and Redis's built-in default
user, with unauthenticated local/shared-network access. Existing ACL deployments
must retain their explicit path. See README for provisioning and persistence.

## RabbitMQ

The running container was created with `compose.yml` and `/tmp/rmq-hop.yml`.
That temporary override no longer exists. The running version is 4.4.0.
Inspection confirmed:

- Hostname `infra-rabbitmq`, effective node `rabbit@infra-rabbitmq`.
- Existing `/var/lib/rabbitmq` named volume and standard entrypoint/command.
- Configured default user, password and vhost match the current Compose values
  (compared without displaying credentials).
- No extra RabbitMQ environment settings beyond the image defaults.
- Only the image's `10-defaults.conf` in `/etc/rabbitmq/conf.d`.
- No additional bind mount, memory/CPU limit or ulimit override.

The node name is now explicit in Compose. No necessary extra setting was found
in the effective container configuration. The vanished override's original
contents cannot be reconstructed with certainty.

## Legacy local inventory

During the initial consolidation, these ignored files were inventoried and
verified unchanged:

- `data/projects/rag-poc.env`, `overrides/rag-poc-app.override.yml`,
  and files under `docker/rag-poc/`.
- `data/projects/sf-test-worktrees.env`,
  `overrides/sf-test-worktrees-app.override.yml`, and files under
  `docker/sf-test-worktrees/`.

Both registry root and bare-repository paths refer to old locations absent on
this host. No repository was moved or deleted. No corresponding application
container was running during inspection. The shared data services were all
retained; no claim is made that their consumers are unused.

## Changes pending a separate application step

- Redis receives the same ACL path via local `.env` interpolation.
- RabbitMQ receives the explicit node name matching its current identity.
- All eight services receive `json-file` logging, `max-size=10m`, `max-file=3`.
- Mailpit is pinned to v1.30.7, Adminer to 6.1.2 and Dozzle to v10.7.3, with
  digests matching the currently running images. No image upgrade is prepared.
- The unused Node service/profile and application lifecycle commands are removed.

Review the effective configuration before any future container recreation. This
work did not apply these changes to running services or publish a release/site.

## Verification

Passed Bash syntax checks for each retained script, ShellCheck at warning level,
Compose rendering for `core`, `async` and `core,async`, nine Docker-simulated
Bats tests, and custom-port/ACL interpolation checks. The fresh example renders
without a project-specific ACL file. A fresh service startup was not run.

`devhub doctor` passed: all eight containers run, six report healthy, and Adminer
and Dozzle have no healthcheck. Container IDs and mounts stayed unchanged across
the work. CLI help and Make help were checked. The public documentation was
updated in source; no frontend build or browser test was run.

## Authorized runtime application on 2026-10-28

The operator subsequently requested reinstallation and restart. The CLI installer
was rerun, then all eight containers were recreated using the local `.env` and
`core,async` profiles, with `--pull never --wait`. Startup completed successfully.

All eight use the same image IDs, named volumes, mount destinations and published
ports as before the restart. The configured log rotation is active on each one.
Redis ACL rules and the RabbitMQ node identity match their values before restart.
No container restart loop was observed. Adminer, Dozzle, Mailpit and Meilisearch
returned HTTP 200. The installed CLI's `doctor` passed. No volume was deleted.
This restart validates the existing installation; it is not a fresh empty-volume
test or an application-level consumer test.

## Authorized legacy cleanup

The operator subsequently requested removal of the unused directories. Removed
`overrides/`, `templates/`, `docker/` and `data/projects/`, including the historical
local files inventoried above. Their obsolete ignore rules and repository
instructions were removed as well. Retained `data/scripts/`, `docs/`, `tests/`
and the shared infrastructure configuration. No external application repository,
Docker container or Docker volume was removed by this cleanup.
