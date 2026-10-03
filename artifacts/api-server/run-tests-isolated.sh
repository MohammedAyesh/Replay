#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DB_NAME="api_server_test"
TEST_MARKER="isolated-api-test-db-v1"

# Do not let this process inherit the shared database URL or any libpq
# connection overrides. The test database is created and used locally below.
unset DATABASE_URL
while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep '^PG' || true)

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/api-server-test-db.XXXXXX")"
PGDATA="$TEMP_ROOT/pgdata"
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

psql "postgresql://postgres@127.0.0.1:${PGPORT}/postgres" \
  --no-psqlrc --set ON_ERROR_STOP=1 \
  --command "CREATE DATABASE ${DB_NAME}" >/dev/null

export DATABASE_URL="$TEST_DATABASE_URL"
export API_SERVER_TEST_DATABASE="$TEST_MARKER"
export PGHOST=127.0.0.1
export PGPORT
export PGDATABASE="$DB_NAME"
export PGUSER=postgres
unset PGHOSTADDR PGSERVICE PGSERVICEFILE
unset PGOPTIONS

API_SERVER_RUN_DB_GUARD=1 node "$SCRIPT_DIR/test-database-guard.mjs"

echo "[api-test-db] Applying the checked-in Drizzle schema to the disposable database."
(
  cd "$REPO_ROOT/lib/db"
  pnpm exec drizzle-kit push --config ./drizzle.config.ts
)

API_SERVER_RUN_DB_GUARD=1 node "$SCRIPT_DIR/test-database-guard.mjs"

echo "[api-test-db] Running API tests against 127.0.0.1:${PGPORT}/${DB_NAME}."
cd "$REPO_ROOT"
pnpm --filter @workspace/api-server exec vitest run --maxWorkers=1