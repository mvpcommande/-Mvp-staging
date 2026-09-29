-- Tests SQL de la migration RusHour, exécutés sur Postgres réel par
-- run.sh (base jetable). Chaque bloc lève une exception en cas d'échec
-- (ON_ERROR_STOP) ; chaque succès affiche "ok - ...".

\set QUIET on
set client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- Données : A et B connectés, C sans connexion, D connexion désactivée.
-- ---------------------------------------------------------------------------
insert into public.restaurants (id, slug, name) values
  ('0a000000-0000-4000-8000-00000000000a', 'resto-a', 'Resto A'),
  ('0b000000-0000-4000-8000-00000000000b', 'resto-b', 'Resto B'),
  ('0c000000-0000-4000-8000-00000000000c', 'resto-c', 'Resto C'),
  ('0d000000-0000-4000-8000-00000000000d', 'resto-d', 'Resto D');

insert into public.products (id, restaurant_id, name, price_cents) values
  ('a1000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'Kebab', 850),
  ('a1000000-0000-4000-8000-000000000003', '0a000000-0000-4000-8000-00000000000a', 'Coca', 200),
  ('b1000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-00000000000b', 'Pizza', 1100),
  ('c1000000-0000-4000-8000-000000000001', '0c000000-0000-4000-8000-00000000000c', 'Burger', 950),
  ('d1000000-0000-4000-8000-000000000001', '0d000000-0000-4000-8000-00000000000d', 'Tacos', 700);

insert into public.restaurant_rushour_connections (restaurant_id, rushour_integration_id, enabled) values
  ('0a000000-0000-4000-8000-00000000000a', 'itg-a', true),
  ('0b000000-0000-4000-8000-00000000000b', 'itg-b', true),
  ('0d000000-0000-4000-8000-00000000000d', 'itg-d', false);

create function pg_temp.t_order(p_rest uuid, p_product uuid, p_qty int, p_key text default null,
                                p_payment text default 'PAY_AT_STORE')
returns uuid language sql as $$
  select id from public.create_order(
    p_rest, 'Client Test', '06' || lpad((floor(random() * 1e8))::bigint::text, 8, '0'),
    now() + interval '20 minutes', null,
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', p_qty,
                                         'options', jsonb_build_object('sauce', 'Blanche'))),
    p_key, p_payment);
$$;

create function pg_temp.check(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL - %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;
set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 1. Enqueue transactionnel via le VRAI create_order()
-- ---------------------------------------------------------------------------
do $$
declare v_order uuid; v_row public.rushour_order_outbox;
begin
  v_order := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 2, 'checkout-key-1');
  select * into v_row from public.rushour_order_outbox where order_id = v_order;
  perform pg_temp.check(found, 'create_order() sur un resto connecté crée une entrée outbox');
  perform pg_temp.check(v_row.status = 'PENDING' and v_row.attempts = 0, 'entrée initiale PENDING, 0 tentative');
  perform pg_temp.check(v_row.destination_integration_id = 'itg-a', 'restaurant A -> intégration A');
  perform pg_temp.check(v_row.export_key = public.rushour_export_key(v_order, 'itg-a'), 'clé d''export = rushour_export_key(order, destination)');
  perform pg_temp.check((select count(*) from public.order_items where order_id = v_order) = 1, 'order_items intacts (create_order non modifié)');
end $$;

do $$
declare v_1 uuid; v_2 uuid;
begin
  v_1 := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 2, 'checkout-key-1');
  v_2 := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 2, 'checkout-key-1');
  perform pg_temp.check(v_1 = v_2, 'idempotence checkout préservée (même clé -> même commande)');
  perform pg_temp.check((select count(*) from public.rushour_order_outbox where order_id = v_1) = 1,
    'replay checkout : toujours UNE seule entrée outbox');
  perform pg_temp.check(public.rushour_enqueue_order(v_1) = (select id from public.rushour_order_outbox where order_id = v_1),
    'enqueue explicite répété : idempotent (même ligne)');
  perform pg_temp.check((select count(*) from public.rushour_order_outbox where order_id = v_1) = 1, 'double enqueue impossible');
end $$;

