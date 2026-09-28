-- ============================================================================
-- BLOC RUSHOUR 1 — FONDATION DU CONNECTEUR (STAGING UNIQUEMENT)
-- MIGRATION À VALIDER — NON APPLIQUÉE PAR L'AGENT QUI L'A ÉCRITE.
-- ============================================================================
--
-- Objet : exporter, de façon fiable et sans doublon, les commandes
-- Foodatoi vers RusHour (6-7 établissements, chacun sa propre intégration
-- RusHour), SANS jamais faire dépendre la création de commande du réseau.
--
-- Contenu :
--   1. restaurant_rushour_connections : destination RusHour par
--      restaurant (AUCUN secret : appSecret/tokens vivent en Supabase
--      Secrets côté Edge Function) ;
--   2. rushour_product_mappings : produit Foodatoi -> produit RusHour,
--      tenant-scoped par clé étrangère composite (impossible de mapper un
--      produit du restaurant A sous le restaurant B) ;
--   3. rushour_order_outbox : outbox transactionnelle, UNE ligne par
--      commande (UNIQUE(order_id)), clé d'export stable
--      (UNIQUE(export_key)) ;
--   4. rushour_sync_events : journal serveur du connecteur (sans secret,
--      sans payload) ;
--   5. trigger AFTER INSERT ON orders -> enqueue (même transaction que
--      create_order(), qui n'est PAS modifiée) ;
--   6. fonctions atomiques du worker : claim (FOR UPDATE SKIP LOCKED +
--      bail), mark_sent / mark_failed (conditionnées au bail), requeue,
--      rattrapage.
--
-- POURQUOI UN TRIGGER PLUTÔT QUE MODIFIER create_order() :
--   - create_order() est la pièce la plus critique et la plus durcie du
--     produit (8 versions) : on n'y touche pas sans nécessité démontrée ;
--   - le trigger capte TOUTE insertion de commande, quel que soit le
--     canal (web aujourd'hui, WhatsApp demain via create_order()) ;
--   - il s'exécute dans la MÊME transaction que la commande (outbox
--     transactionnelle) : commande et entrée d'export sont validées ou
--     annulées ensemble, sans aucun appel réseau ;
--   - le chemin idempotent de create_order() (commande existante
--     renvoyée) n'insère rien, donc n'enqueue rien : pas de double
--     enqueue ; UNIQUE(order_id) le garantit de toute façon.
--   - toute erreur d'enqueue est CAPTURÉE et journalisée : elle ne peut
--     JAMAIS faire échouer la commande (rattrapage :
--     rushour_enqueue_missing()).
--   NB : les order_items sont insérés APRÈS la ligne orders par
--   create_order() ; le trigger ne les lit donc pas. Le worker les lit
--   au moment de l'envoi (commande committée, donc complète).
--
-- SÉCURITÉ :
--   - RLS activée sur les 4 tables ; lecture réservée aux admins du
--     restaurant (même modèle que le reste du schéma :
--     is_restaurant_admin() + current_restaurant_id()) ;
--   - AUCUNE policy d'écriture : anon/authenticated ne peuvent ni
--     définir un rushour_integration_id, ni modifier un mapping, ni
--     passer une ligne en SENT, ni toucher attempts/external_order_id.
--     Seul service_role (Edge Function) et postgres écrivent ;
--   - fonctions du worker : EXECUTE révoqué à PUBLIC/anon/authenticated,
--     accordé à service_role uniquement.
--
-- COÛT / VERROUS :
--   Deux index uniques (id, restaurant_id) sont créés sur products et
--   orders pour porter les clés étrangères composites anti cross-tenant.
--   CREATE INDEX bloque les écritures de la table le temps de la
--   construction (quelques ms sur les volumes pilote actuels). Sur une
--   base volumineuse, les créer d'abord avec CREATE UNIQUE INDEX
--   CONCURRENTLY (hors transaction) : les IF NOT EXISTS ci-dessous
--   deviennent alors des no-op.
--
-- APPLICATION : staging uniquement, après vérification explicite du
--   project ref (kkhlpeqherxfdnilewkp). Voir docs/RUSHOUR_CONNECTOR.md.
-- ROLLBACK : supabase/rollbacks/rollback_20260928090000_rushour_connector_foundation.sql
-- TESTS : supabase/tests/rushour/ (Postgres réel : RLS, trigger,
--   concurrence SKIP LOCKED, parité de la clé d'export JS/SQL).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Supports des clés étrangères composites (anti cross-tenant)
-- ---------------------------------------------------------------------------

create unique index if not exists products_id_restaurant_id_key
  on public.products (id, restaurant_id);

create unique index if not exists orders_id_restaurant_id_key
  on public.orders (id, restaurant_id);

-- ---------------------------------------------------------------------------
-- 1. Destination RusHour par restaurant (AUCUN SECRET ICI)
-- ---------------------------------------------------------------------------

create table public.restaurant_rushour_connections (
  restaurant_id uuid primary key
    references public.restaurants(id) on delete cascade,
  -- Identifiant d'intégration RusHour (routage : POST
  -- /apps/{appId}/integrations/{integrationId}/orders d'après le dépôt
  -- officiel rushour-io/developers-api-demo). Fourni par RusHour.
  rushour_integration_id text not null,
  -- Identifiant de store RusHour : existence/usage NON CONFIRMÉS (UNKNOWN).
  rushour_store_id text,
  -- Désactivé par défaut : l'activation est un acte explicite.
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restaurant_rushour_connections_integration_format
    check (rushour_integration_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  constraint restaurant_rushour_connections_store_format
    check (rushour_store_id is null or rushour_store_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- Deux restaurants Foodatoi ne peuvent pas router vers la même
  -- intégration RusHour (sinon les commandes de A arriveraient chez B).
  constraint restaurant_rushour_connections_integration_unique
    unique (rushour_integration_id)
);

comment on table public.restaurant_rushour_connections is
  'Destination RusHour par restaurant. NE DOIT JAMAIS contenir de secret (appSecret, tokens) : ceux-ci vivent dans les Supabase Secrets de l''Edge Function.';

-- ---------------------------------------------------------------------------
-- 2. Mapping produit Foodatoi -> RusHour (tenant-scoped)
-- ---------------------------------------------------------------------------

create table public.rushour_product_mappings (
  restaurant_id uuid not null
    references public.restaurants(id) on delete cascade,
  product_id uuid not null,
  rushour_product_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, product_id),
  -- Le produit DOIT appartenir au restaurant du mapping.
  constraint rushour_product_mappings_product_same_tenant
    foreign key (product_id, restaurant_id)
    references public.products (id, restaurant_id) on delete cascade,
  constraint rushour_product_mappings_rushour_id_format
    check (rushour_product_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);

-- ---------------------------------------------------------------------------
-- 3. Outbox d'export
-- ---------------------------------------------------------------------------

create table public.rushour_order_outbox (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null
    references public.restaurants(id) on delete cascade,
  order_id uuid not null,
  -- Identité logique stable "commande X -> destination Y" (voir
  -- rushour_export_key). Identique à chaque tentative.
  export_key text not null,
  -- Destination figée à l'enqueue : un retry ne change jamais de cible.
  destination_integration_id text not null,
  status text not null default 'PENDING',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_category text,
  last_error text,
  external_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint rushour_order_outbox_order_unique unique (order_id),
  constraint rushour_order_outbox_export_key_unique unique (export_key),
  constraint rushour_order_outbox_order_same_tenant
    foreign key (order_id, restaurant_id)
    references public.orders (id, restaurant_id) on delete cascade,
  constraint rushour_order_outbox_status_check
    check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  constraint rushour_order_outbox_export_key_format
    check (export_key ~ '^fdt1_[0-9a-f]{32}$'),
  constraint rushour_order_outbox_attempts_bounds
    check (attempts >= 0 and max_attempts between 1 and 20 and attempts <= max_attempts),
  constraint rushour_order_outbox_lock_consistency
    check ((status = 'SENDING') = (locked_at is not null and locked_by is not null)),
  constraint rushour_order_outbox_sent_consistency
    check ((status = 'SENT') = (sent_at is not null)),
  constraint rushour_order_outbox_error_length
    check (last_error is null or char_length(last_error) <= 500),
  constraint rushour_order_outbox_external_id_format
    check (external_order_id is null or external_order_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);

create index rushour_order_outbox_due_idx
  on public.rushour_order_outbox (next_attempt_at)
  where status = 'PENDING';

create index rushour_order_outbox_sending_idx
  on public.rushour_order_outbox (locked_at)
  where status = 'SENDING';

create index rushour_order_outbox_restaurant_status_idx
  on public.rushour_order_outbox (restaurant_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Journal serveur du connecteur
-- ---------------------------------------------------------------------------

create table public.rushour_sync_events (
  id bigint generated always as identity primary key,
  outbox_id uuid references public.rushour_order_outbox(id) on delete set null,
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  order_id uuid,
  step text not null,
  outcome text not null,
  attempt integer,
  error_category text,
  error_code text,
  http_status integer,
  message text,
  created_at timestamptz not null default now(),
  constraint rushour_sync_events_step_check
    check (step in ('ENQUEUE', 'CLAIM', 'RESOLVE_CONFIG', 'MAP', 'SEND', 'COMPLETE', 'REQUEUE')),
  constraint rushour_sync_events_lengths
    check (char_length(outcome) <= 64
       and (error_code is null or char_length(error_code) <= 64)
       and (error_category is null or char_length(error_category) <= 32)
       and (message is null or char_length(message) <= 500))
);

create index rushour_sync_events_restaurant_created_idx
  on public.rushour_sync_events (restaurant_id, created_at desc);

create index rushour_sync_events_order_idx
  on public.rushour_sync_events (order_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger restaurant_rushour_connections_set_updated_at
  before update on public.restaurant_rushour_connections
  for each row execute function public.set_updated_at();

create trigger rushour_product_mappings_set_updated_at
  before update on public.rushour_product_mappings
  for each row execute function public.set_updated_at();

create trigger rushour_order_outbox_set_updated_at
  before update on public.rushour_order_outbox
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS + privilèges
-- ---------------------------------------------------------------------------

alter table public.restaurant_rushour_connections enable row level security;
alter table public.rushour_product_mappings enable row level security;
alter table public.rushour_order_outbox enable row level security;
alter table public.rushour_sync_events enable row level security;

-- Supabase accorde par défaut ALL aux rôles API sur les nouvelles tables :
-- on repart de zéro, puis lecture seule pour authenticated (filtrée RLS).
revoke all on table
  public.restaurant_rushour_connections,
  public.rushour_product_mappings,
  public.rushour_order_outbox,
  public.rushour_sync_events
from public, anon, authenticated;

grant select on table
  public.restaurant_rushour_connections,
  public.rushour_product_mappings,
  public.rushour_order_outbox,
  public.rushour_sync_events
to authenticated;

grant select, insert, update, delete on table
  public.restaurant_rushour_connections,
  public.rushour_product_mappings,
  public.rushour_order_outbox,
  public.rushour_sync_events
to service_role;

create policy restaurant_rushour_connections_admin_select
  on public.restaurant_rushour_connections
  for select to authenticated
  using (public.is_restaurant_admin() and restaurant_id = (select public.current_restaurant_id()));

create policy rushour_product_mappings_admin_select
  on public.rushour_product_mappings
  for select to authenticated
  using (public.is_restaurant_admin() and restaurant_id = (select public.current_restaurant_id()));

create policy rushour_order_outbox_admin_select
  on public.rushour_order_outbox
  for select to authenticated
  using (public.is_restaurant_admin() and restaurant_id = (select public.current_restaurant_id()));

create policy rushour_sync_events_admin_select
  on public.rushour_sync_events
  for select to authenticated
  using (public.is_restaurant_admin() and restaurant_id = (select public.current_restaurant_id()));

-- Pas de policy INSERT/UPDATE/DELETE : écriture réservée à service_role
-- (qui contourne la RLS) et aux fonctions SECURITY DEFINER ci-dessous.

-- ---------------------------------------------------------------------------
-- 5. Clé d'export (parité exacte avec idempotency.mjs, testée)
-- ---------------------------------------------------------------------------

create or replace function public.rushour_export_key(p_order_id uuid, p_integration_id text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select 'fdt1_' || left(encode(sha256(convert_to(
    'foodatoi-rushour-export:v1:' || p_order_id::text || ':' || p_integration_id,
    'UTF8')), 'hex'), 32);
$$;

-- ---------------------------------------------------------------------------
-- 6. Enqueue (idempotent) + trigger
-- ---------------------------------------------------------------------------

create or replace function public.rushour_enqueue_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_integration_id text;
  v_id uuid;
begin
  select o.restaurant_id into v_restaurant_id
  from public.orders o
  where o.id = p_order_id;

  if not found then
    return null;
  end if;

  select c.rushour_integration_id into v_integration_id
  from public.restaurant_rushour_connections c
  where c.restaurant_id = v_restaurant_id
    and c.enabled = true;

  if v_integration_id is null then
    return null;  -- restaurant non connecté à RusHour : rien à exporter
  end if;

  insert into public.rushour_order_outbox (restaurant_id, order_id, export_key, destination_integration_id)
  values (v_restaurant_id, p_order_id, public.rushour_export_key(p_order_id, v_integration_id), v_integration_id)
  on conflict (order_id) do nothing
  returning id into v_id;

  if v_id is null then
    select b.id into v_id from public.rushour_order_outbox b where b.order_id = p_order_id;
  end if;

  return v_id;
end;
$$;

create or replace function public.rushour_enqueue_after_order_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.rushour_enqueue_order(new.id);
  exception when others then
    -- La commande passe TOUJOURS : un échec d'enqueue est journalisé et
    -- rattrapable (rushour_enqueue_missing), jamais bloquant.
    begin
      insert into public.rushour_sync_events (restaurant_id, order_id, step, outcome, error_code, message)
      values (new.restaurant_id, new.id, 'ENQUEUE', 'ENQUEUE_FAILED', sqlstate, left(sqlerrm, 500));
    exception when others then
      raise warning 'rushour enqueue failed for order %', new.id;
    end;
  end;
  return null;
end;
$$;

create trigger orders_rushour_enqueue
  after insert on public.orders
  for each row execute function public.rushour_enqueue_after_order_insert();

-- ---------------------------------------------------------------------------
-- 7. Worker : réclamation atomique (bail de 10 min)
-- ---------------------------------------------------------------------------

create or replace function public.rushour_claim_outbox(p_worker_id text, p_limit integer default 10)
returns setof public.rushour_order_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 then
    raise exception 'INVALID_WORKER_ID';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_LIMIT';
  end if;

  -- Bail expiré ET tentatives épuisées : FAILED (jamais de boucle infinie).
  update public.rushour_order_outbox
     set status = 'FAILED',
         locked_at = null,
         locked_by = null,
         last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
         last_error_category = 'UNKNOWN',
         last_error = 'Bail expiré sans résultat après la dernière tentative'
   where status = 'SENDING'
     and locked_at < now() - interval '10 minutes'
     and attempts >= max_attempts;

  return query
  with candidates as (
    select b.id
    from public.rushour_order_outbox b
    join public.restaurant_rushour_connections c
      on c.restaurant_id = b.restaurant_id and c.enabled = true
    join public.orders o
      on o.id = b.order_id
    where b.attempts < b.max_attempts
      and (
        (b.status = 'PENDING' and b.next_attempt_at <= now())
        -- Worker mort en plein envoi : reprise après expiration du bail,
        -- avec la MÊME clé d'export.
        or (b.status = 'SENDING' and b.locked_at < now() - interval '10 minutes')
      )
      -- Paiement en ligne non confirmé : on attend, sans consommer de
      -- tentative.
      and o.payment_status is distinct from 'PENDING'
    order by b.next_attempt_at, b.created_at
    limit p_limit
    for update of b skip locked
  )
  update public.rushour_order_outbox b
     set status = 'SENDING',
         locked_at = now(),
         locked_by = p_worker_id,
         attempts = b.attempts + 1
    from candidates
   where b.id = candidates.id
  returning b.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Worker : issue d'une tentative (conditionnée au bail)
-- ---------------------------------------------------------------------------

create or replace function public.rushour_mark_sent(
  p_outbox_id uuid,
  p_worker_id text,
  p_external_order_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rushour_order_outbox
     set status = 'SENT',
         sent_at = now(),
         external_order_id = p_external_order_id,
         locked_at = null,
         locked_by = null,
         last_error_code = null,
         last_error_category = null,
         last_error = null
   where id = p_outbox_id
     and status = 'SENDING'
     and locked_by = p_worker_id;

  return found;
end;
$$;

create or replace function public.rushour_mark_failed(
  p_outbox_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_category text,
  p_error_message text,
  p_retry_in_seconds integer default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if p_error_category is null or p_error_category not in (
    'RETRYABLE', 'NON_RETRYABLE', 'AUTH_ERROR', 'MAPPING_ERROR',
    'VALIDATION_ERROR', 'RATE_LIMIT', 'TIMEOUT', 'UNKNOWN'
  ) then
    raise exception 'INVALID_ERROR_CATEGORY';
  end if;
  if p_retry_in_seconds is not null and p_retry_in_seconds not between 1 and 3600 then
    raise exception 'INVALID_RETRY_DELAY';
  end if;

  update public.rushour_order_outbox
     set status = case
                    when p_retry_in_seconds is not null and attempts < max_attempts then 'PENDING'
                    else 'FAILED'
                  end,
         next_attempt_at = case
                    when p_retry_in_seconds is not null and attempts < max_attempts
                      then now() + make_interval(secs => p_retry_in_seconds)
                    else next_attempt_at
                  end,
         locked_at = null,
         locked_by = null,
         last_error_code = left(coalesce(p_error_code, 'UNKNOWN'), 64),
         last_error_category = p_error_category,
         last_error = left(p_error_message, 500)
   where id = p_outbox_id
     and status = 'SENDING'
     and locked_by = p_worker_id
  returning status into v_status;

  if not found then
    return 'LEASE_LOST';
  end if;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Exploitation : requeue explicite + rattrapage
-- ---------------------------------------------------------------------------

-- Remet une entrée FAILED en file (décision humaine). La destination est
-- relue depuis la configuration courante : si elle a changé, la clé
-- d'export change aussi (nouvelle destination = nouvel export logique).
create or replace function public.rushour_requeue(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_integration_id text;
  v_row public.rushour_order_outbox;
begin
  select b.* into v_row
  from public.rushour_order_outbox b
  where b.order_id = p_order_id and b.status = 'FAILED'
  for update;

  if not found then
    return false;
  end if;

  select c.rushour_integration_id into v_integration_id
  from public.restaurant_rushour_connections c
  where c.restaurant_id = v_row.restaurant_id and c.enabled = true;

  if v_integration_id is null then
    return false;
  end if;

  update public.rushour_order_outbox
     set status = 'PENDING',
         attempts = 0,
         next_attempt_at = now(),
         destination_integration_id = v_integration_id,
         export_key = public.rushour_export_key(p_order_id, v_integration_id)
   where id = v_row.id;

  insert into public.rushour_sync_events (outbox_id, restaurant_id, order_id, step, outcome, attempt, error_code)
  values (v_row.id, v_row.restaurant_id, p_order_id, 'REQUEUE', 'REQUEUED', v_row.attempts, v_row.last_error_code);

  return true;
end;
$$;

-- Rattrape les commandes d'établissements connectés sans entrée outbox
-- (échec d'enqueue journalisé, ou activation après coup). Borne
-- temporelle OBLIGATOIRE : activer un restaurant ne doit jamais renvoyer
-- son historique par accident.
create or replace function public.rushour_enqueue_missing(p_since timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_order_id uuid;
begin
  if p_since is null or p_since < now() - interval '7 days' then
    raise exception 'INVALID_SINCE';
  end if;

  for v_order_id in
    select o.id
    from public.orders o
    join public.restaurant_rushour_connections c
      on c.restaurant_id = o.restaurant_id and c.enabled = true
    where o.created_at >= p_since
      and not exists (select 1 from public.rushour_order_outbox b where b.order_id = o.id)
  loop
    if public.rushour_enqueue_order(v_order_id) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilèges des fonctions : service_role uniquement
-- ---------------------------------------------------------------------------

revoke all on function public.rushour_export_key(uuid, text) from public, anon, authenticated;
revoke all on function public.rushour_enqueue_order(uuid) from public, anon, authenticated;
revoke all on function public.rushour_enqueue_after_order_insert() from public, anon, authenticated;
revoke all on function public.rushour_claim_outbox(text, integer) from public, anon, authenticated;
revoke all on function public.rushour_mark_sent(uuid, text, text) from public, anon, authenticated;
revoke all on function public.rushour_mark_failed(uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.rushour_requeue(uuid) from public, anon, authenticated;
revoke all on function public.rushour_enqueue_missing(timestamptz) from public, anon, authenticated;

grant execute on function public.rushour_export_key(uuid, text) to service_role;
grant execute on function public.rushour_enqueue_order(uuid) to service_role;
grant execute on function public.rushour_claim_outbox(text, integer) to service_role;
grant execute on function public.rushour_mark_sent(uuid, text, text) to service_role;
grant execute on function public.rushour_mark_failed(uuid, text, text, text, text, integer) to service_role;
grant execute on function public.rushour_requeue(uuid) to service_role;
grant execute on function public.rushour_enqueue_missing(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Rétention du journal (90 jours) si pg_cron est présent (il l'est sur les
-- projets Foodatoi : migration 20260906131000).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'purge-rushour-sync-events') then
      perform cron.unschedule('purge-rushour-sync-events');
    end if;
    perform cron.schedule(
      'purge-rushour-sync-events',
      '15 3 * * *',
      $purge$delete from public.rushour_sync_events where created_at < now() - interval '90 days'$purge$
    );
  end if;
end $$;

commit;
