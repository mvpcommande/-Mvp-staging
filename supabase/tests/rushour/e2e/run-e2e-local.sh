#!/usr/bin/env bash
# Parcours d'intégration RusHour sur une pile LOCALE équivalente au staging :
# Postgres (base jetable) + PostgREST + vraie Edge Function (Deno) + module
# frontend réel. Voir driver.mjs.
#
# Usage :
#   RUSHOUR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
#   POSTGREST_BIN=/chemin/postgrest DENO_BIN=/chemin/deno \
#   bash supabase/tests/rushour/e2e/run-e2e-local.sh
#
# Refuse toute base non locale.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$ROOT/supabase/tests/rushour"
ADMIN_URL="${RUSHOUR_TEST_DATABASE_URL:?RUSHOUR_TEST_DATABASE_URL requis (Postgres LOCAL)}"
POSTGREST_BIN="${POSTGREST_BIN:-postgrest}"
DENO_BIN="${DENO_BIN:-deno}"

case "$ADMIN_URL" in
  *@localhost:*|*@localhost/*|*@127.0.0.1:*|*@127.0.0.1/*) ;;
  *) echo "REFUS : Postgres local jetable uniquement." >&2; exit 2 ;;
esac

DB="rushour_e2e_$$"
BASE="${ADMIN_URL%/*}"
URL="$BASE/$DB"
HOSTPORT="${BASE#*@}"
PSQL=(psql -X -v ON_ERROR_STOP=1 -q)
JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
PGRST_PORT=3001
PGRST_PID=""

cleanup() {
  [ -n "$PGRST_PID" ] && kill "$PGRST_PID" 2>/dev/null || true
  "${PSQL[@]}" "$ADMIN_URL" -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${PSQL[@]}" "$ADMIN_URL" -c "create database $DB" >/dev/null
for f in "$HERE/00_supabase_stub.sql" "$HERE/01_base_schema.sql" \
         "$ROOT/supabase/migrations/20260922080200_enforce_idempotency_key_uniqueness.sql" \
         "$ROOT/supabase/migrations/20260928090000_rushour_connector_foundation.sql" \
         "$ROOT/supabase/migrations/20260929090000_rushour_reconciliation_and_fixes.sql" \
         "$HERE/e2e/setup.sql"; do
  "${PSQL[@]}" "$URL" -f "$f" >/dev/null
done

# Pré-cache des modules Deno (la fonction tourne ensuite en --cached-only).
(cd "$ROOT/supabase/functions" && "$DENO_BIN" cache --no-lock rushour-dispatch-order/index.ts >/dev/null 2>&1) || true

PGRST_DB_URI="postgresql://authenticator@$HOSTPORT/$DB" \
PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" \
PGRST_SERVER_PORT=$PGRST_PORT PGRST_LOG_LEVEL=crit \
  "$POSTGREST_BIN" >/dev/null 2>&1 &
PGRST_PID=$!
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$PGRST_PORT/" >/dev/null && break; sleep 0.2; done

E2E_DB_URL="$URL" E2E_PGRST_URL="http://127.0.0.1:$PGRST_PORT" E2E_JWT_SECRET="$JWT_SECRET" DENO_BIN="$DENO_BIN" \
  node "$HERE/e2e/driver.mjs"