do $$
declare v_b uuid; v_c uuid; v_d uuid;
begin
  v_b := pg_temp.t_order('0b000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-000000000001', 1);
  v_c := pg_temp.t_order('0c000000-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-000000000001', 1);
  v_d := pg_temp.t_order('0d000000-0000-4000-8000-00000000000d', 'd1000000-0000-4000-8000-000000000001', 1);
  perform pg_temp.check((select destination_integration_id from public.rushour_order_outbox where order_id = v_b) = 'itg-b',
    'restaurant B -> intégration B');
  perform pg_temp.check(not exists (select 1 from public.rushour_order_outbox where order_id = v_c),
    'restaurant sans configuration RusHour : commande créée, rien en outbox');
  perform pg_temp.check(not exists (select 1 from public.rushour_order_outbox where order_id = v_d),
    'intégration désactivée : commande créée, rien en outbox');
end $$;

-- Une commande annulée (rollback) ne laisse aucune entrée outbox.
begin;
select pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 1, 'rolled-back-key');
rollback;
do $$ begin
  perform pg_temp.check(not exists (
    select 1 from public.rushour_order_outbox b join public.orders o on o.id = b.order_id
    where o.idempotency_key = 'rolled-back-key'), 'transaction annulée : ni commande ni outbox (outbox transactionnelle)');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Un échec d'enqueue ne bloque JAMAIS la commande + rattrapage
-- ---------------------------------------------------------------------------
create function pg_temp.boom() returns trigger language plpgsql as $$
begin raise exception 'simulated outbox outage'; end; $$;
create trigger t_boom before insert on public.rushour_order_outbox for each row execute function pg_temp.boom();

do $$
declare v_order uuid;
begin
  v_order := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000003', 1, 'outage-key');
  perform pg_temp.check(v_order is not null and exists (select 1 from public.orders where id = v_order),
    'panne outbox : la commande Foodatoi est quand même créée');
  perform pg_temp.check(not exists (select 1 from public.rushour_order_outbox where order_id = v_order), 'panne outbox : pas d''entrée');
  perform pg_temp.check(exists (select 1 from public.rushour_sync_events
     where order_id = v_order and step = 'ENQUEUE' and outcome = 'ENQUEUE_FAILED'), 'panne outbox : échec journalisé');
end $$;

drop trigger t_boom on public.rushour_order_outbox;

