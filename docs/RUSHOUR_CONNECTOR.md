# Connecteur RusHour — Bloc 1 (fondation, mode mock)

> **Statut : fondation livrée sur staging, en mode MOCK uniquement.**
> Aucun appel à l'API RusHour réelle n'est possible dans cette version
> (double verrou : Edge Function `RUSHOUR_MODE=mock` + `RushourHttpClient`
> qui refuse de s'instancier). Aucune migration n'a été appliquée.

## 1. Architecture

```
Client web (aujourd'hui) / WhatsApp (plus tard, via un "Order Input Adapter")
        │
        ▼
create_order()  ── RPC SECURITY DEFINER existante, NON modifiée
        │   (prix, total, horaires, rate-limit, idempotency checkout…)
        ▼
orders ──(AFTER INSERT, même transaction)──► rushour_order_outbox (PENDING)
                                                    │
               pg_cron + pg_net (chaque minute) ────┘  [à activer, §9]
                                                    ▼
                       Edge Function rushour-dispatch-order
                         │ rushour_claim_outbox()  (FOR UPDATE SKIP LOCKED + bail)
                         │ config → clé d'export → normalisation → mapping
                         │ RushourMockClient  (Bloc 2 : RushourHttpClient)
                         ▼
               rushour_mark_sent() / rushour_mark_failed()  (conditionnés au bail)
                         │
                         ▼
               rushour_sync_events (journal serveur, sans secret)
```

Retour futur (Bloc 2+) : webhook RusHour → Edge Function dédiée → Foodatoi
(événements confirmés par l'exemple officiel : `IntegrationCreated`,
`MenuSaved`, `OrderSaved`, `RestaurantOpened`, `RestaurantClosed` ; la
signature/authentification des webhooks est **UNKNOWN**).

Aucun serveur applicatif n'est ajouté : Postgres (outbox + fonctions
atomiques) et une Edge Function Supabase suffisent.

## 2. Flux d'une commande

1. `create_order()` insère la commande (inchangé).
2. Le trigger `orders_rushour_enqueue` appelle `rushour_enqueue_order()` :
   si le restaurant a une connexion RusHour **activée**, une ligne outbox
   `PENDING` est créée (`ON CONFLICT (order_id) DO NOTHING`). Toute erreur
   d'enqueue est capturée et journalisée (`ENQUEUE_FAILED`) : **la commande
   passe toujours**.
3. Le worker réclame un lot : `PENDING` échues → `SENDING`, `attempts+1`,
   `locked_by = workerId`, `locked_at = now()`.
4. Pour chaque entrée : relecture de la config, contrôle que la destination
   n'a pas changé, recalcul et contrôle de la clé d'export, normalisation
   (`types.mjs`), mapping pur (`mapper.mjs`), envoi borné par un timeout
   (10 s).
5. Succès → `SENT` (+ `external_order_id`). Échec → politique de retry →
   `PENDING` avec `next_attempt_at` ou `FAILED`.

Pourquoi un **trigger** plutôt qu'une modification de `create_order()` : la
RPC est la pièce la plus durcie du produit (8 versions) ; le trigger capte
toute insertion quel que soit le canal, vit dans la même transaction
(outbox transactionnelle : commande et export sont validés ou annulés
ensemble), ne fait aucun réseau, et le chemin idempotent de `create_order()`
n'insérant rien, il n'enqueue rien. Détail : en-tête de la migration.

## 3. Composants

