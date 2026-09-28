-- Banc de test LOCAL (Postgres jetable) : reproduit le strict minimum de
-- l'environnement Supabase nécessaire à la migration RusHour. Ne jamais
-- exécuter sur une base Supabase réelle (le runner refuse toute URL non
-- locale).

-- Rôles API Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Comme Supabase : les rôles API reçoivent ALL par défaut sur les
-- nouvelles tables. La migration RusHour doit donc révoquer
-- explicitement (c'est précisément ce que les tests vérifient).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- auth.* minimal : claims JWT lus depuis request.jwt.claims, comme PostgREST.
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (id uuid primary key);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
