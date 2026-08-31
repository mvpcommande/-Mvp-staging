-- Capture les erreurs qui échouaient silencieusement jusqu'ici (realtime,
-- résolution restaurant, création commande) : jamais visibles pour
-- personne, juste console.error() dans le navigateur de qui que ce soit
-- ait été en train de regarder au mauvais moment.
create table public.client_error_logs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants(id),
  context text not null,
  message text not null,
  details jsonb,
  page text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.client_error_logs enable row level security;

-- N'importe qui doit pouvoir logger une erreur, y compris avant que le
-- restaurant soit résolu (ex: resolve_restaurant lui-même qui échoue).
create policy client_error_logs_insert
on public.client_error_logs
for insert
to anon, authenticated
with check (true);

-- Lecture réservée au staff du restaurant concerné, + les erreurs sans
-- restaurant_id (échecs avant résolution, donc pas encore rattachables).
create policy client_error_logs_admin_select
on public.client_error_logs
for select
to authenticated
using (
  is_restaurant_admin()
  and (restaurant_id = current_restaurant_id() or restaurant_id is null)
);

create index client_error_logs_created_at_idx on public.client_error_logs (created_at desc);
