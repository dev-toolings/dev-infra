# AGENTS.md

DevHub: shared Docker Compose services, a Bun/TypeScript manager (`src/`: CLI and
loopback API) and a React control panel (`apps/web/`). `bin/devhub` is the Bash entry point.

## Checks (same as CI)

```bash
for s in bin/devhub install-remote.sh data/scripts/*.sh; do bash -n "$s"; done
shellcheck -x --severity=warning bin/devhub install-remote.sh data/scripts/*.sh
bun run typecheck
python3 tests/backend-isolated.py
python3 tests/infra-contract.py
bats tests
for p in core async core,async proxy; do
  COMPOSE_PROFILES="$p" docker compose --env-file .env.example -f compose.yml config > /dev/null
done
```

Run the ones matching what you touched. No frontend tests or builds in `apps/web/` unless asked.

## Never without an explicit request

- Delete named volumes (`docker compose down -v`): they hold developer data.
- Change container names, profiles, default ports or `dev-shared-net`:
  `tests/infra-contract.py` compares them to a baseline.
- Tag or push a release.

## Keep in sync

When command behavior changes, update README, `bin/devhub` help, Makefile,
`.env.example` and `compose.yml`.

## Conventions

- Bash: `set -euo pipefail`, explicit error messages, predictable exits.
- `.env` is local; `.env.example` never holds real secrets.
- Dozzle mounts `/var/run/docker.sock`: flag any change around it.
- Scaffold updates: follow `.claude/skills/update-scaffolds/SKILL.md`.

## Releasing

`VERSION` is the source of truth. While 0.0.x, every release is a patch;
1.0.0 only on explicit request.

1. Move `Unreleased` items in `CHANGELOG.md` under the new version.
2. Preview: `./data/scripts/release.sh <bump> --dry-run`
3. After user confirmation, from a clean `main`: `make release BUMP=<bump>`

Details: README "Releasing".
