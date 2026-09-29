-- ============================================================================
-- BLOC RUSHOUR 2 — PAYMENT GATE CONFIGURABLE, STATUT UNCERTAIN, GARDE-FOUS
-- LIVE, OBSERVABILITÉ. Dépend de 20260928090000 / 20260929090000 / 20260929100000.
-- ============================================================================
--
-- 1. PAYMENT GATE (liste blanche, fail closed)
--    Une commande n'est éligible à l'export que si :
--      payment_status = 'PAID'
--      OU (payment_status = 'PAY_AT_STORE' ET la connexion n'exige pas le
--          paiement : payment_required = false)
--    => PENDING (paiement en ligne non confirmé), FAILED, statut inconnu :
--       JAMAIS exportés. payment_required est configurable PAR RESTAURANT
--       (défaut false : comportement historique Foodatoi préservé).
--
-- 2. STATUT UNCERTAIN
--    Tant que la déduplication RusHour sur externalId n'est pas confirmée
--    par la documentation officielle, un envoi AMBIGU (timeout après
--    POST, coupure réseau, réponse 2xx illisible, worker mort pendant
--    l'envoi) ne doit PAS être rejoué automatiquement : risque de double
--    commande en cuisine. L'entrée passe UNCERTAIN, n'est plus jamais
--    réclamée, et doit être résolue par un humain après vérification côté
--    RusHour : rushour_resolve_uncertain(order_id, exists_in_rushour, ext_id).
--
-- 3. Reprise de bail configurable : rushour_claim_outbox(..., p_reclaim_stale)
--    true  (mock / dédup confirmée)  : un SENDING expiré est repris ;
--    false (live, dédup non confirmée): un SENDING expiré passe UNCERTAIN.
--
-- 4. target_environment ('test' | 'production') par connexion : le client
--    HTTP réel refuse toute cible hors de sa liste autorisée (Bloc 2 : test).
--
-- 5. Observabilité : duration_ms / endpoint sur rushour_sync_events ; vue
--    rushour_dispatch_metrics (security_invoker : RLS appliquée).
-- ROLLBACK : supabase/rollbacks/rollback_20260930090000_rushour_bloc2_payment_gate_uncertain.sql
-- ============================================================================

begin;

-- 1 & 4. Configuration par connexion -----------------------------------------
alter table public.restaurant_rushour_connections
  add column if not exists payment_required boolean not null default false,
  add column if not exists target_environment text not null default 'test';

alter table public.restaurant_rushour_connections
  drop constraint if exists restaurant_rushour_connections_target_env_check;
alter table public.restaurant_rushour_connections
  add constraint restaurant_rushour_connections_target_env_check
  check (target_environment in ('test', 'production'));

comment on column public.restaurant_rushour_connections.payment_required is
  'true : seules les commandes payment_status = PAID sont exportées. false : PAID ou PAY_AT_STORE. PENDING jamais.';
comment on column public.restaurant_rushour_connections.target_environment is
  'Environnement RusHour de la destination. Le client HTTP réel refuse toute cible non autorisée (Bloc 2 : test uniquement).';

-- 2. Statut UNCERTAIN -----------------------------------------------------------
alter table public.rushour_order_outbox
  drop constraint if exists rushour_order_outbox_status_check;
alter table public.rushour_order_outbox
  add constraint rushour_order_outbox_status_check
  check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN'));

-- 5. Observabilité ---------------------------------------------------------------
alter table public.rushour_sync_events
  add column if not exists duration_ms integer,
  add column if not exists endpoint text;
alter table public.rushour_sync_events
  drop constraint if exists rushour_sync_events_bloc2_check;
alter table public.rushour_sync_events
  add constraint rushour_sync_events_bloc2_check
  check ((duration_ms is null or duration_ms >= 0)
     and (endpoint is null or char_length(endpoint) <= 64));
alter table public.rushour_sync_events
  drop constraint if exists rushour_sync_events_step_check;
alter table public.rushour_sync_events
  add constraint rushour_sync_events_step_check
  check (step in ('ENQUEUE', 'RECONCILE', 'CLAIM', 'RESOLVE_CONFIG', 'MAP', 'SEND', 'COMPLETE', 'REQUEUE', 'RESOLVE'));

-- 1 & 3. Réclamation : payment gate + reprise de bail configurable -------------
drop function if exists public.rushour_claim_outbox(text, integer);

create or replace function public.rushour_claim_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_reclaim_stale boolean default true
)
returns setof public.rushour_order_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 then
    raise exception 'INVALID_WORKER_ID';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_LIMIT';
  end if;
  if p_reclaim_stale is null then
    raise exception 'INVALID_RECLAIM_MODE';
  end if;

  -- Bail expiré : worker mort pendant l'envoi.
  --  - reprise interdite (dédup non confirmée) -> UNCERTAIN (revue humaine) ;
  --  - tentatives épuisées -> FAILED.
  update public.rushour_order_outbox
     set status = case when p_reclaim_stale then 'FAILED' else 'UNCERTAIN' end,
         locked_at = null,
         locked_by = null,
         last_error_code = case when p_reclaim_stale then 'LEASE_EXPIRED_MAX_ATTEMPTS' else 'LEASE_EXPIRED_UNCERTAIN' end,
         last_error_category = case when p_reclaim_stale then 'UNKNOWN' else 'UNCERTAIN' end,
         last_error = case when p_reclaim_stale
                        then 'Bail expiré sans résultat après la dernière tentative'
                        else 'Bail expiré pendant un envoi : existence côté RusHour à vérifier' end
   where status = 'SENDING'
     and locked_at < now() - interval '10 minutes'
     and (attempts >= max_attempts or not p_reclaim_stale);

  return query
  with candidates as (
    select b.id
    from public.rushour_order_outbox b
    join public.restaurant_rushour_connections c
      on c.restaurant_id = b.restaurant_id and c.enabled = true
    join public.orders o
      on o.id = b.order_id
    where b.attempts < b.max_attempts
      and (
        (b.status = 'PENDING' and b.next_attempt_at <= now())
        or (p_reclaim_stale and b.status = 'SENDING' and b.locked_at < now() - interval '10 minutes')
      )
      -- PAYMENT GATE (liste blanche) : tout statut non listé est bloqué.
      and (
        o.payment_status = 'PAID'
        or (o.payment_status = 'PAY_AT_STORE' and c.payment_required = false)
      )
    order by b.next_attempt_at, b.created_at
    limit p_limit
    for update of b skip locked
  )
  update public.rushour_order_outbox b
     set status = 'SENDING',
         locked_at = now(),
         locked_by = p_worker_id,
         attempts = b.attempts + 1
    from candidates
   where b.id = candidates.id
  returning b.*;
