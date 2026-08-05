#!/bin/bash
# DEPRECATED: Direct schema push will be replaced by journaled migrations.
# See replit.md for the DB schema-change policy.
set -e

FORCE_FLAG="${1:-}"

# Refuse to run in non-interactive contexts (CI, post-merge hooks, etc.)
if [ ! -t 0 ]; then
  echo "" >&2
  echo "❌  ERROR: DB push requires an interactive terminal." >&2
  echo "    This script deliberately refuses to run non-interactively." >&2
  echo "    Open a Shell tab and run it there." >&2
  echo "" >&2
  exit 1
fi

# Resolve the target DB host from DATABASE_URL for human verification.
DB_HOST=$(node -e "try { const u = new URL(process.env.DATABASE_URL || ''); process.stdout.write(u.hostname); } catch(_) { process.stdout.write('(could not parse DATABASE_URL)'); }" 2>/dev/null)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ⚠️   DEPRECATED — use journaled migrations instead          ║"
echo "║  This push is NOT recorded in lib/db/migrations/            ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  Target DB host: %-43s ║\n" "$DB_HOST"
echo "╠══════════════════════════════════════════════════════════════╣"
if [ "$FORCE_FLAG" = "--force" ]; then
  echo "║  ⚠️   --force is set: destructive changes will NOT prompt   ║"
fi
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Type  yes  to push schema changes to the database above, or anything else to abort:"
read -r CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted — no changes made."
  exit 1
fi

# Navigate to lib/db (script may be invoked from any working directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ "$FORCE_FLAG" = "--force" ]; then
  pnpm drizzle-kit push --force --config ./drizzle.config.ts
else
  pnpm drizzle-kit push --config ./drizzle.config.ts
fi
