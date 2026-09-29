-- ROLLBACK de 20260928090000_rushour_connector_foundation.sql
-- (volontairement hors de supabase/migrations/ pour ne jamais être
-- ramassé comme migration).
--
-- ATTENTION : supprime la configuration RusHour, les mappings produit,
-- l'outbox (état d'export de chaque commande) et le journal. Les
-- commandes Foodatoi elles-mêmes ne sont PAS touchées.
-- Exporter d'abord si besoin :
--   copy (select * from public.rushour_order_outbox) to stdout csv header;

begin;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'purge-rushour-sync-events') then
      perform cron.unschedule('purge-rushour-sync-events');
    end if;
  end if;
end $$;

drop trigger if exists orders_rushour_enqueue on public.orders;

drop function if exists public.rushour_enqueue_missing(timestamptz);
drop function if exists public.rushour_requeue(uuid);
drop function if exists public.rushour_mark_failed(uuid, text, text, text, text, integer);
drop function if exists public.rushour_mark_sent(uuid, text, text);
drop function if exists public.rushour_claim_outbox(text, integer);
drop function if exists public.rushour_enqueue_after_order_insert();
drop function if exists public.rushour_enqueue_order(uuid);
drop function if exists public.rushour_export_key(uuid, text);

drop table if exists public.rushour_sync_events;
drop table if exists public.rushour_order_outbox;
drop table if exists public.rushour_product_mappings;
drop table if exists public.restaurant_rushour_connections;

drop index if exists public.orders_id_restaurant_id_key;
drop index if exists public.products_id_restaurant_id_key;

commit;

-- Vérification :
--   select to_regclass('public.rushour_order_outbox');           -- NULL
--   select tgname from pg_trigger where tgname = 'orders_rushour_enqueue';  -- 0 ligne
