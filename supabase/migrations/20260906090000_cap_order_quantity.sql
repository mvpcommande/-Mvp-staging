-- Durcissement : plafond de quantité par ligne de commande.
--
-- create_order bornait la quantité par le bas (greatest(1, ...)) mais
-- pas par le haut. price_cents * quantity peut alors dépasser le type
-- integer de total_cents / line_total_cents (max 2 147 483 647) : Postgres
-- lève "integer out of range", ce qui transforme l'unique endpoint
-- d'écriture public (create_order, appelable par anon) en vecteur de
-- déni de service / commandes en échec.
--
-- Fix : rejeter toute quantité hors 1..99 AVANT le moindre write (la
-- validation tourne dans la première boucle, donc la commande est
-- refusée atomiquement, rien n'est inséré). Reste identique par ailleurs
-- à la version 2026-09-04 (idempotency, bornes pickup_time, horaires
-- contrôlés sur pickup_time, rate-limit téléphone, SumUp, livraison).
--
-- NB : le rate-limit par téléphone reste contournable (le téléphone est
-- fourni par le client) ; le vrai anti-abus doit vivre au niveau edge
-- (Supabase Edge Function / Cloudflare / WAF), pas uniquement en SQL.

create or replace function public.create_order(
  p_restaurant_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_pickup_time timestamptz,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text default null,
  p_payment_method text default 'PAY_AT_STORE',
  p_fulfillment_type text default 'PICKUP',
  p_delivery_address jsonb default null
)
returns table (
  id uuid,
  order_number text,
  status text,
  total_cents integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order_id uuid := gen_random_uuid();
  v_order_number text;
  v_total_cents integer := 0;
  v_item jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_price_cents integer;
  v_quantity integer;
  v_line_total integer;
  v_opening_hours jsonb;
  v_pickup_paris timestamp;
  v_day_key text;
  v_local_minutes integer;
  v_range jsonb;
  v_is_open boolean := false;
  v_existing record;
  v_recent_count integer;
  v_payment_status text;
  v_delivery_mode text;
begin
  if p_idempotency_key is not null then
    select o.id, o.order_number, o.status, o.total_cents
      into v_existing
    from public.orders o
    where o.restaurant_id = p_restaurant_id
      and o.idempotency_key = p_idempotency_key;

    if found then
      return query select v_existing.id, v_existing.order_number, v_existing.status, v_existing.total_cents;
      return;
    end if;
  end if;

  if p_fulfillment_type not in ('PICKUP', 'DELIVERY') then
    raise exception 'INVALID_FULFILLMENT_TYPE';
  end if;

  select r.settings -> 'opening_hours', r.settings ->> 'delivery_mode'
    into v_opening_hours, v_delivery_mode
  from public.restaurants r
  where r.id = p_restaurant_id and r.is_active = true;

  if not found then
    raise exception 'RESTAURANT_NOT_FOUND';
  end if;

  if p_fulfillment_type = 'DELIVERY' then
    if v_delivery_mode is distinct from 'internal' then
      raise exception 'DELIVERY_NOT_AVAILABLE';
    end if;

    if coalesce(trim(p_delivery_address ->> 'street'), '') = ''
       or coalesce(trim(p_delivery_address ->> 'postal_code'), '') = ''
       or coalesce(trim(p_delivery_address ->> 'city'), '') = '' then
      raise exception 'MISSING_DELIVERY_ADDRESS';
    end if;
  end if;

  if p_pickup_time is null then
    raise exception 'MISSING_PICKUP_TIME';
  end if;

  if p_pickup_time < now() - interval '5 minutes' then
    raise exception 'PICKUP_TIME_IN_PAST';
  end if;

  if p_pickup_time > now() + interval '60 days' then
    raise exception 'PICKUP_TIME_TOO_FAR';
  end if;

  if v_opening_hours is not null then
    v_pickup_paris := p_pickup_time at time zone 'Europe/Paris';
    v_day_key := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from v_pickup_paris)::int + 1];
    v_local_minutes := extract(hour from v_pickup_paris)::int * 60 + extract(minute from v_pickup_paris)::int;

    for v_range in select * from jsonb_array_elements(coalesce(v_opening_hours -> v_day_key, '[]'::jsonb))
    loop
      if v_local_minutes >= (
        split_part(v_range->>0, ':', 1)::int * 60 + split_part(v_range->>0, ':', 2)::int
      ) and v_local_minutes <= (
        split_part(v_range->>1, ':', 1)::int * 60 + split_part(v_range->>1, ':', 2)::int
      ) then
        v_is_open := true;
      end if;
    end loop;

    if not v_is_open then
      raise exception 'RESTAURANT_CLOSED';
    end if;
  end if;

  if p_customer_phone is not null and length(trim(p_customer_phone)) > 0 then
    select count(*) into v_recent_count
    from public.orders o
    where o.restaurant_id = p_restaurant_id
      and o.customer_phone = p_customer_phone
      and o.created_at > now() - interval '10 minutes';

    if v_recent_count >= 5 then
      raise exception 'RATE_LIMITED';
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item ->> 'product_id') is null then
      raise exception 'MISSING_PRODUCT_ID';
    end if;

    select p.id, p.name, p.price_cents
      into v_product_id, v_product_name, v_product_price_cents
    from public.products p
    where p.id = (v_item ->> 'product_id')::uuid
      and p.restaurant_id = p_restaurant_id
      and p.is_active = true;

    if v_product_id is null then
      raise exception 'PRODUCT_NOT_FOUND: %', v_item ->> 'product_id';
    end if;

    v_quantity := coalesce((v_item ->> 'quantity')::integer, 1);
    if v_quantity < 1 or v_quantity > 99 then
      raise exception 'INVALID_QUANTITY';
    end if;
    v_total_cents := v_total_cents + (v_product_price_cents * v_quantity);
  end loop;

  v_order_number := 'FA-' || to_char(now() at time zone 'Europe/Paris', 'YYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  v_payment_status := case
    when p_payment_method = 'ONLINE' then 'PENDING'
    else 'PAY_AT_STORE'
  end;

  insert into public.orders (
    id, restaurant_id, order_number, customer_name, customer_phone,
    pickup_time, status, payment_status, fulfillment_type, total_cents, notes,
    idempotency_key, delivery_address, delivery_status
  ) values (
    v_order_id, p_restaurant_id, v_order_number,
    coalesce(p_customer_name, ''), coalesce(p_customer_phone, ''),
    p_pickup_time, 'NEW', v_payment_status, p_fulfillment_type, v_total_cents, p_notes,
    p_idempotency_key,
    case when p_fulfillment_type = 'DELIVERY' then p_delivery_address else null end,
    case when p_fulfillment_type = 'DELIVERY' then 'TO_DELIVER' else null end
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select p.id, p.name, p.price_cents
      into v_product_id, v_product_name, v_product_price_cents
    from public.products p
    where p.id = (v_item ->> 'product_id')::uuid
      and p.restaurant_id = p_restaurant_id;

    v_quantity := greatest(1, coalesce((v_item ->> 'quantity')::integer, 1));
    v_line_total := v_product_price_cents * v_quantity;

    insert into public.order_items (
      order_id, product_id, product_name, quantity,
      unit_price_cents, options, line_total_cents
    ) values (
      v_order_id, v_product_id, v_product_name, v_quantity,
      v_product_price_cents,
      coalesce(v_item -> 'options', '{}'::jsonb),
      v_line_total
    );
  end loop;

  return query select v_order_id, v_order_number, 'NEW'::text, v_total_cents;
end;
$$;


grant execute on function public.create_order(uuid, text, text, timestamptz, text, jsonb, text, text, text, jsonb) to anon, authenticated;