| Fichier | Rôle |
|---|---|
| `supabase/migrations/20260928090000_rushour_connector_foundation.sql` | Tables, RLS, trigger, fonctions atomiques |
| `supabase/rollbacks/rollback_20260928090000_…sql` | Retour arrière complet (testé) |
| `supabase/functions/_shared/rushour/types.mjs` | Modèle normalisé Foodatoi + validation |
| `…/config.mjs` | Résolution de la destination par restaurant |
| `…/idempotency.mjs` | Clé d'export stable (parité SQL testée) |
| `…/mapper.mjs` | Mapper pur Foodatoi → RusHour, fail-closed |
| `…/errors.mjs` | Catégories d'erreur + classification HTTP |
| `…/retryPolicy.mjs` | Politique de retry déterministe et bornée |
| `…/client.mjs` | Contrat client + `RushourHttpClient` verrouillé |
| `…/mockClient.mjs` | Client mock (11 scénarios, zéro réseau) |
| `…/dispatcher.mjs` | Orchestration d'une entrée / d'un lot |
| `…/logging.mjs` | Événements en liste blanche + masquage des secrets |
| `…/supabaseRepository.mjs` | Port repository (supabase-js, service_role) |
| `…/inMemoryOutbox.mjs`, `fixtures.mjs` | Doubles et données de test |
| `supabase/functions/rushour-dispatch-order/index.ts` | Adaptateur HTTP de l'Edge Function |
| `supabase/tests/rushour/` | Tests Postgres réels (RLS, trigger, concurrence) |

Le code partagé vit dans `supabase/functions/_shared/` (convention Supabase)
plutôt qu'à la racine : l'Edge Function ne peut embarquer que ce qui est
sous `supabase/functions/`, et ces modules ESM purs sont importés à
l'identique par `node --test` et par Deno.

## 4. Modèle de données

**`restaurant_rushour_connections`** — une ligne par restaurant :
`restaurant_id` (PK/FK), `rushour_integration_id` (requis, format contrôlé,
**unique** : deux restaurants ne peuvent pas router vers la même
intégration), `rushour_store_id` (optionnel, UNKNOWN), `enabled` (défaut
**false**), `created_at`, `updated_at`. **Aucun secret, jamais.**

**`rushour_product_mappings`** — PK `(restaurant_id, product_id)`, FK
composite `(product_id, restaurant_id) → products(id, restaurant_id)` :
mapper un produit de A sous B est **impossible au niveau base**.

**`rushour_order_outbox`** — `UNIQUE(order_id)`, `UNIQUE(export_key)`, FK
composite vers `orders(id, restaurant_id)`, statut
`PENDING|SENDING|SENT|FAILED`, `attempts ≤ max_attempts (5)`, bail
(`locked_at`, `locked_by`), `destination_integration_id` figée à l'enqueue,
`last_error_*`, `external_order_id`, `sent_at`. Contraintes de cohérence
(SENDING ⇔ bail posé ; SENT ⇔ `sent_at`).

**`rushour_sync_events`** — journal serveur : restaurant, commande,
étape, résultat, catégorie/code d'erreur, statut HTTP, tentative,
horodatage, message masqué ≤ 500 car. Rétention 90 jours (pg_cron).
Distinct de `client_error_logs` (inscriptible par anon, donc impropre à un
journal serveur).

## 5. Idempotence d'export

Distincte de l'idempotence checkout (qui protège la *création* de la
commande). Clé = `'fdt1_' || 32 hex de sha256('foodatoi-rushour-export:v1:'
|| order_id || ':' || integration_id)` :

- pas d'horloge, pas d'aléa, pas de numéro de tentative : chaque retry
  porte **la même** clé ;
- identique en SQL (`rushour_export_key`) et en JS (`computeExportKey`) —
  parité vérifiée par le test Postgres ;
- une commande = une ligne outbox (`UNIQUE(order_id)`) : retry, timeout,
  refresh, worker relancé, double événement, reconnexion ou webhook rejoué
  ne peuvent pas créer un second export logique côté Foodatoi ;
- envoyée à RusHour dans `id`/`externalId`. **Que RusHour déduplique sur
  ce champ est UNKNOWN** : c'est le point à confirmer en priorité en Bloc 2,
  car il conditionne la sûreté d'un retry après timeout ambigu.

## 6. Retry