end;
$$;

-- 2. Transition vers UNCERTAIN (conditionnée au bail) ---------------------------
create or replace function public.rushour_mark_uncertain(
  p_outbox_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rushour_order_outbox
     set status = 'UNCERTAIN',
         locked_at = null,
         locked_by = null,
         last_error_code = left(coalesce(p_error_code, 'COMPLETION_UNCERTAIN'), 64),
         last_error_category = 'UNCERTAIN',
         last_error = left(p_error_message, 500)
   where id = p_outbox_id
     and status = 'SENDING'
     and locked_by = p_worker_id;
  if not found then
    return 'LEASE_LOST';
  end if;
  return 'UNCERTAIN';
end;
$$;

-- 2. Résolution humaine d'une entrée UNCERTAIN ---------------------------------
--    p_exists_in_rushour = true  : la commande existe côté RusHour -> SENT
--    p_exists_in_rushour = false : elle n'existe pas -> PENDING (réessai),
--                                  même clé d'export, compteur remis à 0.
create or replace function public.rushour_resolve_uncertain(
  p_order_id uuid,
  p_exists_in_rushour boolean,
  p_external_order_id text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.rushour_order_outbox;
begin
  if p_exists_in_rushour is null then
    raise exception 'RESOLUTION_REQUIRED';
  end if;

  select b.* into v_row
  from public.rushour_order_outbox b
  where b.order_id = p_order_id and b.status = 'UNCERTAIN'
  for update;
  if not found then
    return 'NOT_UNCERTAIN';
  end if;

  if p_exists_in_rushour then
    update public.rushour_order_outbox
       set status = 'SENT', sent_at = now(), external_order_id = p_external_order_id,
           last_error_code = null, last_error_category = null, last_error = null
     where id = v_row.id;
  else
    update public.rushour_order_outbox
       set status = 'PENDING', attempts = 0, next_attempt_at = now()
     where id = v_row.id;
  end if;

  insert into public.rushour_sync_events (outbox_id, restaurant_id, order_id, step, outcome, attempt, error_code)
  values (v_row.id, v_row.restaurant_id, p_order_id, 'RESOLVE',
          case when p_exists_in_rushour then 'RESOLVED_SENT' else 'RESOLVED_REQUEUED' end,
          v_row.attempts, v_row.last_error_code);

  return case when p_exists_in_rushour then 'SENT' else 'PENDING' end;
end;
$$;

-- 5. Métriques (RLS des événements appliquée via security_invoker) -------------
create or replace view public.rushour_dispatch_metrics
with (security_invoker = true) as
select
  e.restaurant_id,
  date_trunc('day', e.created_at) as day,
  count(*) filter (where e.step = 'COMPLETE' and e.outcome = 'SENT')        as rushour_dispatch_success,
  count(*) filter (where e.outcome = 'FAILED')                              as rushour_dispatch_failed,
  count(*) filter (where e.outcome = 'RETRY_SCHEDULED')                     as rushour_dispatch_retry,
  count(*) filter (where e.outcome = 'COMPLETION_UNCERTAIN')                as rushour_dispatch_uncertain,
  count(*) filter (where e.error_category = 'AUTH_ERROR')                   as rushour_auth_error,
  count(*) filter (where e.error_category = 'MAPPING_ERROR')                as rushour_mapping_error,
  round(avg(e.duration_ms) filter (where e.duration_ms is not null))::integer as avg_send_duration_ms
from public.rushour_sync_events e
group by e.restaurant_id, date_trunc('day', e.created_at);

revoke all on public.rushour_dispatch_metrics from public, anon, authenticated;
grant select on public.rushour_dispatch_metrics to authenticated, service_role;

-- Privilèges ------------------------------------------------------------------------
revoke all on function public.rushour_claim_outbox(text, integer, boolean) from public, anon, authenticated;
revoke all on function public.rushour_mark_uncertain(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.rushour_resolve_uncertain(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.rushour_claim_outbox(text, integer, boolean) to service_role;
grant execute on function public.rushour_mark_uncertain(uuid, text, text, text) to service_role;
grant execute on function public.rushour_resolve_uncertain(uuid, boolean, text) to service_role;

commit;
