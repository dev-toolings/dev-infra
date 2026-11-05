#!/usr/bin/env bash
set -euo pipefail

# Recreated infra containers lose the project networks they had joined.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker network ls --filter label=devhub.infra --format '{{.Name}}' | while read -r network; do
  services="$(docker network inspect -f '{{index .Labels "devhub.infra"}}' "$network")"
  for service in ${services//,/ }; do
    "$script_dir/connect-project-network.sh" "$service" "$network" >/dev/null || echo "Not connected: ${service} -> ${network}" >&2
  done
done