| Échec de la tentative | Action |
|---|---|
| 1 | retry dans 5 s |
| 2 | retry dans 30 s |
| 3 | retry dans 2 min |
| 4 | retry dans 10 min |
| 5 | `FAILED` (revue humaine, `rushour_requeue(order_id)`) |

- `RETRYABLE` (5xx, réseau), `TIMEOUT`, `RATE_LIMIT` : retry ; `Retry-After`
  respecté (max(politique, Retry-After), plafonné à 1 h).
- `AUTH_ERROR` (401/403) : retry espacé d'au moins 10 min, borné.
- `NON_RETRYABLE` (400, 404, 409, 422…), `MAPPING_ERROR`,
  `VALIDATION_ERROR` : `FAILED` immédiat.
- `UNKNOWN` (dont réponse 2xx illisible) : `FAILED` — la commande a *peut-être*
  été créée, un rejeu automatique risquerait un doublon en cuisine.
- La base plafonne `attempts ≤ max_attempts` indépendamment du JS : aucune
  boucle infinie possible. Un bail expiré (worker mort) est repris après
  10 min avec la même clé ; tentatives épuisées → `FAILED`.
- Délais = minimums : la granularité réelle est la période de l'ordonnanceur
  (1 min avec pg_cron).
- Paiement en ligne en attente (`payment_status = 'PENDING'`) : l'entrée
  attend sans consommer de tentative. Intégration désactivée : idem.

Mapping HTTP → catégorie = convention HTTP standard, **à reconfirmer** contre
la documentation RusHour (qui prime).

## 7. Concurrence

