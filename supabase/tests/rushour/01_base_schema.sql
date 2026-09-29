-- Reconstruction MINIMALE du schéma Foodatoi existant, limitée aux objets
-- lus par la migration RusHour et par create_order(). Les tables de base
-- (products/orders/order_items) ont été créées hors migrations
-- versionnées : leurs colonnes sont reprises des migrations qui les
-- modifient et du RPC create_order().
--
-- create_order() lui-même n'est PAS recopié ici : le runner applique le
-- fichier de migration de production 20260922080200 tel quel.

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  is_active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  options jsonb not null default '{}'::jsonb
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  order_number text not null unique,
  customer_id uuid,
  customer_name text not null default '',
  customer_phone text not null default '',
  pickup_time timestamptz,
  status text not null default 'NEW'
    check (status in ('NEW', 'ACCEPTED', 'PREPARING', 'READY', 'CANCELLED')),
  payment_status text not null default 'PAY_AT_STORE',
  fulfillment_type text not null default 'PICKUP'
    check (fulfillment_type in ('PICKUP', 'DELIVERY')),
  total_cents integer not null check (total_cents >= 0),
  notes text,
  idempotency_key text,
  delivery_address jsonb,
  delivery_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index présent en production (hors migrations, cf. 20260922080200).
create unique index orders_restaurant_idempotency_key
  on public.orders (restaurant_id, idempotency_key)
  where idempotency_key is not null;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id),
  product_name text not null,
  quantity integer not null,
  unit_price_cents integer not null,
  options jsonb not null default '{}'::jsonb,
  line_total_cents integer not null
);

alter table public.orders enable row level security;
alter table public.products enable row level security;

-- Helpers de tenant (définitions reprises des migrations existantes).
create or replace function public.current_restaurant_id() returns uuid
language sql stable security invoker set search_path = public as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'restaurant_id', '')::uuid;
$$;

create or replace function public.is_restaurant_admin() returns boolean
language sql stable security invoker set search_path = public as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('restaurant_admin','restaurant_owner','platform_admin');
$$;

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
