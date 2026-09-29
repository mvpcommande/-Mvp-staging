#!/usr/bin/env bash
# Tests Postgres RÉELS de la migration RusHour (RLS, trigger d'enqueue via
# le vrai create_order(), cycle de vie worker, concurrence SKIP LOCKED,
# parité clé d'export JS/SQL).
#
# Usage : RUSHOUR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
#           bash supabase/tests/rushour/run.sh
#
# Le script CRÉE puis SUPPRIME une base jetable "rushour_test_<pid>" sur ce
# serveur. Garde-fou : il refuse toute URL qui n'est pas locale, pour ne
# jamais pouvoir viser un projet Supabase (staging ou prod).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/supabase/tests/rushour"
ADMIN_URL="${RUSHOUR_TEST_DATABASE_URL:?RUSHOUR_TEST_DATABASE_URL requis (serveur Postgres LOCAL)}"

case "$ADMIN_URL" in
  *@localhost:*|*@localhost/*|*@127.0.0.1:*|*@127.0.0.1/*|*@postgres:*) ;;
  *) echo "REFUS : RUSHOUR_TEST_DATABASE_URL doit viser un Postgres local jetable." >&2; exit 2 ;;
esac

DB="rushour_test_$$"
BASE="${ADMIN_URL%/*}"
URL="$BASE/$DB"
PSQL=(psql -X -v ON_ERROR_STOP=1 -q)

cleanup() { "${PSQL[@]}" "$ADMIN_URL" -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${PSQL[@]}" "$ADMIN_URL" -c "create database $DB" >/dev/null

echo "# schéma : stub Supabase + base Foodatoi minimale"
"${PSQL[@]}" "$URL" -f "$HERE/00_supabase_stub.sql" >/dev/null
"${PSQL[@]}" "$URL" -f "$HERE/01_base_schema.sql" >/dev/null

echo "# create_order() de production (migration 20260922080200, telle quelle)"
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/migrations/20260922080200_enforce_idempotency_key_uniqueness.sql" >/dev/null

echo "# migrations RusHour (Bloc 1 + Bloc 1.1)"
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/migrations/20260928090000_rushour_connector_foundation.sql" >/dev/null
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/migrations/20260929090000_rushour_reconciliation_and_fixes.sql" >/dev/null

JS_KEY="$(cd "$ROOT" && node --input-type=module -e "
import { computeExportKey } from './supabase/functions/_shared/rushour/idempotency.mjs';
console.log(await computeExportKey({ orderId: 'd0000000-0000-4000-8000-000000000042', integrationId: 'test-integration-a' }));
")"

echo "# tests fonctionnels"
"${PSQL[@]}" "$URL" -v js_export_key="$JS_KEY" -f "$HERE/10_rushour_tests.sql" 2>&1 \
  | sed -n "s/^psql:[^N]*NOTICE:  //p; /^SQL tests/p; /ERROR/p"

echo "# concurrence : 8 workers simultanés sur 40 commandes"
"${PSQL[@]}" "$URL" >/dev/null <<'SQL'
delete from public.rushour_order_outbox;
update public.restaurant_rushour_connections set enabled = true;
insert into public.orders (restaurant_id, order_number, total_cents, pickup_time)
select '0a000000-0000-4000-8000-00000000000a', 'CONC-' || g, 100, now() + interval '1 hour'
from generate_series(1, 40) g;
SQL

OUT="$(mktemp -d)"
for w in $(seq 1 8); do
  (
    for _ in $(seq 1 30); do
      ids="$("${PSQL[@]}" -tA "$URL" -c "
        with c as (select id from public.rushour_claim_outbox('worker-$w', 3))
        select string_agg(id::text, ' ') from c;")"
      [ -z "$ids" ] && break
      for id in $ids; do
        echo "$id" >> "$OUT/worker-$w"
        "${PSQL[@]}" -tA "$URL" -c "select public.rushour_mark_sent('$id', 'worker-$w', null)" >/dev/null
      done
    done
  ) &
done
wait

claimed_total="$(cat "$OUT"/worker-* 2>/dev/null | wc -l | tr -d ' ')"
claimed_unique="$(cat "$OUT"/worker-* 2>/dev/null | sort -u | wc -l | tr -d ' ')"
workers_used="$(ls "$OUT" | wc -l | tr -d ' ')"
stats="$("${PSQL[@]}" -tA "$URL" -c "
  select count(*) filter (where b.status = 'SENT') || ' ' || count(*) || ' ' || max(b.attempts)
  from public.rushour_order_outbox b join public.orders o on o.id = b.order_id
  where o.order_number like 'CONC-%';")"
read -r sent total max_attempts <<<"$stats"
rm -rf "$OUT"

if [ "$claimed_total" = "40" ] && [ "$claimed_unique" = "40" ] && [ "$sent" = "40" ] && [ "$total" = "40" ] && [ "$max_attempts" = "1" ]; then
  echo "ok - 40 entrées, $workers_used workers concurrents : chaque entrée réclamée exactement une fois, 40 SENT, attempts=1"
else
  echo "FAIL - concurrence : réclamées=$claimed_total uniques=$claimed_unique sent=$sent total=$total max_attempts=$max_attempts" >&2
  exit 1
fi

echo "# concurrence : un worker garde ses lignes verrouillées pendant qu'un autre réclame"
"${PSQL[@]}" "$URL" >/dev/null <<'SQL'
insert into public.orders (restaurant_id, order_number, total_cents, pickup_time)
select '0a000000-0000-4000-8000-00000000000a', 'LOCK-' || g, 100, now() + interval '1 hour'
from generate_series(1, 10) g;
SQL
A_FILE="$(mktemp)"
(
  "${PSQL[@]}" -tA "$URL" >"$A_FILE" <<'SQL'
begin;
create temp table held as select id from public.rushour_claim_outbox('worker-slow', 4);
select id from held;
select pg_sleep(3);
commit;
SQL
) &
# Attente déterministe (pas de sleep arbitraire) : le worker lent a réclamé
# et tient ses verrous dès que sa session est dans pg_sleep.
for _ in $(seq 1 100); do
  holding="$("${PSQL[@]}" -tA "$URL" -c "
    select count(*) from pg_stat_activity
    where datname = current_database() and state = 'active' and query like 'select pg_sleep(3)%'")"
  [ "$holding" = "1" ] && break
  sleep 0.1
done
B_IDS="$("${PSQL[@]}" -tA "$URL" -c "select id from public.rushour_claim_outbox('worker-fast', 100)")"
wait
A_IDS="$(grep -E '^[0-9a-f-]{36}$' "$A_FILE" || true)"
rm -f "$A_FILE"
overlap="$(comm -12 <(echo "$A_IDS" | sort) <(echo "$B_IDS" | sort) | grep -c . || true)"
a_count="$(echo "$A_IDS" | grep -c . || true)"
b_count="$(echo "$B_IDS" | grep -c . || true)"
if [ "$a_count" = "4" ] && [ "$b_count" = "6" ] && [ "$overlap" = "0" ]; then
  echo "ok - SKIP LOCKED : worker lent=4, worker rapide=6, intersection=0"
else
  echo "FAIL - SKIP LOCKED : lent=$a_count rapide=$b_count intersection=$overlap" >&2
  exit 1
fi

echo "# réconciliation concurrente : 6 exécutions simultanées sur 30 commandes sans outbox"
"${PSQL[@]}" "$URL" >/dev/null <<'SQL'
create function public.t_boom() returns trigger language plpgsql as $$ begin raise exception 'outage'; end $$;
create trigger t_boom before insert on public.rushour_order_outbox for each row execute function public.t_boom();
insert into public.orders (restaurant_id, order_number, total_cents, pickup_time)
select '0a000000-0000-4000-8000-00000000000a', 'RECON-' || g, 100, now() + interval '1 hour'
from generate_series(1, 30) g;
drop trigger t_boom on public.rushour_order_outbox;
drop function public.t_boom();
SQL
missing_before="$("${PSQL[@]}" -tA "$URL" -c "select count(*) from public.orders o where o.order_number like 'RECON-%'
  and not exists (select 1 from public.rushour_order_outbox b where b.order_id = o.id)")"
for _ in $(seq 1 6); do "${PSQL[@]}" -tA "$URL" -c "select public.rushour_reconcile()" >/dev/null & done
wait
"${PSQL[@]}" -tA "$URL" -c "select public.rushour_reconcile()" >/dev/null
recon="$("${PSQL[@]}" -tA "$URL" -c "select count(*) || ' ' || count(distinct b.order_id) from public.rushour_order_outbox b
  join public.orders o on o.id = b.order_id where o.order_number like 'RECON-%'")"
read -r recon_rows recon_orders <<<"$recon"
if [ "$missing_before" = "30" ] && [ "$recon_rows" = "30" ] && [ "$recon_orders" = "30" ]; then
  echo "ok - 30 commandes sans outbox, 7 réconciliations (dont 6 concurrentes) : 30 entrées, aucune en double"
else
  echo "FAIL - réconciliation concurrente : avant=$missing_before lignes=$recon_rows commandes=$recon_orders" >&2
  exit 1
fi

echo "# rollback (Bloc 1.1 puis Bloc 1)"
"${PSQL[@]}" "$URL" -c "update public.restaurant_rushour_connections set rushour_integration_id = 'itg-' || left(restaurant_id::text, 8)" >/dev/null
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/rollbacks/rollback_20260929090000_rushour_reconciliation_and_fixes.sql" >/dev/null
echo "ok - rollback Bloc 1.1 appliqué"
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/rollbacks/rollback_20260928090000_rushour_connector_foundation.sql" >/dev/null
left_over="$("${PSQL[@]}" -tA "$URL" -c "
  select count(*) from pg_class where relname like 'rushour%' or relname = 'restaurant_rushour_connections'")"
triggers="$("${PSQL[@]}" -tA "$URL" -c "select count(*) from pg_trigger where tgname = 'orders_rushour_enqueue'")"
orders_ok="$("${PSQL[@]}" -tA "$URL" -c "select count(*) > 0 from public.orders")"
if [ "$left_over" = "0" ] && [ "$triggers" = "0" ] && [ "$orders_ok" = "t" ]; then
  echo "ok - rollback propre : objets RusHour supprimés, commandes intactes"
else
  echo "FAIL - rollback : restes=$left_over triggers=$triggers" >&2
  exit 1
fi

echo "# migration ré-appliquée après rollback"
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/migrations/20260928090000_rushour_connector_foundation.sql" >/dev/null
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/migrations/20260929090000_rushour_reconciliation_and_fixes.sql" >/dev/null
echo "ok - migrations ré-applicables après rollback"

echo "# ALL RUSHOUR DB TESTS PASSED"
