#!/usr/bin/env bash
# Creates the two database roles and the application database.
# Runs once when the dev Postgres container is first created, and in API tests.
#   cbam_owner  owns the schema and runs migrations
#   cbam_app    used by the API at runtime; not an owner, no BYPASSRLS
set -euo pipefail

: "${CBAM_DB_NAME:=cbam}"
: "${CBAM_OWNER_PASSWORD:?CBAM_OWNER_PASSWORD must be set}"
: "${CBAM_APP_PASSWORD:?CBAM_APP_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v db="$CBAM_DB_NAME" -v owner_pw="$CBAM_OWNER_PASSWORD" -v app_pw="$CBAM_APP_PASSWORD" <<'SQL'
create role cbam_owner login password :'owner_pw' nosuperuser nocreaterole nocreatedb;
create role cbam_app   login password :'app_pw'   nosuperuser nocreaterole nocreatedb nobypassrls;
create database :"db" owner cbam_owner;
\connect :"db"
revoke all on database :"db" from public;
grant connect on database :"db" to cbam_app;
revoke create on schema public from public;
alter schema public owner to cbam_owner;
-- Extensions need superuser; create them here so migrations can run as cbam_owner.
create extension if not exists citext;
create extension if not exists btree_gist;
SQL
