create table if not exists public.restaurant_domains (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  hostname text not null,
  is_primary boolean not null default false,
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique(hostname),
  unique(restaurant_id, hostname)
);

create index if not exists restaurant_domains_restaurant_id_idx on public.restaurant_domains(restaurant_id);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null,
  public_url text,
  alt_text text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique(storage_path)
);

create index if not exists product_images_restaurant_id_idx on public.product_images(restaurant_id);
create index if not exists product_images_product_id_idx on public.product_images(product_id);

create table if not exists public.menu_imports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  source_type text not null check (source_type in ('pdf','image','csv','manual','url')),
  storage_path text,
  source_url text,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','REVIEW','COMPLETED','FAILED')),
  extracted_payload jsonb not null default '{}'::jsonb,
  review_required boolean not null default true,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists menu_imports_restaurant_id_idx on public.menu_imports(restaurant_id);
create index if not exists menu_imports_status_idx on public.menu_imports(status);

alter table public.restaurant_domains enable row level security;
alter table public.product_images enable row level security;
alter table public.menu_imports enable row level security;

create policy restaurant_domains_member_select on public.restaurant_domains for select to authenticated using (restaurant_id = public.current_restaurant_id());
create policy restaurant_domains_member_insert on public.restaurant_domains for insert to authenticated with check (restaurant_id = public.current_restaurant_id());
create policy restaurant_domains_member_update on public.restaurant_domains for update to authenticated using (restaurant_id = public.current_restaurant_id()) with check (restaurant_id = public.current_restaurant_id());

create policy product_images_member_select on public.product_images for select to authenticated using (restaurant_id = public.current_restaurant_id());
create policy product_images_member_insert on public.product_images for insert to authenticated with check (restaurant_id = public.current_restaurant_id());
create policy product_images_member_update on public.product_images for update to authenticated using (restaurant_id = public.current_restaurant_id()) with check (restaurant_id = public.current_restaurant_id());
create policy product_images_member_delete on public.product_images for delete to authenticated using (restaurant_id = public.current_restaurant_id());

create policy menu_imports_member_select on public.menu_imports for select to authenticated using (restaurant_id = public.current_restaurant_id());
create policy menu_imports_member_insert on public.menu_imports for insert to authenticated with check (restaurant_id = public.current_restaurant_id());
create policy menu_imports_member_update on public.menu_imports for update to authenticated using (restaurant_id = public.current_restaurant_id()) with check (restaurant_id = public.current_restaurant_id());

create or replace function public.set_menu_import_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists menu_imports_set_updated_at on public.menu_imports;
create trigger menu_imports_set_updated_at before update on public.menu_imports for each row execute function public.set_menu_import_updated_at();

create or replace function public.provision_restaurant(p_name text, p_slug text, p_sector text, p_domain text default null)
returns public.restaurants
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.restaurants;
  normalized_domain text := nullif(lower(trim(p_domain)), '');
begin
  if (select auth.uid()) is null then raise exception 'authentication required'; end if;
  if p_sector not in ('pizza','kebab','burger','restaurant','snack','boulangerie','sushi','other') then raise exception 'invalid sector'; end if;
  if length(trim(p_name)) < 2 then raise exception 'invalid name'; end if;
  if p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then raise exception 'invalid slug'; end if;
  insert into public.restaurants(name,slug,sector,onboarding_status,domain)
  values(trim(p_name),lower(p_slug),p_sector,'DRAFT',normalized_domain)
  returning * into r;
  insert into public.restaurant_members(restaurant_id,user_id,role)
  values(r.id,(select auth.uid()),'owner');
  insert into public.loyalty_programs(restaurant_id,name,is_active,earn_mode,points_per_euro)
  values(r.id,'Fidélité FOODATOI',false,'points_per_euro',1);
  if normalized_domain is not null then
    insert into public.restaurant_domains(restaurant_id,hostname,is_primary,is_verified)
    values(r.id,normalized_domain,true,false);
  end if;
  return r;
exception when unique_violation then
  raise exception 'restaurant slug or domain already exists';
end;
$$;

revoke execute on function public.provision_restaurant(text,text,text,text) from public, anon;
grant execute on function public.provision_restaurant(text,text,text,text) to authenticated;
