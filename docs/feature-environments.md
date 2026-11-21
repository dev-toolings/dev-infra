# Feature environments on Ubuntu

Feature environments give each Git feature branch a separate Compose project, set of worktrees, services, database volume and local preview URL. Each environment uses a random loopback port, so two preview stacks can run together without publishing the app containers' source Compose ports.

## Requirements

- DevHub is installed on the Ubuntu host and its CLI can reach the local Docker Engine at `/var/run/docker.sock`.
- Docker Compose 2.30 or later is available through `docker compose`. The provider also uses Linux `flock` (util-linux).
- Git is available, and the user running DevHub can read the source repositories and write the selected worktree directory.
- Available disk space and memory are sufficient for the recipe resource limits and container images.

Run the fixture on a development Docker host. It creates and removes local containers, networks, volumes, worktrees and fixture images.

## Run the integration fixture

The runner creates three temporary Git repositories from `data/examples/feature-environment/`: frontend, API and deployment. It writes the checked-in version 1 recipe after replacing its three repository path tokens. It uses private temporary XDG directories and a separate worktree root. It concurrently creates two environments, moves the source branch and verifies the checkouts stay pinned to their recorded commits, starts the Docker services, checks same-origin HTTP and WebSocket routing, writes and reads separate SQL rows, checks data after a stop and restart, verifies dirty worktree retention and destroy refusal, then destroys the environments and removes the fixture images.

```bash
python3 tests/feature-environments.py
python3 tests/feature-recovery.py
python3 tests/feature-project.py
python3 tests/feature-hmr.py
```

`feature-hmr.py` starts a real Vite dev server in a `hardened` feature that keeps Internet access for it alone, then checks that a CSS change in the worktree reaches the browser socket through the preview as a hot update. Vite 6 and later accept the HMR socket only with the token of its client script, which a browser loaded from the preview has.

Pass `--five` to create five feature environments concurrently. Use `devhub env timer-install` to enable periodic reconciliation separately.

The two-feature run starts a disposable primary app against the source checkout and checks its response after removing a feature. Both runs check that the existing `dev-infra` containers remain running. It checks fixture image IDs before removing the fixture-specific tags. It never removes images from other projects.

## A feature of a DevHub project

A project DevHub runs in Docker (created with `devhub new` or `devhub import`) needs no recipe file: `devhub env create PROJECT --feature NAME` derives one. A recipe file with the same name wins.

- The feature gets a worktree of the project, started from its current `HEAD` unless `--base` says otherwise. A new project needs a first commit.
- It runs the project's app container with its own image, dependencies volume and env file, on the `shared` level: it joins the project network to reach the shared services it already uses.
- Postgres data is copied into a private database and role named after the feature (`dh_ef_...`). `destroy --purge-data` drops them; a plain `destroy` keeps them and lists them as `database`. The project database is never touched. MySQL and MariaDB projects are refused.
- `REDIS_PREFIX`, `MEILISEARCH_INDEX_PREFIX` and the app URL point to the feature. The app URL becomes `http://<feature>-<id>.<project>.localhost`, which answers once the proxy runs (`devhub up --with proxy`); the loopback `preview.url` works without it.
- Each service gets 2 CPUs and 2,048 MiB, and stops after 24 hours without activity. Readiness waits for the start period of the app health check plus 30 seconds (330 seconds for a project from `devhub new`), so a first dependency install can finish. Database commands always target the local Docker Engine at `/var/run/docker.sock`, like the feature containers.

`python3 tests/feature-project.py` checks this on real Docker: it needs `infra-postgres` running and creates, then removes, a throwaway project.

## Install the recipe manually

Copy the three example repositories into a directory outside DevHub's own checkout, initialize each as a Git repository and commit the fixture.

```bash
mkdir -p "$HOME/src/feature-fixture"
cp -R data/examples/feature-environment/frontend data/examples/feature-environment/api data/examples/feature-environment/deployment "$HOME/src/feature-fixture/"
for repo in frontend api deployment; do
  git -C "$HOME/src/feature-fixture/$repo" init --initial-branch=main
  git -C "$HOME/src/feature-fixture/$repo" add .
  git -C "$HOME/src/feature-fixture/$repo" -c user.email=fixture@example.invalid -c user.name=fixture commit -m fixture
done
```

