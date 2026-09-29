-- Mesure d'audience anonyme (sans cookie, sans IP, sans identifiant) :
-- page, source, hôte référent, slug resto. Régime CNIL "mesure d'audience
-- exemptée" -> pas de bandeau de consentement. Écriture via RPC uniquement.

create table if not exists public.page_visits (
  id bigint generated always as identity primary key,
  page text,
  source text,
  referrer_host text,
  restaurant_slug text,
  created_at timestamptz not null default now()
);
alter table public.page_visits enable row level security;

create or replace function public.log_page_visit(
  p_page text,
  p_source text,
  p_referrer_host text default null,
  p_restaurant_slug text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.page_visits(page, source, referrer_host, restaurant_slug)
  values (
    left(coalesce(p_page, ''), 120),
    left(coalesce(nullif(p_source, ''), 'direct'), 40),
    left(nullif(p_referrer_host, ''), 120),
    left(nullif(p_restaurant_slug, ''), 80)
  );
end;
$$;
revoke all on function public.log_page_visit(text, text, text, text) from public;
grant execute on function public.log_page_visit(text, text, text, text) to anon, authenticated;

create or replace view public.page_visits_daily as
select date_trunc('day', created_at)::date as jour, source, count(*) as visites
from public.page_visits group by 1, 2 order by 1 desc, 3 desc;

-- Purge > 13 mois via pg_cron (voir aussi la migration de rétention des logs).
