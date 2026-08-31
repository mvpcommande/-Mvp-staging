create or replace function public.create_order(
  p_restaurant_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_pickup_time timestamptz,
  p_notes text,
  p_items jsonb
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
  v_paris_now timestamp;
  v_day_key text;
  v_local_minutes integer;
  v_range jsonb;
  v_is_open boolean := false;
begin
  select r.settings -> 'opening_hours' into v_opening_hours
  from public.restaurants r
  where r.id = p_restaurant_id and r.is_active = true;

  if not found then
    raise exception 'RESTAURANT_NOT_FOUND';
  end if;

  if v_opening_hours is not null then
    v_paris_now := now() at time zone 'Europe/Paris';
    v_day_key := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from v_paris_now)::int + 1];
    v_local_minutes := extract(hour from v_paris_now)::int * 60 + extract(minute from v_paris_now)::int;

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

    v_quantity := greatest(1, coalesce((v_item ->> 'quantity')::integer, 1));
    v_total_cents := v_total_cents + (v_product_price_cents * v_quantity);
  end loop;

  v_order_number := 'FA-' || to_char(now() at time zone 'Europe/Paris', 'YYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.orders (
    id, restaurant_id, order_number, customer_name, customer_phone,
    pickup_time, status, payment_status, fulfillment_type, total_cents, notes
  ) values (
    v_order_id, p_restaurant_id, v_order_number,
    coalesce(p_customer_name, ''), coalesce(p_customer_phone, ''),
    p_pickup_time, 'NEW', 'PAY_AT_STORE', 'PICKUP', v_total_cents, p_notes
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
