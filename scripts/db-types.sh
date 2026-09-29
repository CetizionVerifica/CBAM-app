#!/usr/bin/env bash
# Regenerates apps/api/src/db-types.ts from a throwaway Postgres migrated from scratch,
# so the types always match db/migrations exactly. Requires Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

name="cbam-db-types-$$"
docker run -d --rm --name "$name" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=x -e CBAM_OWNER_PASSWORD=o -e CBAM_APP_PASSWORD=a \
  -v "$PWD/db/init:/docker-entrypoint-initdb.d:ro" postgres:17 >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT

port=$(docker port "$name" 5432 | head -1 | cut -d: -f2)
export DATABASE_URL="postgres://cbam_owner:o@127.0.0.1:$port/cbam?sslmode=disable"
sleep 2
node_modules/.bin/dbmate --wait --migrations-dir db/migrations --no-dump-schema up >/dev/null

apps/api/node_modules/.bin/kysely-codegen \
  --dialect postgres \
  --url "$DATABASE_URL" \
  --include-pattern '(public|audit).*' --exclude-pattern 'public.schema_migrations' \
  --date-parser string \
  --numeric-parser string \
  --out-file apps/api/src/db-types.ts
