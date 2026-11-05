#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <container> <db_name> <env_file>" >&2
  exit 1
fi

CONTAINER="$1"
DB_NAME="$2"
ENV_FILE="$3"

if [[ ! "$CONTAINER" =~ ^infra-[a-z0-9-]+$ ]]; then
  echo "Invalid container: $CONTAINER" >&2
  exit 1
fi
# MySQL limits user names to 32 characters.
if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,31}$ ]]; then
  echo "Invalid DB name: $DB_NAME" >&2
  exit 1
fi

password="$(sed -n 's/^DEVHUB_DB_PASSWORD=//p' "$ENV_FILE")"
if [[ ! "$password" =~ ^[a-f0-9]{32,}$ ]]; then
  echo "No valid DEVHUB_DB_PASSWORD in $ENV_FILE" >&2
  exit 1
fi

# In GRANT, _ is a wildcard: unescaped, dh_web_1 would also reach the database dh_web01.
grant_name="${DB_NAME//_/\\_}"

# Neither password reaches argv: the root one stays in the container, the project one goes through stdin.
docker exec -i "$CONTAINER" sh -c 'MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" exec "$(command -v mariadb || command -v mysql)" -uroot' >/dev/null <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;
CREATE USER IF NOT EXISTS '$DB_NAME'@'%' IDENTIFIED BY '$password';
ALTER USER '$DB_NAME'@'%' IDENTIFIED BY '$password';
GRANT ALL PRIVILEGES ON \`$grant_name\`.* TO '$DB_NAME'@'%';
SQL

echo "Done: private db=${DB_NAME}"