do $$
declare v_n int;
begin
  v_n := public.rushour_enqueue_missing(now() - interval '1 hour');
  perform pg_temp.check(v_n = 1, 'rushour_enqueue_missing rattrape exactement la commande manquante');
  perform pg_temp.check(public.rushour_enqueue_missing(now() - interval '1 hour') = 0, 'rattrapage idempotent');
  begin
    perform public.rushour_enqueue_missing(now() - interval '30 days');
    raise exception 'FAIL - rattrapage sans borne accepté';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'ok - rattrapage borné à 7 jours (pas de renvoi d''historique accidentel)';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Contraintes anti cross-tenant / anti erreur de routage
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.rushour_product_mappings (restaurant_id, product_id, rushour_product_id)
    values ('0a000000-0000-4000-8000-00000000000a', 'b1000000-0000-4000-8000-000000000001', 'rh-x');
    raise exception 'FAIL - mapping cross-tenant accepté';
  exception when foreign_key_violation then
    raise notice 'ok - mapping d''un produit de B sous le restaurant A refusé (FK composite)';
  end;

  insert into public.rushour_product_mappings (restaurant_id, product_id, rushour_product_id)
  values ('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'rh-a-kebab');
  begin
    insert into public.rushour_product_mappings (restaurant_id, product_id, rushour_product_id)
    values ('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'rh-a-other');
    raise exception 'FAIL - double mapping accepté';
  exception when unique_violation then
    raise notice 'ok - UNIQUE(restaurant_id, product_id)';
  end;

  -- Bloc 1.1 : la cardinalité integrationId <-> établissement n'est pas
  -- confirmée par RusHour ; le schéma ne l'impose PAS (invariant externe
  -- inconnu). Ce n'est pas une recommandation de configuration.
  update public.restaurant_rushour_connections set rushour_integration_id = 'itg-a'
  where restaurant_id = '0b000000-0000-4000-8000-00000000000b';
  perform pg_temp.check((select count(*) from public.restaurant_rushour_connections where rushour_integration_id = 'itg-a') = 2,
    'deux restaurants PEUVENT techniquement partager un integrationId (invariant externe non imposé)');
  perform pg_temp.check(public.rushour_export_key('d0000000-0000-4000-8000-000000000001', 'itg-a')
    <> public.rushour_export_key('d0000000-0000-4000-8000-000000000002', 'itg-a'),
    'integrationId partagé : clés d''export toujours distinctes par commande');
  update public.restaurant_rushour_connections set rushour_integration_id = 'itg-b'
  where restaurant_id = '0b000000-0000-4000-8000-00000000000b';

  begin
    insert into public.rushour_order_outbox (restaurant_id, order_id, export_key, destination_integration_id)
    select '0b000000-0000-4000-8000-00000000000b', o.id, 'fdt1_00000000000000000000000000000000', 'itg-b'
    from public.orders o where o.restaurant_id = '0c000000-0000-4000-8000-00000000000c' limit 1;
    raise exception 'FAIL - outbox cross-tenant acceptée';
  exception when foreign_key_violation then
    raise notice 'ok - entrée outbox rattachée au mauvais restaurant refusée (FK composite)';
  end;

  begin
    update public.restaurant_rushour_connections set rushour_integration_id = 'bad id/../x'
    where restaurant_id = '0a000000-0000-4000-8000-00000000000a';
    raise exception 'FAIL - identifiant invalide accepté';
  exception when check_violation then
    raise notice 'ok - format d''identifiant RusHour contrôlé';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4. RLS / privilèges
-- ---------------------------------------------------------------------------
set role anon;
do $$
begin
  begin perform 1 from public.rushour_order_outbox; raise exception 'FAIL - anon lit l''outbox';
  exception when insufficient_privilege then raise notice 'ok - anon ne lit pas l''outbox'; end;
  begin
    insert into public.restaurant_rushour_connections (restaurant_id, rushour_integration_id, enabled)
    values ('0c000000-0000-4000-8000-00000000000c', 'itg-evil', true);
    raise exception 'FAIL - anon définit une intégration';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas définir une intégration RusHour'; end;
  begin
    insert into public.rushour_product_mappings (restaurant_id, product_id, rushour_product_id)
    values ('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000003', 'rh-evil');
    raise exception 'FAIL - anon modifie un mapping';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas modifier un mapping produit'; end;
  begin
    update public.rushour_order_outbox set status = 'SENT', attempts = 0, external_order_id = 'x';
    raise exception 'FAIL - anon modifie l''outbox';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas passer SENT / toucher attempts / external_order_id'; end;
  begin perform public.rushour_claim_outbox('evil', 10); raise exception 'FAIL - anon réclame';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas appeler rushour_claim_outbox'; end;
  begin perform public.rushour_mark_sent(gen_random_uuid(), 'evil', null); raise exception 'FAIL - anon mark_sent';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas appeler rushour_mark_sent'; end;
  begin perform public.rushour_requeue(gen_random_uuid()); raise exception 'FAIL - anon requeue';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas appeler rushour_requeue'; end;
end $$;
reset role;

-- Admin du restaurant A (JWT app_metadata, modèle existant).
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","app_metadata":{"role":"restaurant_admin","restaurant_id":"0a000000-0000-4000-8000-00000000000a"}}', false);
do $$
begin
  perform pg_temp.check((select count(*) from public.rushour_order_outbox) > 0
    and not exists (select 1 from public.rushour_order_outbox where restaurant_id <> '0a000000-0000-4000-8000-00000000000a'),
    'admin A voit l''outbox de A et uniquement A');
  perform pg_temp.check((select count(*) from public.restaurant_rushour_connections) = 1,
    'admin A ne voit que la connexion de A');
  begin
    update public.restaurant_rushour_connections set enabled = false;
    raise exception 'FAIL - authenticated modifie une connexion';
  exception when insufficient_privilege then raise notice 'ok - un admin restaurant ne modifie pas la config RusHour (écriture privilégiée)'; end;
  begin
    update public.rushour_order_outbox set status = 'SENT';
    raise exception 'FAIL - authenticated modifie l''outbox';
  exception when insufficient_privilege then raise notice 'ok - un admin restaurant ne modifie pas l''outbox'; end;
  begin perform public.rushour_claim_outbox('evil', 10); raise exception 'FAIL - authenticated réclame';
  exception when insufficient_privilege then raise notice 'ok - authenticated ne peut pas réclamer l''outbox'; end;
end $$;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","app_metadata":{"role":"customer"}}', false);
do $$ begin
  perform pg_temp.check((select count(*) from public.rushour_order_outbox) = 0, 'utilisateur non-admin : outbox invisible');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ---------------------------------------------------------------------------
-- 5. Cycle de vie worker (service_role)
-- ---------------------------------------------------------------------------
-- On isole une seule entrée pour des assertions exactes.
update public.rushour_order_outbox set next_attempt_at = now() + interval '1 day';

set role service_role;
do $$
declare v_order uuid; v_row public.rushour_order_outbox; v_status text;
begin
  select b.order_id into v_order from public.rushour_order_outbox b
  where b.destination_integration_id = 'itg-b' limit 1;
  update public.rushour_order_outbox set next_attempt_at = now() - interval '1 second' where order_id = v_order;

  select * into v_row from public.rushour_claim_outbox('worker-1', 10);
  perform pg_temp.check(v_row.order_id = v_order and v_row.status = 'SENDING' and v_row.attempts = 1
    and v_row.locked_by = 'worker-1', 'claim : PENDING -> SENDING, attempts=1, bail posé');
  perform pg_temp.check(not exists (select 1 from public.rushour_claim_outbox('worker-2', 10)),
    'une entrée SENDING n''est pas réclamable par un autre worker');

  perform pg_temp.check(public.rushour_mark_failed(v_row.id, 'worker-2', 'TIMEOUT', 'TIMEOUT', 'x', 5) = 'LEASE_LOST',
    'mark_failed par un worker sans bail : refusé (LEASE_LOST)');
  v_status := public.rushour_mark_failed(v_row.id, 'worker-1', 'TIMEOUT', 'TIMEOUT', 'timeout', 5);
  perform pg_temp.check(v_status = 'PENDING', 'échec retryable -> PENDING');
  select * into v_row from public.rushour_order_outbox where id = v_row.id;
  perform pg_temp.check(v_row.next_attempt_at > now() and v_row.next_attempt_at <= now() + interval '6 seconds'
    and v_row.locked_by is null, 'retry planifié dans 5 s, bail libéré');
  perform pg_temp.check(not exists (select 1 from public.rushour_claim_outbox('worker-1', 10)),
    'pas de reprise avant next_attempt_at');

  update public.rushour_order_outbox set next_attempt_at = now() - interval '1 second' where id = v_row.id;
  select * into v_row from public.rushour_claim_outbox('worker-1', 10);
  perform pg_temp.check(v_row.attempts = 2, 'retry : attempts=2');
  perform pg_temp.check(v_row.export_key = public.rushour_export_key(v_order, 'itg-b'),
    'retry : MÊME clé d''export');
  perform pg_temp.check(public.rushour_mark_sent(v_row.id, 'worker-2', 'rh-1') = false, 'mark_sent sans bail : refusé');
  perform pg_temp.check(public.rushour_mark_sent(v_row.id, 'worker-1', 'mock_abc') = true, 'mark_sent avec bail : SENT');
  select * into v_row from public.rushour_order_outbox where id = v_row.id;
  perform pg_temp.check(v_row.status = 'SENT' and v_row.sent_at is not null and v_row.external_order_id = 'mock_abc'
    and v_row.last_error is null, 'SENT : sent_at + external_order_id, erreur effacée');
  perform pg_temp.check(public.rushour_mark_sent(v_row.id, 'worker-1', 'mock_abc') = false, 'SENT est terminal (pas de ré-écriture)');
  perform pg_temp.check(not exists (select 1 from public.rushour_claim_outbox('worker-1', 10)), 'SENT jamais re-réclamé');
end $$;

-- Épuisement des tentatives -> FAILED, jamais de boucle infinie.
do $$
declare v_row public.rushour_order_outbox; v_status text; i int;
begin
  select * into v_row from public.rushour_order_outbox where destination_integration_id = 'itg-a' and status = 'PENDING' limit 1;
  for i in 1..10 loop
    update public.rushour_order_outbox set next_attempt_at = now() - interval '1 second' where id = v_row.id and status = 'PENDING';
    select * into v_row from public.rushour_claim_outbox('worker-x', 1);
    exit when v_row.id is null;
    v_status := public.rushour_mark_failed(v_row.id, 'worker-x', 'HTTP_500', 'RETRYABLE', 'boom', 5);
    exit when v_status = 'FAILED';
  end loop;
  perform pg_temp.check(v_status = 'FAILED' and v_row.attempts = 5, 'après 5 tentatives -> FAILED (max_attempts respecté en base)');
  update public.rushour_order_outbox set next_attempt_at = now() - interval '1 second' where id = v_row.id;
  perform pg_temp.check(not exists (select 1 from public.rushour_claim_outbox('worker-x', 10)), 'FAILED jamais re-réclamé automatiquement');

  perform pg_temp.check(public.rushour_requeue(v_row.order_id), 'requeue explicite d''une entrée FAILED');
  select * into v_row from public.rushour_order_outbox where id = v_row.id;
  perform pg_temp.check(v_row.status = 'PENDING' and v_row.attempts = 0
    and exists (select 1 from public.rushour_sync_events where outbox_id = v_row.id and step = 'REQUEUE'),
    'requeue : PENDING, attempts=0, journalisé');
  perform pg_temp.check(public.rushour_requeue(v_row.order_id) = false, 'requeue d''une entrée non FAILED : refusé');
end $$;

-- Erreur non-retryable : FAILED immédiat.
do $$
declare v_row public.rushour_order_outbox;
begin
  select * into v_row from public.rushour_claim_outbox('worker-y', 1);
  perform pg_temp.check(public.rushour_mark_failed(v_row.id, 'worker-y', 'PRODUCT_NOT_MAPPED', 'MAPPING_ERROR', 'x', null) = 'FAILED',
    'erreur non-retryable (retry null) -> FAILED immédiat');
  begin
    perform public.rushour_mark_failed(v_row.id, 'worker-y', 'X', 'NOT_A_CATEGORY', 'x', null);
    raise exception 'FAIL - catégorie invalide acceptée';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'ok - catégorie d''erreur contrôlée';
  end;
end $$;

-- Bail expiré (worker mort) : reprise par un autre worker ; l'ancien ne peut plus écrire.
do $$
declare v_row public.rushour_order_outbox; v_row2 public.rushour_order_outbox;
begin
  update public.rushour_order_outbox set next_attempt_at = now() - interval '1 second'
  where id = (select id from public.rushour_order_outbox where status = 'PENDING' order by created_at limit 1);
  select * into v_row from public.rushour_claim_outbox('worker-dead', 1);
  update public.rushour_order_outbox set locked_at = now() - interval '11 minutes' where id = v_row.id;
  select * into v_row2 from public.rushour_claim_outbox('worker-alive', 10);
  perform pg_temp.check(v_row2.id = v_row.id and v_row2.locked_by = 'worker-alive' and v_row2.attempts = v_row.attempts + 1
    and v_row2.export_key = v_row.export_key, 'bail expiré : reprise par un autre worker, même clé d''export');
  perform pg_temp.check(public.rushour_mark_sent(v_row.id, 'worker-dead', null) = false,
    'l''ancien worker (bail perdu) ne peut plus marquer SENT');
  perform public.rushour_mark_sent(v_row.id, 'worker-alive', null);

  -- Bail expiré avec tentatives épuisées : FAILED (reaper).
  perform pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 1, 'reaper-key');
  select * into v_row from public.rushour_claim_outbox('worker-dead', 1);
  perform pg_temp.check(v_row.id is not null, 'reaper : entrée réclamée par le worker qui va mourir');
  update public.rushour_order_outbox set locked_at = now() - interval '11 minutes', attempts = max_attempts where id = v_row.id;
  perform public.rushour_claim_outbox('worker-alive', 10);
  perform pg_temp.check((select status = 'FAILED' and last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS'
    from public.rushour_order_outbox where id = v_row.id), 'bail expiré + tentatives épuisées -> FAILED');
