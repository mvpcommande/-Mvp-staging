-- Import de menu : insertion en masse des produits validés par l'humain.
-- La table menu_imports (statuts PENDING/PROCESSING/REVIEW/COMPLETED/FAILED)
-- existait déjà ; ce RPC ajoute l'étape finale d'insertion.
-- Parsing PDF/photo assuré par l'Edge Function parse-menu (API Anthropic).

create or replace function public.import_products_from_payload(
  p_products jsonb,
  p_import_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rid uuid;
  v_item jsonb;
  v_count integer := 0;
  v_max_sort integer;
  v_price integer;
  v_name text;
  v_category text;
begin
  v_rid := public.current_restaurant_id();
  if v_rid is null or not public.is_restaurant_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_products is null or jsonb_typeof(p_products) <> 'array' then
    raise exception 'INVALID_PAYLOAD';
  end if;
  if jsonb_array_length(p_products) > 300 then
    raise exception 'TOO_MANY_PRODUCTS';
  end if;

  select coalesce(max(sort_order), 0) into v_max_sort
  from public.products where restaurant_id = v_rid;

  for v_item in select * from jsonb_array_elements(p_products)
  loop
    v_name := left(trim(coalesce(v_item->>'name','')), 120);
    v_category := left(trim(coalesce(nullif(v_item->>'category',''),'Autre')), 60);
    v_price := coalesce((v_item->>'price_cents')::integer, 0);
    if v_name = '' then continue; end if;
    if v_price < 0 or v_price > 100000 then continue; end if;
    v_max_sort := v_max_sort + 1;
    insert into public.products(
      restaurant_id, name, category, description, price_cents, options, is_active, sort_order
    ) values (
      v_rid, v_name, v_category,
      nullif(trim(coalesce(v_item->>'description','')), ''),
      v_price, coalesce(v_item->'options', '{}'::jsonb), true, v_max_sort
    );
    v_count := v_count + 1;
  end loop;

  if p_import_id is not null then
    update public.menu_imports
    set status = 'COMPLETED', updated_at = now()
    where id = p_import_id and restaurant_id = v_rid;
  end if;

  return v_count;
end;
$$;
revoke all on function public.import_products_from_payload(jsonb, uuid) from public, anon;
grant execute on function public.import_products_from_payload(jsonb, uuid) to authenticated;