Add the parent directory to DevHub's approved roots. The recipe uses absolute source paths. Copy the versioned template to the recipe directory and replace its path tokens with the clone paths.

```bash
devhub root add "$HOME/src/feature-fixture" --label feature-fixture --json
export DEVHUB_RECIPE_DIR="$HOME/.config/devhub/recipes"
mkdir -p -m 700 "$DEVHUB_RECIPE_DIR"
cp data/examples/feature-environment/recipe.v1.json "$DEVHUB_RECIPE_DIR/fixture.json"
python3 - "$DEVHUB_RECIPE_DIR/fixture.json" "$HOME/src/feature-fixture" <<'PY'
import sys
from pathlib import Path

recipe = Path(sys.argv[1])
root = Path(sys.argv[2]).resolve()
text = recipe.read_text()
for name in ("frontend", "api", "deployment"):
    text = text.replace(f"/ABSOLUTE/PATH/TO/{name}", str(root / name))
recipe.write_text(text)
recipe.chmod(0o600)
PY
```

Choose a worktree directory outside the source repositories and the DevHub state directory. Use the same path across CLI runs.

```bash
export DEVHUB_WORKTREE_ROOT="$HOME/devhub-feature-worktrees"
mkdir -p -m 700 "$DEVHUB_WORKTREE_ROOT"
```

Create and start the feature environment.

```bash
devhub env create fixture --feature websocket-demo --idempotency-key websocket-demo-1 --json
devhub env status <environment-id> --json
```

The versioned JSON response is shaped as `{"version":1,"data":...}`. The environment's `preview` contains `url`, `port`, and `tunnel` (`remoteHost` and `remotePort`). Use the returned URL to open the page and check `/api/health`. The page's browser script opens `/api/ws` against that same origin.

## Recipe format

The complete example is [recipe.v1.json](../data/examples/feature-environment/recipe.v1.json). Recipe JSON is validated before use. Repository `path` values and secret-file paths are absolute. Compose file paths and local-file targets are repository-relative. A step's `argv` is an argument array executed directly, without a shell. Keep each argument as a JSON string and escape embedded quotes as `\"`. To use shell syntax, explicitly pass a shell and its arguments.

Version 1 includes `repositories`, `compose`, `routes`, `steps`, `shared`, `resources`, and `idleMinutes`. `localFiles`, `isolation`, `capabilities` and `internet` are optional. `compose.services` names the selected services. Route paths map to a selected service and container port. Use `healthPath` to name a dedicated health endpoint. Steps use `install`, `migrate`, `seed`, `check`, or `test` phases. `retry` defaults to safe for ordinary steps and manual for seed steps. External networks and volumes must be listed in `shared` before a Compose file can use them.

`isolation` picks how far a feature is separated from the host and the other stacks:

| Level | What the provider enforces |
| --- | --- |
| `shared` (default) | Feature-owned containers, networks and volumes. External networks and volumes listed in `shared` are allowed. |
| `dedicated` | Same, and `shared` must be empty: the feature reaches no external network or volume. |
| `hardened` | `dedicated`, plus every service drops all capabilities except those listed for it in `capabilities` (Docker default set only), runs with `no-new-privileges`, runs as the host user when it mounts a worktree writably (any other user there is refused), and sits on internal networks without Internet access. Services listed in `internet` keep a route out. The preview gateway alone joins a network that publishes its loopback port. |

`hardened` limits mistakes in trusted code. It shares the host kernel and is no boundary for hostile code. Images that need root at startup, such as the official PostgreSQL image, need their capabilities listed, for example `"capabilities": {"postgres": ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]}`. Files baked into an image as root with mode 0600 cannot be read by the host user: mount the worktree code instead.

The deployment Compose fixture deliberately declares a fixed host port and a fixed database volume name. The database recipe waits for the permanent TCP listener, migrates a table and seeds one row safely. DevHub removes published app ports, adds its loopback preview gateway, and assigns the managed volume a name scoped to each feature. The PostgreSQL volume keeps each environment's data separate. Caddy uses a feature-owned network common to the routed services when available. It uses a dedicated feature ingress network when those services are on separate networks.

## Start, stop and remove

