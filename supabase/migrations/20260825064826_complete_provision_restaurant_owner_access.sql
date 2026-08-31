-- provision_restaurant() créait déjà le restaurant + une ligne
-- restaurant_members('owner'), mais n'accordait jamais le vrai accès :
-- la RLS sur orders/products/etc. lit app_metadata.role/restaurant_id
-- du JWT, pas restaurant_members (qui ne sert qu'à afficher la liste
-- des membres). Sans ce correctif, le propriétaire d'un nouveau
-- restaurant se retrouverait exactement dans la situation de Caz Food
-- ce soir : connecté, mais 0 commande visible, sans erreur.
--
-- Changement d'API : prend maintenant l'email du propriétaire plutôt
-- que de déduire auth.uid() de l'appelant, parce que dans le vrai
-- usage prévu, c'est Kevin (ou un outil interne) qui exécute cette
-- fonction pour le compte du restaurant, pas le restaurant lui-même.
-- Reste volontairement réservée à un rôle privilégié (déjà retiré de
-- anon/authenticated dans une migration précédente).
create or replace function public.provision_restaurant(
  p_name text,
  p_slug text,
  p_sector text,
  p_owner_email text,
  p_domain text default null,
  p_phone text default null,
  p_address text default null
)
returns restaurants
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r public.restaurants;
  normalized_domain text := nullif(lower(trim(p_domain)), '');
  v_owner_id uuid;
begin
  select id into v_owner_id
  from auth.users
  where email = lower(trim(p_owner_email));

  if v_owner_id is null then
    raise exception 'Aucun compte Supabase Auth pour %. Crée-le d''abord (dashboard Authentication > Users, ou signUp), puis relance.', p_owner_email;
  end if;

  if p_sector not in ('pizza','kebab','burger','restaurant','snack','boulangerie','sushi','other') then
    raise exception 'invalid sector';
  end if;
  if length(trim(p_name)) < 2 then
    raise exception 'invalid name';
  end if;
  if p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid slug';
  end if;

  insert into public.restaurants(name, slug, sector, onboarding_status, domain, phone, address, is_active)
  values (trim(p_name), lower(p_slug), p_sector, 'DRAFT', normalized_domain, nullif(trim(p_phone), ''), nullif(trim(p_address), ''), true)
  returning * into r;

  insert into public.restaurant_members(restaurant_id, user_id, role)
  values (r.id, v_owner_id, 'owner');

  insert into public.loyalty_programs(restaurant_id, name, is_active, earn_mode, points_per_euro)
  values (r.id, 'Fidélité FOODATOI', false, 'points_per_euro', 1);

  if normalized_domain is not null then
    insert into public.restaurant_domains(restaurant_id, hostname, is_primary, is_verified)
    values (r.id, normalized_domain, true, true);
  end if;

  -- Le vrai verrou d'accès : sans ça, le propriétaire est "owner" dans
  -- restaurant_members mais invisible pour is_restaurant_admin()/
  -- current_restaurant_id(), donc RLS le traite comme n'importe qui.
  update auth.users
  set raw_app_meta_data = raw_app_meta_data
    || jsonb_build_object('role', 'restaurant_owner', 'restaurant_id', r.id)
  where id = v_owner_id;

  return r;
exception when unique_violation then
  raise exception 'restaurant slug or domain already exists';
end;
$$;
