-- Intégration SumUp (OAuth multi-marchands) : chaque restaurant connecte
-- SON compte SumUp. Les tokens servent côté serveur (Edge Function) et ne
-- sont jamais exposés au navigateur.

create table if not exists public.restaurant_sumup_connections (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  merchant_code text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.restaurant_sumup_connections enable row level security;
-- Aucune policy : accès réservé au service_role (Edge Function). Le front
-- ne peut PAS lire les tokens.

create table if not exists public.sumup_oauth_states (
  state text primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.sumup_oauth_states enable row level security;

alter table public.restaurants
  add column if not exists sumup_connected boolean not null default false,
  add column if not exists sumup_merchant_code text;

create or replace function public.sumup_begin_connect()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rid uuid;
  v_state text;
begin
  v_rid := public.current_restaurant_id();
  if v_rid is null or not public.is_restaurant_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  delete from public.sumup_oauth_states where created_at < now() - interval '15 minutes';
  v_state := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.sumup_oauth_states(state, restaurant_id) values (v_state, v_rid);
  return v_state;
end;
$$;
revoke all on function public.sumup_begin_connect() from public, anon;
grant execute on function public.sumup_begin_connect() to authenticated;

-- NB : l'Edge Function sumup-oauth-callback (déployée séparément) consomme
-- le state, échange le code contre les tokens et remplit ces tables.
