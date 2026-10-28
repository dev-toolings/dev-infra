#!/usr/bin/env bats

setup() {
  export REPO_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export DEVHUB_DIR="$BATS_TEST_TMPDIR/hub"
  export DOCKER_CALLS="$BATS_TEST_TMPDIR/docker.calls"
  export MOCK_CONFIG="$BATS_TEST_TMPDIR/config.json"
  mkdir -p "$DEVHUB_DIR/data/scripts" "$BATS_TEST_TMPDIR/bin"
  cp "$REPO_DIR/data/scripts/healthcheck.sh" "$DEVHUB_DIR/data/scripts/"
  touch "$DEVHUB_DIR/compose.yml" "$DEVHUB_DIR/.env" "$DOCKER_CALLS"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  cat > "$MOCK_CONFIG" <<'JSON'
{"services":{
  "adminer":{"ports":[{"host_ip":"127.0.0.1","published":"19080","target":8080,"protocol":"tcp"}]},
  "mailpit":{"ports":[{"host_ip":"127.0.0.1","published":"11025","target":1025,"protocol":"tcp"},{"host_ip":"127.0.0.1","published":"18025","target":8025,"protocol":"tcp"}]},
  "dozzle":{"ports":[{"host_ip":"127.0.0.1","published":"18888","target":8080,"protocol":"tcp"}]},
  "rabbitmq":{"ports":[{"host_ip":"127.0.0.1","published":"25672","target":15672,"protocol":"tcp"}]},
  "meilisearch":{"ports":[{"host_ip":"127.0.0.1","published":"17700","target":7700,"protocol":"tcp"}]},
  "mysql":{"ports":[{"host_ip":"127.0.0.1","published":"13306","target":3306,"protocol":"tcp"}]}
}}
JSON
  cat > "$BATS_TEST_TMPDIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$1" in
  compose)
    [ "$*" = "compose --env-file ${EXPECTED_ENV_FILE:-$DEVHUB_DIR/.env} -f $DEVHUB_DIR/compose.yml config --format json" ] || exit 97
    [ "${COMPOSE_PROFILES:-}" = core,async ] || exit 98
    [ "${CONFIG_FAIL:-0}" = 0 ] || exit 1
    cat "$MOCK_CONFIG"
    ;;
  network)
    [ "$2" = inspect ] || exit 99
    [ "${NETWORK_MISSING:-0}" = 0 ] || exit 1
    echo 'dev-shared-net (driver=bridge)'
    ;;
  inspect)
    if [ "${*: -1}" = infra-redis ]; then
      case "${REDIS_STATE:-healthy}" in
        missing) exit 1 ;;
        stopped) echo 'false healthy' ;;
        *) echo "true ${REDIS_STATE:-healthy}" ;;
      esac
    else
      case "${*: -1}" in
        infra-adminer|infra-dozzle) echo 'true n/a' ;;
        *) echo 'true healthy' ;;
      esac
    fi
    ;;
  *) exit 99 ;;
esac
SH
  cat > "$BATS_TEST_TMPDIR/bin/ss" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'State Local Address:Port' 'LISTEN 127.0.0.1:19080 ' 'LISTEN 127.0.0.1:13306 ' 'LISTEN 127.0.0.1:9080 ' 'LISTEN 127.0.0.1:190800 '
SH
  printf '#!/usr/bin/env bash\nexit 0\n' > "$BATS_TEST_TMPDIR/bin/xdg-open"
  chmod +x "$BATS_TEST_TMPDIR/bin/"*
}

@test "help lists only shared profiles and never calls Docker" {
  run "$REPO_DIR/bin/devhub" help
  [ "$status" -eq 0 ]
  [[ "$output" == *"core, async"* ]]
  [[ "$output" != *node* && "$output" != *runtime* && "$output" != *"wt "* ]]
  [ ! -s "$DOCKER_CALLS" ]
}

@test "unknown and retired commands fail before Docker" {
  for command in unknown project wt runtime down-runtime; do
    run "$REPO_DIR/bin/devhub" "$command"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown command: $command"* ]]
  done
  [ ! -s "$DOCKER_CALLS" ]
}

@test "removed node profile fails before starting services" {
  run "$REPO_DIR/bin/devhub" up --with node
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown profile: node"* ]]
  [ ! -s "$DOCKER_CALLS" ]
}

@test "open uses configured UI ports for every target and alias" {
  for pair in adminer:19080 mailpit:18025 dozzle:18888 rabbitmq:25672 meili:17700 meilisearch:17700; do
    run "$REPO_DIR/bin/devhub" open "${pair%:*}"
    [ "$status" -eq 0 ]
    [ "$output" = "http://localhost:${pair#*:}" ]
  done
}

@test "doctor reports configured ports and only matching listeners" {
  run "$REPO_DIR/bin/devhub" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"127.0.0.1:19080 -> 8080/tcp"* ]]
  [[ "$output" == *"LISTEN 127.0.0.1:13306 "* ]]
  [[ "$output" != *"LISTEN 127.0.0.1:9080 "* ]]
  [[ "$output" != *"LISTEN 127.0.0.1:190800 "* ]]
}

@test "doctor fails for unhealthy starting stopped and missing services but still prints ports" {
  for state in unhealthy starting stopped missing; do
    export REDIS_STATE="$state"
    run "$REPO_DIR/bin/devhub" doctor
    [ "$status" -ne 0 ]
    [[ "$output" == *infra-redis* && "$output" == *"Host ports:"* ]]
  done
}

@test "doctor fails for missing network without creating it" {
  export NETWORK_MISSING=1
  run "$REPO_DIR/bin/devhub" doctor
  [ "$status" -ne 0 ]
  [[ "$output" == *"Host ports:"* ]]
  ! grep -q 'network create' "$DOCKER_CALLS"
}

@test "open and doctor fail when Compose config fails" {
  export CONFIG_FAIL=1
  for command in 'open adminer' doctor; do
    # Intentional splitting of the command and argument for this fixture.
    run "$REPO_DIR/bin/devhub" $command
    [ "$status" -ne 0 ]
    [[ "$output" != *http://* ]]
  done
}

@test "doctor uses example configuration without creating a local env file" {
  mv "$DEVHUB_DIR/.env" "$DEVHUB_DIR/.env.example"
  export EXPECTED_ENV_FILE="$DEVHUB_DIR/.env.example"
  run "$REPO_DIR/bin/devhub" doctor
  [ "$status" -eq 0 ]
  [ ! -e "$DEVHUB_DIR/.env" ]
}