end $$;
reset role;

-- Paiement en ligne en attente / intégration désactivée : pas de réclamation, pas de tentative consommée.
do $$
declare v_order uuid;
begin
  v_order := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000003', 1, 'online-key', 'ONLINE');
  perform pg_temp.check((select payment_status from public.orders where id = v_order) = 'PENDING', 'commande ONLINE -> payment_status PENDING');
  perform pg_temp.check(not exists (select 1 from public.rushour_claim_outbox('worker-p', 100) where order_id = v_order),
    'paiement en attente : non réclamé');
  perform pg_temp.check((select attempts from public.rushour_order_outbox where order_id = v_order) = 0, 'paiement en attente : 0 tentative consommée');

  v_order := pg_temp.t_order('0b000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-000000000001', 1);
  update public.restaurant_rushour_connections set enabled = false where restaurant_id = '0b000000-0000-4000-8000-00000000000b';
  perform pg_temp.check(not exists (select 1 from public.rushour_claim_outbox('worker-p', 100) where order_id = v_order),
    'intégration désactivée après enqueue : non réclamé (en attente de réactivation)');
  update public.restaurant_rushour_connections set enabled = true where restaurant_id = '0b000000-0000-4000-8000-00000000000b';
end $$;

-- ---------------------------------------------------------------------------
-- 6. Parité de la clé d'export avec idempotency.mjs (valeur calculée par
--    node et injectée par run.sh)
-- ---------------------------------------------------------------------------
select set_config('rushour_test.js_export_key', :'js_export_key', false) \gset
do $$ begin
  perform pg_temp.check(
    public.rushour_export_key('d0000000-0000-4000-8000-000000000042', 'test-integration-a')
      = current_setting('rushour_test.js_export_key'),
    'clé d''export SQL == clé d''export JS (idempotency.mjs)');
  perform pg_temp.check(
    public.rushour_export_key('d0000000-0000-4000-8000-000000000042', 'test-integration-a')
      <> public.rushour_export_key('d0000000-0000-4000-8000-000000000042', 'test-integration-b'),
    'clé d''export différente par destination');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Réconciliation automatique (Bloc 1.1) — DEGRADED PATH