- `devhub env stop ID` stops containers and keeps the worktrees and database volume. Start the same ID again to reuse them.
- `devhub env start ID --build` rebuilds the feature images and starts the environment. A normal `start` reuses available images.
- `devhub env test ID` runs recipe steps in the `test` phase.
- `devhub env destroy ID` removes the owned containers, private networks and preview registrations. The environment record keeps the inventory of retained worktrees, branches, named volumes and built image references. Start a new environment for further development.
- Add `--remove-worktrees` to remove the feature worktrees with Git. Tracked changes, untracked and ignored files, and declared local files block removal. `--force` with this flag authorizes discarding those files. Branches and commits are kept.
- Add `--purge-data` independently to remove the feature's verified named volumes. Use named volumes for persistent application data. Writable binds inside a worktree share that worktree's removal lifecycle.
- `devhub env list`, `status ID`, `doctor`, and `reconcile` show local environment and recovery state.

Run `devhub env timer-install` to write, enable and start the systemd user timer. It runs `env reconcile` once per minute and inherits the paths and limits configured in the installation command. Check it with `systemctl --user status devhub-feature-reconcile.timer` and read its run output with `journalctl --user -u devhub-feature-reconcile.service`. Keep the user manager running between SSH logins with `loginctl enable-linger "$USER"` if your administrator permits it. Run `systemctl --user disable --now devhub-feature-reconcile.timer` to stop periodic reconciliation.

Idle time uses the last lifecycle operation, `exec` or `test`. View and status requests leave the activity timestamp as recorded. The timer skips environments with active operations. Idle stop retains worktrees, branches and database data. If a stop or its preview route update fails, reconciliation inspects the current resources and retries the stop. The provider supports live stop/start. Pause, snapshots, strict disk quotas and remote Docker contexts are unsupported.

The defaults are five active environments, two concurrent build or bootstrap operations, and 2,048 MiB free on each relevant filesystem. Override them in the DevHub process with `DEVHUB_FEATURE_MAX_ACTIVE`, `DEVHUB_FEATURE_MAX_BUILDS` and `DEVHUB_FEATURE_MIN_FREE_MIB`. Use the same settings for the CLI, controller and timer. Each selected service, including Caddy, gets the recipe's CPU and RAM cap. Docker logs rotate at 10 MB per file and three files per container. DevHub also keeps a bounded operation log.

## Preview and DNS troubleshooting

The direct preview listens on `127.0.0.1` at the port reported in `preview`. It is local to the Ubuntu host. For a remote workstation, forward that loopback endpoint over SSH from the workstation, using the host's reported port as the remote port.

```bash
ssh -N -L 127.0.0.1:<local-port>:127.0.0.1:<preview-port> <ubuntu-host>
```

Open `http://127.0.0.1:<local-port>` on the workstation. Keep the published host binding on loopback. Docker can allocate a different remote port after a stop and start. The panel displays the preview links for ready environments using the latest reported address. Read `devhub env preview ID --json` before reopening the tunnel. A configured domain alias keeps the same name as the upstream port changes.

Check these points if the preview fails.

1. Check `devhub env status ID --json` for `observed`, `operation`, and `preview`.
2. Check `devhub env logs ID devhub-preview --tail 100` and the application service logs.
3. From the Ubuntu host, request the returned preview URL and `/__devhub_health`, then request `/api/health`.
4. For an SSH tunnel, confirm its remote endpoint is `127.0.0.1:<preview.tunnel.remotePort>` on the Ubuntu host.

An optional `previewDomain` puts aliases of the form `feature-ID.<domain>` in the existing Caddy proxy. Start it explicitly on Ubuntu with `devhub up --with proxy`. If its HTTP port differs from 80, provide the matching `DEVHUB_FEATURE_PROXY_PORT` to the CLI, controller and timer. The proxy binds to Ubuntu loopback.

For a private DNS and TLS setup, point a wildcard record at your VPN or development ingress address and configure that ingress to forward the original Host header and WebSocket upgrades to the Ubuntu Caddy loopback listener. This requires a listener that can reach Ubuntu loopback, typically a TLS gateway on the same host listening on the private interface. Verify hostname resolution and TLS from the workstation. For a domain alias through SSH alone, forward the Caddy port, resolve the generated host to `127.0.0.1` on the workstation and include the workstation's forwarded port in the URL.

Keep application browser requests relative, including the base URL and WebSocket path. Configure trusted hosts and proxies, origin checks, host-only cookies, and any redirect or callback URLs for the feature origin. For external email, payments and webhooks, declare development substitutes or test credentials in the recipe. Caddy forwards requests and upgrades. Access control comes from the SSH or private ingress configuration.

