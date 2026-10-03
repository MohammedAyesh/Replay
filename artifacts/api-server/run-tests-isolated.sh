#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DB_NAME="api_server_test"
TEST_MARKER="isolated-api-test-db-v1"
SOURCE_DATABASE_URL="${DATABASE_URL:-}"

if [[ -z "$SOURCE_DATABASE_URL" ]]; then
  echo "API tests aborted: DATABASE_URL is required only as a read-only schema source." >&2
  exit 1
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/api-server-test-db.XXXXXX")"
PGDATA="$TEMP_ROOT/pgdata"
SCHEMA_DUMP="$TEMP_ROOT/development-schema.sql"
PGPORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${DB_NAME}"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -f "$PGDATA/postmaster.pid" ]]; then
    pg_ctl -D "$PGDATA" -m fast -w -t 10 stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TEMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[api-test-db] Creating a temporary PostgreSQL cluster."
initdb -D "$PGDATA" -U postgres --auth-local=trust --auth-host=trust >/dev/null
pg_ctl -D "$PGDATA" \
  -o "-F -k $PGDATA -h 127.0.0.1 -p $PGPORT" \
  -w -t 20 start >/dev/null

ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/postgres"
env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS \
  PGHOST=127.0.0.1 PGPORT="$PGPORT" PGDATABASE=postgres PGUSER=postgres \
  psql "$ADMIN_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1 \
  --command "CREATE DATABASE ${DB_NAME}" >/dev/null

echo "[api-test-db] Taking a schema-only snapshot from the configured database."
pg_dump --schema-only --no-owner --no-privileges \
  "$SOURCE_DATABASE_URL" --file "$SCHEMA_DUMP"

echo "[api-test-db] Restoring the schema into the disposable database."
env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS \
  PGHOST=127.0.0.1 PGPORT="$PGPORT" PGDATABASE="$DB_NAME" PGUSER=postgres \
  psql "$TEST_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1 \
  --command 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
env -u PGHOSTADDR -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS \
  PGHOST=127.0.0.1 PGPORT="$PGPORT" PGDATABASE="$DB_NAME" PGUSER=postgres \
  psql "$TEST_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1 \
  --file "$SCHEMA_DUMP" >/dev/null

export DATABASE_URL="$TEST_DATABASE_URL"
export API_SERVER_TEST_DATABASE="$TEST_MARKER"
export PGHOST=127.0.0.1
export PGPORT
export PGDATABASE="$DB_NAME"
export PGUSER=postgres
unset PGHOSTADDR PGSERVICE PGSERVICEFILE
unset PGOPTIONS

API_SERVER_RUN_DB_GUARD=1 node "$SCRIPT_DIR/test-database-guard.mjs"

echo "[api-test-db] Running API tests against 127.0.0.1:${PGPORT}/${DB_NAME}."
cd "$REPO_ROOT"
pnpm --filter @workspace/api-server exec vitest run --maxWorkers=1