-- ---------------------------------------------------------------------------
-- 7a. Scénario critique : trigger d'enqueue en échec -> commande conservée,
--     pas d'outbox -> rushour_reconcile() -> exactement une entrée, deux fois.
create trigger t_boom before insert on public.rushour_order_outbox for each row execute function pg_temp.boom();
select pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 2, 'degraded-key') \gset degraded_
drop trigger t_boom on public.rushour_order_outbox;
select set_config('rushour_test.degraded_order', :'degraded_t_order', false) \gset
do $$
declare v_order uuid := current_setting('rushour_test.degraded_order')::uuid; v_n int;
begin
  perform pg_temp.check(exists (select 1 from public.orders where id = v_order), 'degraded path : order EXISTS');
  perform pg_temp.check(not exists (select 1 from public.rushour_order_outbox where order_id = v_order),
    'degraded path : rushour_order_outbox DOES NOT EXIST');
  perform pg_temp.check(exists (select 1 from public.rushour_sync_events where order_id = v_order and outcome = 'ENQUEUE_FAILED'),
    'degraded path : ENQUEUE_FAILED journalisé');
  v_n := public.rushour_reconcile();
  perform pg_temp.check(v_n >= 1 and (select count(*) from public.rushour_order_outbox where order_id = v_order) = 1,
    'réconciliation n°1 : outbox EXISTS EXACTLY ONCE');
  perform pg_temp.check((select export_key from public.rushour_order_outbox where order_id = v_order)
      = public.rushour_export_key(v_order, 'itg-a'), 'réconciliation : même clé d''export que le primary path');
  perform pg_temp.check(public.rushour_reconcile() = 0
      and (select count(*) from public.rushour_order_outbox where order_id = v_order) = 1,
    'réconciliation n°2 : toujours EXACTLY ONE (idempotente)');
  perform pg_temp.check(exists (select 1 from public.rushour_sync_events
      where order_id = v_order and step = 'RECONCILE' and outcome = 'RECONCILED'), 'réconciliation observable (événement RECONCILE)');