Protection en base, jamais par une variable JS :
`rushour_claim_outbox` = `SELECT … FOR UPDATE OF b SKIP LOCKED` + `UPDATE`
en une instruction ; `mark_sent`/`mark_failed` n'agissent que si
`status = 'SENDING' AND locked_by = workerId` (un worker dont le bail a été
repris obtient `LEASE_LOST` et n'écrit rien). Prouvé sur Postgres réel :
8 workers simultanés / 40 entrées → chaque entrée réclamée exactement une
fois ; un worker qui garde ses verrous n'est jamais doublé.

## 8. Sécurité et multi-tenant

- RLS activée sur les 4 tables ; lecture réservée à l'admin du restaurant
  (`is_restaurant_admin()` + `current_restaurant_id()`, modèle existant).
- Aucune policy d'écriture : `anon`/`authenticated` ne peuvent ni définir
  une intégration, ni modifier un mapping, ni passer `SENT`, ni toucher
  `attempts`/`external_order_id` (tests SQL). Écriture = `service_role`
  (Edge Function) ou SQL admin.
- Fonctions worker : `EXECUTE` révoqué à `PUBLIC/anon/authenticated`.
- Mapper fail-closed : produit non mappé, mapping d'un autre restaurant,
  destination d'un autre restaurant, clé d'export altérée → aucun envoi.
- Aucun identifiant RusHour, restaurant ou produit codé en dur ; aucun
  nombre d'établissements supposé.
- Secrets : uniquement Supabase Secrets de l'Edge Function, jamais `VITE_`,
  jamais en base, jamais dans les logs (masquage testé), jamais dans le
  bundle (test sur `dist/`). Edge Function : accès par secret partagé
  comparé à temps constant, pas par JWT (un JWT anon suffirait à passer
  `verify_jwt`) ; sans secret configuré elle répond 503.

## 9. Mock, tests, exploitation

- Mock : `RushourMockClient` — `success`, `duplicate`, `http_400`,
  `http_401`, `http_409`, `http_429` (+ Retry-After), `http_500`, `timeout`,
  `timeout_after_accept`, `network`, `invalid_response`. Aucun réseau
  (vérifié en neutralisant `fetch`).
- Tests : voir [`RUSHOUR_TEST_PLAN.md`](./RUSHOUR_TEST_PLAN.md).
- Rattrapage : `select rushour_enqueue_missing(now() - interval '1 hour');`
  (borné à 7 jours).
- Requeue manuel : `select rushour_requeue('<order_id>');`
- Supervision : `select status, count(*) from rushour_order_outbox group by 1;`
  et `rushour_sync_events` (FAILED, `ENQUEUE_FAILED`, `COMPLETION_UNCERTAIN`).

### Application sur STAGING (manuelle, non faite)

1. Vérifier **positivement** la cible : project ref `kkhlpeqherxfdnilewkp`
   (staging). Jamais `ffuykessameuonpnyiyc` (production).
2. Appliquer `20260928090000_rushour_connector_foundation.sql`
   (SQL editor ou `supabase db push` après `supabase link --project-ref
   kkhlpeqherxfdnilewkp`).
3. Déployer la fonction (voir `supabase/functions/rushour-dispatch-order/README.md`),
   secret `RUSHOUR_DISPATCH_SECRET`, `RUSHOUR_MODE=mock`.
4. Configurer un restaurant de test :
   ```sql
   insert into restaurant_rushour_connections (restaurant_id, rushour_integration_id, enabled)
   values ('<resto demo staging>', 'staging-mock-integration', true);
   insert into rushour_product_mappings (restaurant_id, product_id, rushour_product_id)
   select restaurant_id, id, 'mock-' || left(id::text, 8) from products where restaurant_id = '<resto demo staging>';
   ```
5. Ordonnancement (à décider ; exemple pg_cron + pg_net + Vault) :
   ```sql
   select vault.create_secret('<RUSHOUR_DISPATCH_SECRET>', 'rushour_dispatch_secret');
   select cron.schedule('rushour-dispatch', '* * * * *', $$
     select net.http_post(
       url := 'https://kkhlpeqherxfdnilewkp.supabase.co/functions/v1/rushour-dispatch-order',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-rushour-dispatch-secret',
         (select decrypted_secret from vault.decrypted_secrets where name = 'rushour_dispatch_secret')),
       body := '{"limit": 10}'::jsonb);
   $$);
   ```
   En mode mock, les commandes du restaurant de test passent `SENT` avec
   un `external_order_id` préfixé `mock_` : c'est attendu en staging.

## 10. Variables futures (serveur uniquement)

| Nom | Où | Quand |
|---|---|---|
| `RUSHOUR_DISPATCH_SECRET` | Secrets Edge Function + Vault | Bloc 1 (staging) |
| `RUSHOUR_MODE` | Secrets Edge Function | Bloc 1 : `mock` |
| `RUSHOUR_MOCK_SCENARIO` | Secrets Edge Function | Bloc 1 (tests staging) |
| `RUSHOUR_APP_ID` | Secrets Edge Function | Bloc 2 |
| `RUSHOUR_APP_SECRET` | Secrets Edge Function | Bloc 2 |

Tokens d'intégration (Bloc 2) : obtenus à la volée côté serveur, gardés en
mémoire de l'Edge Function (durée de vie observée dans l'exemple officiel :
3600 s) — jamais stockés dans une table lisible, jamais loggés.

## 11. Dépendances externes et sources

- **Source consultée** : dépôt officiel `github.com/rushour-io/developers-api-demo`
  (client de référence + cookbooks, dernier commit août 2022).
- **Non consultable depuis l'environnement de développement** (bloqué par
  la politique réseau) : `developers.rushour.io` (référence API, OAuth
  playground, webhooks, sandbox) et `postman.rushour.io`. **À lire
  intégralement avant le Bloc 2.**

Confirmé par l'exemple officiel (à revérifier contre la référence) :

- hôte `https://api.rushour.io` ;
- token d'intégration : `POST /apps/{appId}/integrations/{integrationId}/token`,
  HTTP Basic `appId:appSecret`, corps `{"scopes":["public/oauth"]}`, réponse
  `{access_token, expires_in: 3600, token_type: "Bearer"}` ;
- envoi de commande : `POST /apps/{appId}/integrations/{integrationId}/orders`,
  `Authorization: Bearer <token d'intégration>` ;
