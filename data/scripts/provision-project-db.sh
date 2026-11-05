#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 4 ]; then
  echo "Usage: $0 <db_name> <env_file> [container] [admin_user]" >&2
  exit 1
fi

DB_NAME="$1"
ENV_FILE="$2"
POSTGRES_CONTAINER="${3:-${POSTGRES_CONTAINER:-infra-postgres}}"
POSTGRES_ADMIN_USER="${4:-${POSTGRES_ADMIN_USER:-test}}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "Invalid DB name: $DB_NAME" >&2
  exit 1
fi

# The password stays out of argv: it goes from the private env file to psql through stdin.
password="$(sed -n 's/^DEVHUB_DB_PASSWORD=//p' "$ENV_FILE")"
if [[ ! "$password" =~ ^[a-f0-9]{32,}$ ]]; then
  echo "No valid DEVHUB_DB_PASSWORD in $ENV_FILE" >&2
  exit 1
fi

# The role always gets the stored password, and only its owner can connect to the database.
docker exec -i "$POSTGRES_CONTAINER" psql -q -U "$POSTGRES_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
SELECT 'CREATE ROLE "$DB_NAME" LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_NAME')\gexec
ALTER ROLE "$DB_NAME" LOGIN PASSWORD '$password';
SELECT 'CREATE DATABASE "$DB_NAME" OWNER "$DB_NAME"' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB_NAME')\gexec
REVOKE CONNECT ON DATABASE "$DB_NAME" FROM PUBLIC;
SQL

echo "Done: private db=${DB_NAME}"