## Escape command and API contract

Run the CLI on the Ubuntu Docker host, either directly or over SSH. Machine clients use the `--json` flag before the `--` delimiter for application arguments.

| Intent | CLI |
| --- | --- |
| Discover recipes and environment IDs | `devhub env recipes --json`, `devhub env list --json` |
| Create and start | `devhub env create PROJECT --feature NAME --idempotency-key KEY --json` |
| Read current readiness and inventory | `devhub env status ID --json` |
| Launch or rebuild | `devhub env start ID [--build] [--retry-step STEP] --json` |
| Stop and retain resources | `devhub env stop ID --json` |
| Resolve the tunnel endpoint | `devhub env preview ID --json` |
| Inspect application or operation logs | `devhub env logs ID --service api --tail 100 --json`, or use `--service operation` |
| Run a command in a service | `devhub env exec ID --service api --timeout 60 --json -- COMMAND ARG` |
| Run the recipe tests | `devhub env test ID --json` |
| Remove runtime resources or purge | `devhub env destroy ID [--purge-data] [--remove-worktrees] [--force] --json` |
| Check the local provider and reconcile | `devhub env doctor --json`, `devhub env reconcile --json` |

Use `--base REF` for the default across repositories. `--ref NAME=REF` overrides one repository. `--branch NAME=BRANCH` explicitly attaches a local branch if Git can check it out in another worktree. Ref resolution uses local Git objects. Fetch updates in the source repository first when needed.

A successful response uses `{"version":1,"data":...}`. A rejected request uses `{"version":1,"error":{"code":"...","message":"..."}}`. If create or another lifecycle action acquires an environment and then fails, the response still carries its stable `data.id` and `data.operation.error` on stdout, with a nonzero process exit. Application command results include `code`, `stdout` and `stderr`. Top-level usage errors exit 2. Reuse the same create key for retransmission. A change to the project, feature, refs, attached branches or build request with that key returns `idempotency_conflict`.

Create and start wait for initial checks. While a command is running, a separate `list` or `status` request can report its ID and `operation.step`. `desired` represents the requested lifecycle state. `observed`, `resources.containers[].health`, `observationError`, and `operation.state` report the latest observation and operation. After an interruption, run reconcile and inspect status. Bootstrap install, migrate and seed steps keep their completion state. A manual step whose side effects are uncertain requires checking its effects before `start --retry-step STEP`.

A create retry with the same key returns the existing environment. If its allocation or launch was interrupted, the result reports `operation.state` as `interrupted`. Inspect the environment and use `devhub env start ID` to resume.

The paired loopback controller uses `/api/v1/environments`. GET lists, POST creates, and GET or DELETE on `/:id` reads or removes. POST to `/:id/start`, `stop`, `exec`, `test` and `preview` uses JSON bodies. GET `/:id/logs?service=api&tail=100` reads logs. Create accepts the idempotency key in the request body or `Idempotency-Key` header. Use the existing DevHub session and Origin controls. Host-level timer installation stays on the CLI.

## Bootstrap and Git troubleshooting

- If Git rejects an attached branch, run `git worktree list` in its source repository. Choose a free branch explicitly or let DevHub allocate one. The initial commit and branch are recorded per repository.
- If Compose rejects a bind, build or environment path, use a checked-in worktree path or a recipe-approved file. Other repositories are available through `DEVHUB_REPO_<NAME>` interpolation, where the name is uppercase with underscores. Relative paths resolve from the recipe's Compose project directory.
- A recipe's `compose.vars` populate interpolation. Service environment values belong in the Compose service definition or its approved `env_file`. A `compose.secretFiles` value points at a specific host file and supplies its path for a Compose secret reference. Keep literal secrets out of committed recipes. The generated Compose snapshot records file references for `env_file` and Compose secrets. Docker reads the values from those files when it starts the services.
- If the provider rejects fixed networking, a host namespace, privileged access or an unapproved external resource, use a bridge network and named local volumes. Only the Caddy gateway publishes a host port. DevHub rejects anonymous image volumes unless their mount targets are declared explicitly.
- If a bootstrap step fails, inspect `devhub env logs ID --service operation`. Use an image with a compatible `timeout` executable for targeted commands. Run checks against their dedicated service, and make repeatable migrations safe to rerun.

Use the fixture credentials only for this disposable example.
