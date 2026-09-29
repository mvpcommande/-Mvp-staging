-- ROLLBACK de 20260929090000_rushour_reconciliation_and_fixes.sql
-- (hors supabase/migrations/ volontairement).
--
-- Dé-planifier d'abord les jobs d'environnement s'ils existent :
--   select cron.unschedule('rushour-reconcile-staging');
--   select cron.unschedule('rushour-dispatch-staging');
--
-- NB : la ré-introduction de UNIQUE(rushour_integration_id) échoue si deux
-- restaurants partagent désormais une intégration : c'est voulu (le
-- rollback ne doit pas supprimer de configuration silencieusement).

begin;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'rushour-reconcile-staging') then
      perform cron.unschedule('rushour-reconcile-staging');
    end if;
  end if;
end $$;

drop function if exists public.rushour_reconcile(interval, integer);

-- Définition Bloc 1 de rushour_enqueue_missing.
create or replace function public.rushour_enqueue_missing(p_since timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_order_id uuid;
begin
  if p_since is null or p_since < now() - interval '7 days' then
    raise exception 'INVALID_SINCE';
  end if;

  for v_order_id in
    select o.id
    from public.orders o
    join public.restaurant_rushour_connections c
      on c.restaurant_id = o.restaurant_id and c.enabled = true
    where o.created_at >= p_since
      and not exists (select 1 from public.rushour_order_outbox b where b.order_id = o.id)
  loop
    if public.rushour_enqueue_order(v_order_id) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;
revoke all on function public.rushour_enqueue_missing(timestamptz) from public, anon, authenticated;
grant execute on function public.rushour_enqueue_missing(timestamptz) to service_role;

delete from public.rushour_sync_events where step = 'RECONCILE';
alter table public.rushour_sync_events drop constraint if exists rushour_sync_events_step_check;
alter table public.rushour_sync_events
  add constraint rushour_sync_events_step_check
  check (step in ('ENQUEUE', 'CLAIM', 'RESOLVE_CONFIG', 'MAP', 'SEND', 'COMPLETE', 'REQUEUE'));

alter table public.restaurant_rushour_connections drop column if exists export_from;

alter table public.restaurant_rushour_connections
  add constraint restaurant_rushour_connections_integration_unique unique (rushour_integration_id);

commit;
