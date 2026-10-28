#!/usr/bin/env bash
set -euo pipefail

services=(
  infra-postgres
  infra-mysql
  infra-redis
  infra-meilisearch
  infra-mailpit
  infra-adminer
  infra-dozzle
  infra-rabbitmq
)

printf "%-24s %-10s %-12s\n" "CONTAINER" "RUNNING" "HEALTH"
printf "%-24s %-10s %-12s\n" "--------" "-------" "------"

status=0
for c in "${services[@]}"; do
  if state=$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$c" 2>/dev/null); then
    read -r running health <<<"$state"
    if [ "$running" != true ] || { [ "$health" != healthy ] && [ "$health" != n/a ]; }; then
      status=1
    fi
  else
    running=missing
    health=unknown
    status=1
  fi
  printf "%-24s %-10s %-12s\n" "$c" "$running" "$health"
done
exit "$status"
