-- Loyalty Engine: transactional, server-authoritative and idempotent.
-- Link orders to tenant-scoped customer records before loyalty is evaluated.

alter table public.orders add column if not exists customer_id uuid references public.customers(id);
create index if not exists orders_customer_id_idx on public.orders(customer_id);

create or replace function public.ensure_order_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  if new.customer_id is not null then
    return new;
  end if;

  select c.id into v_customer_id
  from public.customers c
  where c.restaurant_id = new.restaurant_id
    and c.phone = new.customer_phone
  order by c.created_at
  limit 1;

  if v_customer_id is null then
    insert into public.customers (restaurant_id, name, phone)
    values (new.restaurant_id, new.customer_name, new.customer_phone)
    returning id into v_customer_id;
  else
    update public.customers
       set name = coalesce(nullif(new.customer_name, ''), name),
           updated_at = now()
     where id = v_customer_id;
  end if;

  new.customer_id := v_customer_id;
  return new;
end;
$$;

drop trigger if exists orders_link_customer on public.orders;
create trigger orders_link_customer
before insert on public.orders
for each row execute function public.ensure_order_customer();

create or replace function public.earn_loyalty_for_order(p_order_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_program public.loyalty_programs%rowtype;
  v_account public.loyalty_accounts%rowtype;
  v_points bigint;
  v_existing bigint;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'READY' then return 0; end if;
  if v_order.customer_id is null then return 0; end if;

  select * into v_program
  from public.loyalty_programs
  where restaurant_id = v_order.restaurant_id and is_active = true
  limit 1;
  if not found then return 0; end if;

  -- Idempotency: one order can only create one ORDER_EARN entry.
  select id into v_existing
  from public.loyalty_ledger
  where restaurant_id = v_order.restaurant_id
    and reference_type = 'ORDER'
    and reference_id = v_order.id
    and transaction_type = 'ORDER_EARN'
  limit 1;
  if v_existing is not null then return 0; end if;

  if v_program.earn_mode = 'points_per_euro' then
    v_points := floor((v_order.total_cents::numeric / 100) * v_program.points_per_euro)::bigint;
  elsif v_program.earn_mode = 'orders' then
    v_points := 1;
  else
    return 0;
  end if;

  if v_points <= 0 then return 0; end if;

  insert into public.loyalty_accounts (restaurant_id, customer_id)
  values (v_order.restaurant_id, v_order.customer_id)
  on conflict (restaurant_id, customer_id) do nothing;

  select * into v_account
  from public.loyalty_accounts
  where restaurant_id = v_order.restaurant_id
    and customer_id = v_order.customer_id
  for update;

  insert into public.loyalty_ledger
    (restaurant_id, customer_id, loyalty_account_id, amount_points, transaction_type, reference_type, reference_id, metadata)
  values
    (v_order.restaurant_id, v_order.customer_id, v_account.id, v_points, 'ORDER_EARN', 'ORDER', v_order.id,
     jsonb_build_object('total_cents', v_order.total_cents, 'program_id', v_program.id));

  update public.loyalty_accounts
     set balance_points = balance_points + v_points,
         lifetime_earned_points = lifetime_earned_points + v_points,
         updated_at = now()
   where id = v_account.id;

  return v_points;
end;
$$;

create or replace function public.process_order_loyalty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'READY' and old.status is distinct from new.status then
    perform public.earn_loyalty_for_order(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_loyalty_on_ready on public.orders;
create trigger orders_loyalty_on_ready
after update of status on public.orders
for each row execute function public.process_order_loyalty();

create or replace function public.redeem_loyalty_reward(p_reward_id uuid)
returns table (reward_id uuid, points_spent bigint, remaining_points bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers%rowtype;
  v_reward public.loyalty_rewards%rowtype;
  v_account public.loyalty_accounts%rowtype;
begin
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
$$;

revoke all on function public.earn_loyalty_for_order(uuid) from public, anon, authenticated;
revoke all on function public.process_order_loyalty() from public, anon, authenticated;
revoke all on function public.ensure_order_customer() from public, anon, authenticated;
grant execute on function public.redeem_loyalty_reward(uuid) to authenticated;

-- Defensive uniqueness for idempotent order earning.
create unique index if not exists loyalty_ledger_order_earn_unique
on public.loyalty_ledger (restaurant_id, reference_id)
where transaction_type = 'ORDER_EARN' and reference_type = 'ORDER';
