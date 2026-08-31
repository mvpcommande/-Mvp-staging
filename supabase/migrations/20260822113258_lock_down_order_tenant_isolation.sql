begin;

-- Orders: only customers can read their own orders; restaurant staff/admin can read their tenant.
drop policy if exists orders_authenticated_read on public.orders;
drop policy if exists orders_dashboard_read on public.orders;
drop policy if exists orders_dashboard_update on public.orders;
drop policy if exists orders_public_insert on public.orders;

create policy orders_customer_select
on public.orders
for select
 to authenticated
using (
  (customer_id is not null and exists (
    select 1 from public.customers c
    where c.id = orders.customer_id
      and c.auth_user_id = (select auth.uid())
      and c.restaurant_id = orders.restaurant_id
  ))
  or
  (is_restaurant_admin() and restaurant_id = (select current_restaurant_id()))
);

create policy orders_admin_update
on public.orders
for update
 to authenticated
using (
  is_restaurant_admin()
  and restaurant_id = (select current_restaurant_id())
)
with check (
  is_restaurant_admin()
  and restaurant_id = (select current_restaurant_id())
  and status = any (array['NEW','ACCEPTED','PREPARING','READY','CANCELLED']::text[])
);

create policy orders_public_insert
on public.orders
for insert
 to anon, authenticated
with check (
  exists (
    select 1 from public.restaurants r
    where r.id = orders.restaurant_id
      and r.is_active = true
  )
  and (
    customer_id is null
    or exists (
      select 1 from public.customers c
      where c.id = orders.customer_id
        and c.restaurant_id = orders.restaurant_id
    )
  )
);

-- Order items: visibility follows the parent order's tenant/owner visibility.
drop policy if exists order_items_authenticated_read on public.order_items;
drop policy if exists order_items_dashboard_read on public.order_items;
drop policy if exists order_items_public_insert on public.order_items;

create policy order_items_select
on public.order_items
for select
 to authenticated
using (
  exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and (
        (o.customer_id is not null and exists (
          select 1 from public.customers c
          where c.id = o.customer_id
            and c.auth_user_id = (select auth.uid())
            and c.restaurant_id = o.restaurant_id
        ))
        or (is_restaurant_admin() and o.restaurant_id = (select current_restaurant_id()))
      )
  )
);

create policy order_items_public_insert
on public.order_items
for insert
 to anon, authenticated
with check (
  exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
  )
  and (
    product_id is null
    or exists (
      select 1 from public.products p
      join public.orders o on o.id = order_items.order_id
      where p.id = order_items.product_id
        and p.restaurant_id = o.restaurant_id
    )
  )
);

-- Order events are internal operational history: restaurant staff only.
drop policy if exists order_events_authenticated_read on public.order_events;
drop policy if exists order_events_dashboard_read on public.order_events;

create policy order_events_admin_select
on public.order_events
for select
 to authenticated
using (
  is_restaurant_admin()
  and exists (
    select 1 from public.orders o
    where o.id = order_events.order_id
      and o.restaurant_id = (select current_restaurant_id())
  )
);

-- SECURITY DEFINER functions: public clients should not be able to invoke the trigger helper;
-- reward redemption is authenticated-customer-only.
revoke execute on function public.prevent_loyalty_ledger_mutation() from anon, authenticated;
revoke execute on function public.redeem_loyalty_reward(uuid) from anon;
grant execute on function public.redeem_loyalty_reward(uuid) to authenticated;

-- Defense in depth: reward redemption must have an authenticated user.
create or replace function public.redeem_loyalty_reward(p_reward_id uuid)
returns table(reward_id uuid, points_spent bigint, remaining_points bigint)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer public.customers%rowtype;
  v_reward public.loyalty_rewards%rowtype;
  v_account public.loyalty_accounts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED';
  end if;

  select * into v_customer
  from public.customers
  where auth_user_id = auth.uid()
  limit 1;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;

  select * into v_reward
  from public.loyalty_rewards
  where id = p_reward_id
    and restaurant_id = v_customer.restaurant_id
    and is_active = true;
  if not found then raise exception 'REWARD_NOT_FOUND'; end if;

  select * into v_account
  from public.loyalty_accounts
  where restaurant_id = v_customer.restaurant_id
    and customer_id = v_customer.id
  for update;
  if not found then raise exception 'LOYALTY_ACCOUNT_NOT_FOUND'; end if;
  if v_account.balance_points < v_reward.cost_points then raise exception 'INSUFFICIENT_POINTS'; end if;

  insert into public.loyalty_ledger
    (restaurant_id, customer_id, loyalty_account_id, amount_points, transaction_type, reference_type, reference_id, metadata)
  values
    (v_customer.restaurant_id, v_customer.id, v_account.id, -v_reward.cost_points, 'REWARD_REDEEM', 'REWARD', v_reward.id,
     jsonb_build_object('reward_name', v_reward.name));

  update public.loyalty_accounts
     set balance_points = balance_points - v_reward.cost_points,
         lifetime_redeemed_points = lifetime_redeemed_points + v_reward.cost_points,
         updated_at = now()
   where id = v_account.id
  returning balance_points into remaining_points;

  reward_id := v_reward.id;
  points_spent := v_reward.cost_points;
  return next;
end;
$function$;

-- Foreign-key indexes for tenant/customer/loyalty lookups.
create index if not exists idx_customers_auth_user_id on public.customers(auth_user_id);
create index if not exists idx_loyalty_accounts_customer_id on public.loyalty_accounts(customer_id);
create index if not exists idx_loyalty_ledger_customer_id on public.loyalty_ledger(customer_id);
create index if not exists idx_marketing_consents_customer_id on public.marketing_consents(customer_id);
create index if not exists idx_marketing_consent_events_customer_id on public.marketing_consent_events(customer_id);
create index if not exists idx_orders_restaurant_id on public.orders(restaurant_id);
create index if not exists idx_orders_customer_id on public.orders(customer_id);
create index if not exists idx_order_items_order_id on public.order_items(order_id);
create index if not exists idx_order_events_order_id on public.order_events(order_id);

commit;
