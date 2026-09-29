-- ============================================================================
-- ALIGNEMENT STAGING — helpers de tenant manquants (Bloc RusHour 1.1)
--
-- Le projet staging (kkhlpeqherxfdnilewkp, "Mvp-test") a été construit par
-- ses propres migrations "e2e_staging" et NE contient PAS trois fonctions
-- présentes en production et dont dépend la migration RusHour 20260928090000 :
--   public.set_updated_at(), public.current_restaurant_id(),
--   public.is_restaurant_admin().
--
-- Ce script les crée avec EXACTEMENT les définitions de production, reprises
-- des migrations versionnées du repo :
--   - set_updated_at        : 20260822113324_harden_updated_at_trigger_search_path.sql
--   - current_restaurant_id : 20260822092122_loyalty_rls_isolation.sql
--   - is_restaurant_admin   : 20260822092122_loyalty_rls_isolation.sql
--
-- Script d'exploitation STAGING (pas une migration du repo : en production
-- ces fonctions existent déjà via les migrations d'origine). Idempotent
-- (CREATE OR REPLACE). Aucune donnée touchée.
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create or replace function public.current_restaurant_id() returns uuid language sql stable security invoker set search_path = public as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'restaurant_id', '')::uuid;
$$;

create or replace function public.is_restaurant_admin() returns boolean language sql stable security invoker set search_path = public as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('restaurant_admin','restaurant_owner','platform_admin');
$$;