- menus : `POST /apps/{appId}/integrations/{integrationId}/menus` ;
- webhooks : `POST /apps/{appId}/webhooks` `{host, events[]}` ; l'app doit être
  **validée par RusHour** (sinon 404) ; l'`integrationId` est fourni par
  l'équipe RusHour ;
- champs de commande de l'exemple : `id`, `externalId`, `displayId`, `status`
  (`"new"`), `type` (`"delivery"`), `orderedAt`, `prepareBy`, `total` (entier,
  1190), `discount`, `isPaid`, `paymentMethod` (`"card"`), `instructions`,
  `customer{name, phone, address{address}, orderCount}`, `items` (vide dans
  l'exemple), `fees`, `couriers`, `actions`, `preview`, `cutleryRequested`,
  `lastUpdatedAt`, `pickedUpAt`, `completedAt`, `acceptedAt`, `readiedAt`.

## 12. Points UNKNOWN (à lever en Bloc 2)

1. Schéma complet de `items[]` (produits, quantités, prix, **options/modifiers**).
2. Identifiant produit attendu par RusHour (id de menu RusHour ? externalId
   Foodatoi ? faut-il pousser le menu via `/menus` d'abord ?).
3. Valeur de `type` pour le click-and-collect (`"pickup"` supposé, **non
   confirmé**) et enum complète.
4. Unité de `total` (centimes supposés) ; enum `paymentMethod` (omis).
5. Déduplication RusHour sur `id`/`externalId` (conditionne la sûreté des
   retries après timeout ambigu).
6. Codes/erreurs HTTP réellement renvoyés, sémantique du 409, limites de
   débit, présence de `Retry-After`.
7. Signature/authentification des webhooks entrants ; événements de statut
   de commande (acceptée, prête…) et leur correspondance avec
   NEW/ACCEPTED/PREPARING/READY.
8. Existence d'un "store id" distinct de l'`integrationId`.
9. Sandbox : URL et comportement.
10. Longueur maximale acceptée pour `externalId` (la clé fait 37 caractères).

## 13. Passage mock → RusHour réel (Bloc 2)

Pré-requis : Developer Access RusHour, app créée **et validée**, `appId` +
`appSecret` (Supabase Secrets uniquement), store/intégration de test,
documentation API finale lue.

1. Lever chaque point du §12 ; mettre à jour `mapper.mjs` et ses tests
   (champs confirmés uniquement) ; passer `RUSHOUR_PAYLOAD_SCHEMA.verified`
   à `true` **dans le même commit** que les tests qui le justifient.
2. Implémenter `RushourHttpClient.sendOrder` : token d'intégration (cache
   mémoire, refresh sur expiration/401 une fois), `fetch` avec le `signal`
   fourni, erreurs via `classifyHttpStatus` / `toRushourError`, réponse via
   `validateSendResult`. Ne jamais logger les en-têtes.
3. Ajouter `RUSHOUR_MODE=live` dans l'Edge Function (aujourd'hui refusé) —
   le dispatcher, l'outbox, le retry et le mapping ne changent pas.
4. Tests : client HTTP contre un serveur local simulé ; puis sandbox RusHour
   sur le store de test ; puis un restaurant pilote avec `enabled = true`.
5. Production : migration relue et appliquée par le propriétaire, index
   créés `CONCURRENTLY` si volumétrie, activation restaurant par restaurant.

## 14. Futur WhatsApp / paiement

- **WhatsApp** : un adaptateur d'entrée appellera `create_order()` ; le
  trigger enqueue exactement comme pour le web. Le canal source n'a aucun
  effet sur le transport RusHour.
- **Paiement** : le paiement en ligne n'est **pas** finalisé aujourd'hui.
  Le connecteur est prêt pour `payment_status` : `PENDING` retient l'export
  (sans consommer de tentative), `PAID` → `isPaid: true`, `PAY_AT_STORE` →
  `isPaid: false`. Aucune modification paiement dans ce bloc.
