-- Pile d'intégration LOCALE (équivalent fonctionnel du staging Supabase) :
-- rôle "authenticator" de PostgREST + données de test FICTIVES.
-- Aucune donnée réelle, aucun identifiant RusHour réel.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

-- Restaurant de test RusHour (A) + restaurant voisin (B) pour l'isolation.
insert into public.restaurants (id, slug, name) values
  ('e2e00000-0000-4000-8000-00000000000a', 'e2e-rushour-test', 'E2E RusHour Test'),
  ('e2e00000-0000-4000-8000-00000000000b', 'e2e-voisin', 'E2E Voisin');

insert into public.products (id, restaurant_id, name, price_cents) values
  ('e2e10000-0000-4000-8000-000000000001', 'e2e00000-0000-4000-8000-00000000000a', 'Kebab test', 850),
  ('e2e10000-0000-4000-8000-000000000002', 'e2e00000-0000-4000-8000-00000000000a', 'Tacos test', 900),
  ('e2e10000-0000-4000-8000-000000000003', 'e2e00000-0000-4000-8000-00000000000a', 'Boisson test', 200),
  ('e2e10000-0000-4000-8000-0000000000b1', 'e2e00000-0000-4000-8000-00000000000b', 'Pizza voisin', 1100);

-- Lecture publique du catalogue comme en production (policies simplifiées).
create policy products_public_read on public.products for select to anon, authenticated using (is_active);
grant select on public.products, public.restaurants to anon, authenticated;

insert into public.restaurant_rushour_connections (restaurant_id, rushour_integration_id, enabled) values
  ('e2e00000-0000-4000-8000-00000000000a', 'mock-staging-integration', true),
  ('e2e00000-0000-4000-8000-00000000000b', 'mock-staging-integration-b', true);

insert into public.rushour_product_mappings (restaurant_id, product_id, rushour_product_id) values
  ('e2e00000-0000-4000-8000-00000000000a', 'e2e10000-0000-4000-8000-000000000001', 'mock-rh-product-1'),
  ('e2e00000-0000-4000-8000-00000000000a', 'e2e10000-0000-4000-8000-000000000002', 'mock-rh-product-2'),
  ('e2e00000-0000-4000-8000-00000000000a', 'e2e10000-0000-4000-8000-000000000003', 'mock-rh-product-3'),
  ('e2e00000-0000-4000-8000-00000000000b', 'e2e10000-0000-4000-8000-0000000000b1', 'mock-rh-product-b1');
