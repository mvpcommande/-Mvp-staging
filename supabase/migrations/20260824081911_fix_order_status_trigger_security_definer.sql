-- This trigger only writes a row derived from the update it's attached to
-- (already validated by the orders RLS policy that let the UPDATE through).
-- It was SECURITY INVOKER, so it ran under the caller's own RLS on
-- order_events, which has no INSERT policy at all -> every status change
-- failed. Audit-log triggers should run with elevated privilege regardless
-- of the caller's own visibility into the log table, same as the rest of
-- this schema's SECURITY DEFINER functions.
create or replace function public.log_order_status_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status is distinct from old.status then
    insert into public.order_events(order_id, from_status, to_status) values (new.id, old.status, new.status);
  end if;
  return new;
end;
$$;
