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
devhub serve --dev-origin http://127.0.0.1:5175
```

The control panel is not exposed on the network. Pairing codes and credentials
must not be copied into shell history or shared logs.

## Existing infrastructure commands

The existing Bash commands remain available without Bun:
`devhub up`, `down`, `restart`, `ps`, `logs`, `open`, `db`, `doctor`, `version`,
and `help`. `devhub infra COMMAND ...` forwards to the same Bash implementation.
The shared Compose project, service names, ports, volumes, and external network
remain managed by those existing commands.