end $$;

-- 7b. Intégration désactivée puis réactivée.
do $$
declare v_order uuid;
begin
  update public.restaurant_rushour_connections set enabled = false where restaurant_id = '0a000000-0000-4000-8000-00000000000a';
  v_order := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000003', 1, 'disabled-key');
  perform pg_temp.check(exists (select 1 from public.orders where id = v_order)
      and not exists (select 1 from public.rushour_order_outbox where order_id = v_order),
    'intégration désactivée : commande créée, aucun export actif');
  perform pg_temp.check(public.rushour_reconcile() = 0, 'désactivée : la réconciliation n''exporte rien');
  update public.restaurant_rushour_connections set enabled = true where restaurant_id = '0a000000-0000-4000-8000-00000000000a';
  perform public.rushour_reconcile();
  perform pg_temp.check((select count(*) from public.rushour_order_outbox where order_id = v_order) = 1,
    'réactivée + réconciliation : commande de la coupure récupérée, exactement une fois');
  perform public.rushour_reconcile();
  perform pg_temp.check((select count(*) from public.rushour_order_outbox where order_id = v_order) = 1,
    'réactivée : pas de duplication');
end $$;

-- 7c. Première activation : pas de renvoi d'historique ; commandes terminées ignorées ; bornes.
do $$
declare v_old uuid; v_ready uuid;
begin
  select id into v_old from public.orders where restaurant_id = '0c000000-0000-4000-8000-00000000000c' limit 1;
  insert into public.restaurant_rushour_connections (restaurant_id, rushour_integration_id, enabled)
  values ('0c000000-0000-4000-8000-00000000000c', 'itg-c', true);
  perform public.rushour_reconcile();
  perform pg_temp.check(not exists (select 1 from public.rushour_order_outbox where order_id = v_old),
    'première activation : les commandes antérieures (export_from) ne sont pas exportées');

  create trigger t_boom before insert on public.rushour_order_outbox for each row execute function pg_temp.boom();
  v_ready := pg_temp.t_order('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 1, 'ready-key');
  drop trigger t_boom on public.rushour_order_outbox;
  update public.orders set status = 'READY' where id = v_ready;
  perform public.rushour_reconcile();
  perform pg_temp.check(not exists (select 1 from public.rushour_order_outbox where order_id = v_ready),
    'commande déjà READY : non réconciliée (pas de double préparation)');

  begin perform public.rushour_reconcile(interval '30 days'); raise exception 'FAIL - lookback non borné';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'ok - lookback borné à 7 jours';
  end;
end $$;

set role anon;
do $$ begin
  begin perform public.rushour_reconcile(); raise exception 'FAIL - anon réconcilie';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas appeler rushour_reconcile'; end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 8. Secret du dispatcher dans Vault (Bloc 1.1)
-- ---------------------------------------------------------------------------
do $$ begin
  perform pg_temp.check(public.rushour_verify_dispatch_secret('x') is null, 'Vault : secret absent -> NULL (fail closed)');
  insert into vault.secrets (name, secret) values ('rushour_dispatch_secret', repeat('s', 64));
  perform pg_temp.check(public.rushour_verify_dispatch_secret(repeat('s', 64)) = true, 'Vault : bon candidat -> TRUE');
  perform pg_temp.check(public.rushour_verify_dispatch_secret(repeat('t', 64)) = false, 'Vault : mauvais candidat -> FALSE');
  perform pg_temp.check(public.rushour_verify_dispatch_secret(null) = false, 'Vault : candidat NULL -> FALSE');
  delete from vault.secrets where name = 'rushour_dispatch_secret';
end $$;
set role anon;
do $$ begin
  begin perform public.rushour_verify_dispatch_secret('x'); raise exception 'FAIL - anon vérifie le secret';
  exception when insufficient_privilege then raise notice 'ok - anon ne peut pas interroger le secret du dispatcher'; end;
end $$;
reset role;
set role authenticated;
do $$ begin
  begin perform public.rushour_verify_dispatch_secret('x'); raise exception 'FAIL - authenticated vérifie le secret';
  exception when insufficient_privilege then raise notice 'ok - authenticated ne peut pas interroger le secret du dispatcher'; end;
end $$;
reset role;

\echo 'SQL tests: all assertions passed'
