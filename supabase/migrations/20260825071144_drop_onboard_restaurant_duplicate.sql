-- Doublon de provision_restaurant(), jamais utilisée (1 seul restaurant
-- en base, Caz Food, créé par ni l'une ni l'autre). Kevin confirme
-- garder provision_restaurant() comme fonction d'onboarding officielle.
drop function if exists public.onboard_restaurant(text, text, text, text, text);
