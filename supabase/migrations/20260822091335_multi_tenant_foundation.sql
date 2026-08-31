create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_url text,
  primary_color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restaurants_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

insert into public.restaurants (slug, name)
values ('caz-food', 'Caz Food')
on conflict (slug) do nothing;

alter table public.products add column if not exists restaurant_id uuid;
alter table public.orders add column if not exists restaurant_id uuid;

update public.products
set restaurant_id = (select id from public.restaurants where slug = 'caz-food')
where restaurant_id is null;

update public.orders
set restaurant_id = (select id from public.restaurants where slug = 'caz-food')
where restaurant_id is null;

alter table public.products alter column restaurant_id set not null;
alter table public.orders alter column restaurant_id set not null;

alter table public.products
  add constraint products_restaurant_id_fkey
  foreign key (restaurant_id) references public.restaurants(id) on delete restrict;

alter table public.orders
  add constraint orders_restaurant_id_fkey
  foreign key (restaurant_id) references public.restaurants(id) on delete restrict;

create index if not exists products_restaurant_active_idx
  on public.products (restaurant_id, is_active, sort_order);

create index if not exists orders_restaurant_status_created_idx
  on public.orders (restaurant_id, status, created_at desc);

create index if not exists order_items_product_id_idx
  on public.order_items (product_id);

create index if not exists order_events_order_id_created_idx
  on public.order_events (order_id, created_at desc);

alter table public.restaurants enable row level security;

create policy restaurants_public_read_active
  on public.restaurants
  for select
  to anon, authenticated
  using (is_active = true);

comment on table public.restaurants is 'Tenant/establishment configuration for the Caz Food ordering platform.';
comment on column public.products.restaurant_id is 'Tenant owning this product.';
comment on column public.orders.restaurant_id is 'Tenant owning this order.';
