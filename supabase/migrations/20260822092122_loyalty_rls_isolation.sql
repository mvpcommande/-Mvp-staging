create or replace function public.current_restaurant_id() returns uuid language sql stable security invoker set search_path = public as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'restaurant_id', '')::uuid;
$$;

create or replace function public.is_restaurant_admin() returns boolean language sql stable security invoker set search_path = public as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('restaurant_admin','restaurant_owner','platform_admin');
$$;

create policy loyalty_programs_admin_all on public.loyalty_programs
for all to authenticated
using (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id())
with check (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id());

create policy loyalty_rewards_admin_all on public.loyalty_rewards
for all to authenticated
using (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id())
with check (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id());

create policy customers_admin_select on public.customers
for select to authenticated
using (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id());

create policy customers_self_select on public.customers
for select to authenticated
using (auth.uid() is not null and auth_user_id = auth.uid());

create policy customers_self_update on public.customers
for update to authenticated
using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid() and restaurant_id = public.current_restaurant_id());

create policy loyalty_accounts_admin_select on public.loyalty_accounts
for select to authenticated
using (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id());

create policy loyalty_accounts_self_select on public.loyalty_accounts
for select to authenticated
using (exists (select 1 from public.customers c where c.id = customer_id and c.auth_user_id = auth.uid() and c.restaurant_id = loyalty_accounts.restaurant_id));

create policy loyalty_ledger_admin_select on public.loyalty_ledger
for select to authenticated
using (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id());

create policy loyalty_ledger_self_select on public.loyalty_ledger
for select to authenticated
using (exists (select 1 from public.customers c where c.id = customer_id and c.auth_user_id = auth.uid() and c.restaurant_id = loyalty_ledger.restaurant_id));

create policy marketing_consents_admin_all on public.marketing_consents
for all to authenticated
using (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id())
with check (public.is_restaurant_admin() and restaurant_id = public.current_restaurant_id());

create policy marketing_consents_self_select on public.marketing_consents
for select to authenticated
using (exists (select 1 from public.customers c where c.id = customer_id and c.auth_user_id = auth.uid() and c.restaurant_id = marketing_consents.restaurant_id));

create policy marketing_consents_self_update on public.marketing_consents
for update to authenticated
using (exists (select 1 from public.customers c where c.id = customer_id and c.auth_user_id = auth.uid() and c.restaurant_id = marketing_consents.restaurant_id))
with check (exists (select 1 from public.customers c where c.id = customer_id and c.auth_user_id = auth.uid() and c.restaurant_id = marketing_consents.restaurant_id));
