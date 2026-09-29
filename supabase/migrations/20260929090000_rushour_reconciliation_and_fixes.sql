-- ============================================================================
-- BLOC RUSHOUR 1.1 — RÉCONCILIATION AUTOMATIQUE + CORRECTIFS
-- MIGRATION À VALIDER — dépend de 20260928090000_rushour_connector_foundation.
-- ============================================================================
--
-- 1. SÉMANTIQUE EXACTE DE L'ENQUEUE (correction de wording du Bloc 1)
--
--    Le trigger orders_rushour_enqueue ABSORBE toute erreur d'enqueue
--    (EXCEPTION WHEN OTHERS) pour ne jamais refuser une commande client.
--    L'outbox n'est donc PAS strictement atomique avec la commande :
--
--    PRIMARY PATH  : INSERT orders -> trigger -> INSERT outbox -> COMMIT
--                    (commande et entrée d'export dans la même transaction)
--    DEGRADED PATH : INSERT orders -> enqueue échoue -> commande COMMITÉE
--                    -> événement ENQUEUE_FAILED -> rushour_reconcile()
--                    (job serveur récurrent) -> entrée outbox recréée
--
--    = "transactional enqueue when possible + automatic reconciliation
--    fallback". Une commande annulée (ROLLBACK) n'a jamais d'entrée outbox ;
--    une commande committée sans entrée est rattrapée par la réconciliation.
--
-- 2. rushour_reconcile() : rattrapage automatique, idempotent, borné,
--    tenant-safe, observable (événement RECONCILE par entrée recréée),
--    sérialisé par verrou consultatif (deux exécutions simultanées ne se
--    marchent pas dessus ; UNIQUE(order_id) + ON CONFLICT DO NOTHING
--    garantissent de toute façon l'absence de doublon).
--    Éligibilité :
--      - restaurant avec connexion RusHour enabled = true ;
--      - commande créée depuis max(connexion.export_from, now() - lookback) ;
--      - commande encore "vivante" : status NEW / ACCEPTED / PREPARING
--        (une commande déjà READY ou CANCELLED a été traitée hors RusHour :
--        la pousser en cuisine après coup créerait une double préparation) ;
--      - aucune entrée outbox.
--
-- 3. export_from (nouvelle colonne) : borne basse d'export par restaurant.
--    À la PREMIÈRE activation, elle vaut l'instant d'activation : activer un
--    restaurant ne renvoie jamais son historique. Une désactivation puis
--    réactivation la CONSERVE : les commandes passées pendant la coupure
--    (dans la fenêtre de lookback) sont rattrapées.
--
-- 4. Suppression de UNIQUE(rushour_integration_id) : la cardinalité
--    integrationId <-> établissement n'est PAS confirmée par la
--    documentation RusHour. On n'impose pas en base un invariant externe
--    inconnu. L'isolation tenant reste portée par la PK restaurant_id, les
--    FK composites et la clé d'export (qui inclut l'order_id).
--
-- ORDONNANCEMENT : volontairement HORS migration (configuration
-- d'environnement, URL + secret) -> supabase/ops/rushour_staging_schedule.sql
-- ROLLBACK : supabase/rollbacks/rollback_20260929090000_rushour_reconciliation_and_fixes.sql
-- ============================================================================

begin;

-- 4. Invariant externe non confirmé : on ne l'impose pas.
alter table public.restaurant_rushour_connections
  drop constraint if exists restaurant_rushour_connections_integration_unique;

-- 3. Borne basse d'export.
alter table public.restaurant_rushour_connections
  add column if not exists export_from timestamptz not null default now();

comment on column public.restaurant_rushour_connections.export_from is
  'Aucune commande créée avant cet instant n''est exportée par la réconciliation. Posée à l''activation ; conservée sur désactivation/réactivation.';

-- Événement RECONCILE.
alter table public.rushour_sync_events
  drop constraint if exists rushour_sync_events_step_check;
alter table public.rushour_sync_events
  add constraint rushour_sync_events_step_check
  check (step in ('ENQUEUE', 'RECONCILE', 'CLAIM', 'RESOLVE_CONFIG', 'MAP', 'SEND', 'COMPLETE', 'REQUEUE'));

-- 2. Réconciliation automatique.
create or replace function public.rushour_reconcile(
  p_lookback interval default interval '24 hours',
  p_limit integer default 200
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_id uuid;
  r record;
begin
  if p_lookback is null or p_lookback <= interval '0' or p_lookback > interval '7 days' then
    raise exception 'INVALID_LOOKBACK';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'INVALID_LIMIT';
  end if;

  -- Une seule réconciliation à la fois (les autres rendent 0 sans attendre).
  if not pg_try_advisory_xact_lock(hashtext('public.rushour_reconcile')) then
    return 0;
  end if;

  for r in
    select o.id as order_id, o.restaurant_id, c.rushour_integration_id
    from public.orders o
    join public.restaurant_rushour_connections c
      on c.restaurant_id = o.restaurant_id and c.enabled = true
    where o.created_at >= greatest(c.export_from, now() - p_lookback)
      and o.status in ('NEW', 'ACCEPTED', 'PREPARING')
      and not exists (select 1 from public.rushour_order_outbox b where b.order_id = o.id)
    order by o.created_at
    limit p_limit
  loop
    v_id := null;
    insert into public.rushour_order_outbox (restaurant_id, order_id, export_key, destination_integration_id)
    values (r.restaurant_id, r.order_id,
            public.rushour_export_key(r.order_id, r.rushour_integration_id),
            r.rushour_integration_id)
    on conflict (order_id) do nothing
    returning id into v_id;

    if v_id is not null then
      v_count := v_count + 1;
      insert into public.rushour_sync_events (outbox_id, restaurant_id, order_id, step, outcome)
      values (v_id, r.restaurant_id, r.order_id, 'RECONCILE', 'RECONCILED');
    end if;
  end loop;

  return v_count;
end;
$$;

-- L'ancien point d'entrée manuel devient un simple alias borné de la
-- réconciliation (même éligibilité, même garantie d'unicité).
create or replace function public.rushour_enqueue_missing(p_since timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_since is null or p_since < now() - interval '7 days' or p_since >= now() then
    raise exception 'INVALID_SINCE';
  end if;
  return public.rushour_reconcile(now() - p_since, 1000);
end;
$$;

revoke all on function public.rushour_reconcile(interval, integer) from public, anon, authenticated;
revoke all on function public.rushour_enqueue_missing(timestamptz) from public, anon, authenticated;
grant execute on function public.rushour_reconcile(interval, integer) to service_role;
grant execute on function public.rushour_enqueue_missing(timestamptz) to service_role;

commit;
