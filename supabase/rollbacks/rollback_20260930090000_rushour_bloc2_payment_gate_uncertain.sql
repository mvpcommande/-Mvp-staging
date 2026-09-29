-- ROLLBACK de 20260930090000_rushour_bloc2_payment_gate_uncertain.sql
-- ATTENTION : les entrées UNCERTAIN sont repassées FAILED (elles restent
-- à vérifier côté RusHour avant tout requeue).
begin;

drop view if exists public.rushour_dispatch_metrics;
drop function if exists public.rushour_resolve_uncertain(uuid, boolean, text);
drop function if exists public.rushour_mark_uncertain(uuid, text, text, text);
drop function if exists public.rushour_claim_outbox(text, integer, boolean);

update public.rushour_order_outbox
   set status = 'FAILED', last_error_code = 'UNCERTAIN_ROLLED_BACK'
 where status = 'UNCERTAIN';

alter table public.rushour_order_outbox drop constraint if exists rushour_order_outbox_status_check;
alter table public.rushour_order_outbox add constraint rushour_order_outbox_status_check
  check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED'));

delete from public.rushour_sync_events where step = 'RESOLVE';
alter table public.rushour_sync_events drop constraint if exists rushour_sync_events_step_check;
alter table public.rushour_sync_events add constraint rushour_sync_events_step_check
  check (step in ('ENQUEUE', 'RECONCILE', 'CLAIM', 'RESOLVE_CONFIG', 'MAP', 'SEND', 'COMPLETE', 'REQUEUE'));
alter table public.rushour_sync_events drop constraint if exists rushour_sync_events_bloc2_check;
alter table public.rushour_sync_events drop column if exists duration_ms, drop column if exists endpoint;

alter table public.restaurant_rushour_connections drop constraint if exists restaurant_rushour_connections_target_env_check;
alter table public.restaurant_rushour_connections
  drop column if exists payment_required,
  drop column if exists target_environment;

-- Définition Bloc 1 de rushour_claim_outbox (2 arguments).
create or replace function public.rushour_claim_outbox(p_worker_id text, p_limit integer default 10)
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
  update public.rushour_order_outbox
     set status = 'FAILED', locked_at = null, locked_by = null,
         last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS', last_error_category = 'UNKNOWN',
         last_error = 'Bail expiré sans résultat après la dernière tentative'
   where status = 'SENDING' and locked_at < now() - interval '10 minutes' and attempts >= max_attempts;
  return query
  with candidates as (
    select b.id
    from public.rushour_order_outbox b
    join public.restaurant_rushour_connections c on c.restaurant_id = b.restaurant_id and c.enabled = true
    join public.orders o on o.id = b.order_id
    where b.attempts < b.max_attempts
      and ((b.status = 'PENDING' and b.next_attempt_at <= now())
        or (b.status = 'SENDING' and b.locked_at < now() - interval '10 minutes'))
      and o.payment_status is distinct from 'PENDING'
    order by b.next_attempt_at, b.created_at
    limit p_limit
    for update of b skip locked
  )
  update public.rushour_order_outbox b
     set status = 'SENDING', locked_at = now(), locked_by = p_worker_id, attempts = b.attempts + 1
    from candidates where b.id = candidates.id
  returning b.*;
end;
$$;
revoke all on function public.rushour_claim_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.rushour_claim_outbox(text, integer) to service_role;

commit;
