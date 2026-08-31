-- Template d'onboarding : fait en un appel ce qui a été fait à la main
-- pour Caz Food (create restaurant + accès admin correctement posé).
--
-- Volontairement DIFFÉRENT de provision_restaurant() : celle-ci était
-- pensée self-service (l'appelant devient propriétaire via auth.uid()),
-- mais elle est verrouillée (accès public révoqué) car non liée au vrai
-- mécanisme d'accès. Cette fonction-ci est pensée pour un onboarding
-- fait PAR Kevin (ou moi) POUR un futur client, par email, et pose
-- directement app_metadata - le point qui, pour Caz Food, a été fait
-- à la main et a cassé l'admin jusqu'à ce qu'on le trouve.
--
-- Ne couvre PAS le menu, les photos, les réseaux sociaux, les horaires :
-- volontairement laissé pour l'étape suivante, propre à chaque
-- restaurant, non généralisable. Voir ONBOARDING.md pour la suite.
create or replace function public.onboard_restaurant(
  p_name text,
  p_slug text,
  p_sector text,
  p_owner_email text,
  p_domain text default null
)
returns table (
  restaurant_id uuid,
  owner_user_id uuid
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_restaurant_id uuid;
  v_owner_id uuid;
begin
  if p_name is null or length(trim(p_name)) < 2 then
    raise exception 'INVALID_NAME';
  end if;

  if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'INVALID_SLUG: % (attendu: minuscules, chiffres, tirets)', p_slug;
  end if;

  if p_sector not in ('pizza','kebab','burger','restaurant','snack','boulangerie','sushi','other') then
    raise exception 'INVALID_SECTOR: %', p_sector;
  end if;

  select u.id into v_owner_id
  from auth.users u
  where u.email = lower(trim(p_owner_email));

  if v_owner_id is null then
    raise exception 'OWNER_NOT_FOUND: % (le compte doit déjà exister, se connecter une première fois pour le créer)', p_owner_email;
  end if;

  insert into public.restaurants (name, slug, sector, domain, is_active, onboarding_status)
  values (trim(p_name), lower(trim(p_slug)), p_sector, p_domain, true, 'READY')
  returning id into v_restaurant_id;

  insert into public.restaurant_members (restaurant_id, user_id, role)
  values (v_restaurant_id, v_owner_id, 'owner');

  update auth.users
  set raw_app_meta_data = raw_app_meta_data || jsonb_build_object(
    'role', 'restaurant_owner',
    'restaurant_id', v_restaurant_id
  )
  where id = v_owner_id;

  return query select v_restaurant_id, v_owner_id;
end;
$$;

-- Volontairement PAS accordé à anon/authenticated : ça pose un accès
-- admin complet sur un restaurant, doit rester un geste délibéré
-- (Kevin ou moi, via un accès privilégié), pas un endpoint public.
revoke all on function public.onboard_restaurant(text, text, text, text, text) from public, anon, authenticated;
