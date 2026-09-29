#!/usr/bin/env bash
# Applies all migrations, rolls every one back, and applies them again, on a throwaway
# Postgres. Catches broken down-migrations before they are needed. Requires Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

name="cbam-migration-check-$$"
docker run -d --rm --name "$name" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=x -e CBAM_OWNER_PASSWORD=o -e CBAM_APP_PASSWORD=a \
  -v "$PWD/db/init:/docker-entrypoint-initdb.d:ro" postgres:17 >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT

port=$(docker port "$name" 5432 | head -1 | cut -d: -f2)
export DATABASE_URL="postgres://cbam_owner:o@127.0.0.1:$port/cbam?sslmode=disable"
dbmate="node_modules/.bin/dbmate --migrations-dir db/migrations --no-dump-schema"
sleep 2
$dbmate --wait up
count=$(ls db/migrations/*.sql | wc -l)
for _ in $(seq "$count"); do $dbmate rollback; done
$dbmate up
echo "Migrations apply, roll back and re-apply cleanly."
