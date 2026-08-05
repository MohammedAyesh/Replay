#!/bin/bash
set -e

pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Read-only schema drift check
# Warns loudly when the code schema and live DB appear out of sync.
# Never mutates the DB. Always exits 0, even when the DB is unreachable.
# ---------------------------------------------------------------------------
if [ -z "$DATABASE_URL" ]; then
  echo "ℹ️  DATABASE_URL not set — skipping schema drift check."
else
  echo "🔍 Checking for schema drift (read-only)…"

  # Tables that must exist in the public schema (derived from lib/db/src/schema/).
  # Keep this list in sync with the pgTable declarations in lib/db/src/schema/.
  EXPECTED_TABLES="users fields recordings clips likes saved_clips follows user_clips ads ad_impressions ad_clicks academies academy_recordings live_schedules clip_settings recording_schedules"

  # Build a single-query VALUES list so we make exactly one psql round-trip.
  VALUES=""
  for table in $EXPECTED_TABLES; do
    VALUES="${VALUES}('${table}'),"
  done
  VALUES="${VALUES%,}"  # strip trailing comma

  PSQL_STDERR=$(mktemp)
  PSQL_OUT=$(mktemp)

  # Disable errexit for the psql call so we can inspect its exit code ourselves.
  set +e
  PGCONNECT_TIMEOUT=5 \
  PGOPTIONS="--statement_timeout=8000" \
  psql "$DATABASE_URL" \
    --no-align --tuples-only --quiet \
    -c "SELECT t FROM (VALUES ${VALUES}) AS v(t)
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = v.t
        );" \
    >"$PSQL_OUT" 2>"$PSQL_STDERR"
  PSQL_EXIT=$?
  set -e

  PSQL_ERR=$(cat "$PSQL_STDERR")
  rm -f "$PSQL_STDERR"

  if [ $PSQL_EXIT -ne 0 ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  ⚠️   DRIFT CHECK COULD NOT RUN                          ║"
    echo "╠══════════════════════════════════════════════════════════╣"
    echo "║  Could not connect to or query the database.             ║"
    echo "║  Verify DATABASE_URL and DB availability before deploy.  ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    if [ -n "$PSQL_ERR" ]; then
      echo "  psql error: $PSQL_ERR"
    fi
    echo ""
    rm -f "$PSQL_OUT"
  else
    # Strip blank lines from output
    MISSING=$(grep -v '^[[:space:]]*$' "$PSQL_OUT" | tr -d ' ' || true)
    rm -f "$PSQL_OUT"

    if [ -n "$MISSING" ]; then
      echo ""
      echo "╔══════════════════════════════════════════════════════════╗"
      echo "║  ⚠️   SCHEMA DRIFT DETECTED — ACTION REQUIRED            ║"
      echo "╠══════════════════════════════════════════════════════════╣"
      echo "║  The following tables are missing from the live DB:      ║"
      for t in $MISSING; do
        printf "║    • %-52s ║\n" "$t"
      done
      echo "╠══════════════════════════════════════════════════════════╣"
      echo "║  Run  pnpm --filter db run push  in an interactive       ║"
      echo "║  terminal after reviewing the changes carefully.         ║"
      echo "╚══════════════════════════════════════════════════════════╝"
      echo ""
    else
      echo "✅ DB tables look in sync."
    fi
  fi
fi

exit 0
