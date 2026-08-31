create or replace function public.resolve_restaurant(hostname text)
returns table (
  id uuid,
  slug text,
  name text,
  logo_url text,
  primary_color text,
  sector text,
  settings jsonb,
  phone text,
  address jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with input as (
    select lower(regexp_replace(trim(hostname), ':\\d+$', '')) as host
  ),
  match as (
    select r.*
    from public.restaurants r, input i
    where r.is_active = true
      and (
        lower(coalesce(r.domain,'')) = i.host
        or exists (
          select 1
          from public.restaurant_domains rd
          where rd.restaurant_id = r.id
            and rd.is_verified = true
            and lower(rd.hostname) = i.host
        )
        or (
          i.host like '%.foodatoi.fr'
          and r.slug = split_part(i.host, '.', 1)
        )
      )
    order by r.created_at asc
    limit 1
  )
  select id, slug, name, logo_url, primary_color, sector, settings, phone, address
  from match;
$$;

revoke execute on function public.resolve_restaurant(text) from public;
grant execute on function public.resolve_restaurant(text) to anon, authenticated;
