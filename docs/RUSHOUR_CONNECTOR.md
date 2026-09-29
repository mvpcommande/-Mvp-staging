# Connecteur RusHour — Blocs 1 et 1.1 (mode mock)

> **Statut : déployé et validé sur le STAGING (`kkhlpeqherxfdnilewkp`), en mode MOCK uniquement.**
> Aucun appel à l'API RusHour réelle n'est possible dans cette version
> (double verrou : `resolveRuntime()` n'accepte que `RUSHOUR_MODE=mock` et
> ignore `RUSHOUR_APP_*`, et `RushourHttpClient` refuse de s'instancier).
> Production (`ffuykessameuonpnyiyc`) : **non modifiée**.

## 1. Architecture

```
Client web (aujourd'hui) / WhatsApp (plus tard, via un "Order Input Adapter")
        │
        ▼
create_order()  ── RPC SECURITY DEFINER existante, NON modifiée
        │   (prix, total, horaires, rate-limit, idempotency checkout…)
        ▼
orders ──(AFTER INSERT, même transaction)──► rushour_order_outbox (PENDING)
   │                                                │
   │  enqueue en échec (absorbé)                    │
   └──► ENQUEUE_FAILED ──► rushour_reconcile() ─────┤  (pg_cron, toutes les 2 min)
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
   passe toujours**, et la réconciliation automatique recrée l'entrée
   (voir « Garantie réelle » ci-dessous).
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
toute insertion quel que soit le canal, s'exécute dans la transaction de la
commande, ne fait aucun réseau, et le chemin idempotent de `create_order()`
n'insérant rien, il n'enqueue rien.

### Garantie réelle (correction de wording, Bloc 1.1)

L'outbox n'est **pas** strictement atomique avec la commande dans tous les
cas : le trigger absorbe volontairement toute erreur d'enqueue, parce
qu'**une commande client ne doit jamais être refusée à cause du connecteur
RusHour**.

- **PRIMARY PATH** : `INSERT orders` → trigger → `INSERT outbox` → `COMMIT`
  (commande et entrée d'export dans la même transaction ; un `ROLLBACK` de
  la commande n'en laisse aucune).
- **DEGRADED PATH** : `INSERT orders` → l'enqueue échoue → commande
  **committée** → événement `ENQUEUE_FAILED` → `rushour_reconcile()` (job
  serveur récurrent) → entrée outbox recréée, avec la même clé d'export.

Formulation exacte : *transactional enqueue when possible + automatic
reconciliation fallback*. Fenêtre d'exposition du degraded path : la
période de la réconciliation (2 min en staging).

### Réconciliation automatique

`rushour_reconcile(p_lookback interval default '24 hours', p_limit int default 200)`,
exécutée par pg_cron (`rushour-reconcile-staging`, toutes les 2 min, SQL
pur, aucun réseau). Choix de pg_cron plutôt que d'un appel à l'Edge
Function : c'est une opération purement base de données, elle doit tourner
même si la fonction ou le réseau sont en panne, et pg_cron est déjà
utilisé par Foodatoi. Aucun polling navigateur.

Elle recrée l'entrée pour les commandes :
- d'un restaurant dont la connexion est `enabled = true` ;
- créées depuis `max(export_from, now() - lookback)` ;
- encore en cours (`NEW`, `ACCEPTED`, `PREPARING`). Une commande déjà
  `READY` ou `CANCELLED` a été traitée hors RusHour : la pousser en cuisine
  après coup provoquerait une double préparation ;
- sans aucune entrée outbox.

Elle est idempotente (`ON CONFLICT (order_id) DO NOTHING` + `UNIQUE(order_id)`),
bornée (lookback ≤ 7 jours, ≤ 1000 commandes par passage, aucune boucle),
sérialisée (verrou consultatif : une exécution concurrente rend 0 sans
attendre), observable (un événement `RECONCILE/RECONCILED` par entrée
recréée) et tenant-safe (clé d'export identique au primary path).

`export_from` (colonne de `restaurant_rushour_connections`) est la borne
basse. Elle vaut l'instant de la **première** activation : activer un
restaurant ne renvoie jamais son historique. Une désactivation puis
réactivation la **conserve** : les commandes passées pendant la coupure
(dans la fenêtre de lookback) sont rattrapées, exactement une fois.
`rushour_enqueue_missing(p_since)` reste disponible comme alias manuel
borné de la réconciliation.

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
`restaurant_id` (PK/FK), `rushour_integration_id` (requis, format contrôlé),
`rushour_store_id` (optionnel, UNKNOWN), `enabled` (défaut **false**),
`export_from`, `created_at`, `updated_at`. **Aucun secret, jamais.**

`rushour_integration_id` **n'est pas unique** (Bloc 1.1) : la cardinalité
integrationId ↔ établissement n'est pas confirmée par RusHour, on
n'impose donc pas en base un invariant externe inconnu. Deux restaurants
peuvent aujourd'hui techniquement partager un identifiant (testé). Ce n'est
pas une recommandation : une éventuelle unicité sera réintroduite après
lecture de la documentation RusHour. L'isolation tenant ne dépend pas de
cette contrainte (PK `restaurant_id`, FK composites, clé d'export par
commande).

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
- **409 : TEMPORARY CONSERVATIVE BEHAVIOR.** Le 409 est traité comme
  `NON_RETRYABLE` → revue humaine, uniquement parce que sa sémantique
  RusHour est inconnue. Un 409 n'est **pas** considéré comme la preuve d'un
  doublon (ni comme un succès). À revoir dès la lecture de la documentation
  RusHour.
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
- Rattrapage : automatique (`rushour_reconcile`, pg_cron) ; manuel :
  `select rushour_reconcile();` ou `select rushour_enqueue_missing(now() - interval '1 hour');`.
- Requeue manuel : `select rushour_requeue('<order_id>');`
- Supervision : `select status, count(*) from rushour_order_outbox group by 1;`
  et `rushour_sync_events` (FAILED, `ENQUEUE_FAILED`, `COMPLETION_UNCERTAIN`).

### Application sur STAGING (manuelle, non faite)

1. Vérifier **positivement** la cible : project ref `kkhlpeqherxfdnilewkp`
   (staging). Jamais `ffuykessameuonpnyiyc` (production). Inspecter le vrai
   schéma avant d'appliquer (voir §15 : dérive de schéma à contrôler).
2. Appliquer, dans l'ordre, `20260928090000_rushour_connector_foundation.sql`
   puis `20260929090000_rushour_reconciliation_and_fixes.sql`
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
5. Ordonnancement : `supabase/ops/rushour_staging_schedule.sql` (script
   d'exploitation, pas une migration) crée `rushour-reconcile-staging`
   (toutes les 2 min) et `rushour-dispatch-staging` (chaque minute, pg_net
   → Edge Function, secret lu dans Vault). Pré-requis : créer le secret
   Vault `rushour_dispatch_secret` hors Git. Le script refuse de tourner si
   `-v project_ref` n'est pas le staging. C'est un garde-fou déclaratif :
   la cible réelle reste l'URL de connexion utilisée, à vérifier.
   En mode mock, les commandes du restaurant de test passent `SENT` avec
   un `external_order_id` préfixé `mock_` : c'est attendu en staging.

## 10. Variables futures (serveur uniquement)

| Nom | Où | Quand |
|---|---|---|
| `RUSHOUR_DISPATCH_SECRET` | Secrets Edge Function + Vault | Bloc 1 (staging) |
| `RUSHOUR_MODE` | Secrets Edge Function | Bloc 1 : `mock` |
| `RUSHOUR_MOCK_SCENARIO` | Secrets Edge Function | Bloc 1 (tests staging), ex. `timeout,success` |
| `RUSHOUR_MOCK_RETRY_AFTER_SECONDS` | Secrets Edge Function | Bloc 1.1 (test 429) |
| `RUSHOUR_SEND_TIMEOUT_MS` | Secrets Edge Function | Bloc 1.1 (500..15000, défaut 10000) |
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

## 15. Bloc 1.1 : validation sur le vrai staging

### Identification

`kkhlpeqherxfdnilewkp` = projet « Mvp-test » (eu-central-1). Sa clé
publishable est identique à celle de `.github/workflows/deploy.yml` du
staging, et ce n'est pas `ffuykessameuonpnyiyc` (production). Le projet
était en pause ; il a été réactivé.

### Dérive de schéma constatée et traitée

Le staging a été construit par ses propres migrations `*_e2e_staging` : 6
tables, `create_order` en 2 surcharges anciennes (sans `p_payment_method`).
Il n'avait pas `set_updated_at()`, `current_restaurant_id()` ni
`is_restaurant_admin()`, dont dépend la migration RusHour.
→ `supabase/ops/staging_align_tenant_helpers.sql` les crée avec
**exactement** les définitions de production. Aucune migration existante
n'a été modifiée. Un dry-run dans une transaction annulée (`ROLLBACK`) a
été exécuté sur le vrai schéma avant toute écriture.

### Migrations appliquées sur le staging (dans l'ordre)

| Version staging | Nom | Source repo |
|---|---|---|
| `20260929065620` | `staging_align_tenant_helpers` | `supabase/ops/staging_align_tenant_helpers.sql` |
| `20260929065741` | `rushour_connector_foundation` | `20260928090000_rushour_connector_foundation.sql` |
| `20260929065819` | `rushour_reconciliation_and_fixes` | `20260929090000_rushour_reconciliation_and_fixes.sql` |
| (v. suivante) | `rushour_dispatch_secret_vault` | `20260929100000_rushour_dispatch_secret_vault.sql` |
| (v. suivante) | `enable_pg_net…` puis `move_pg_net_to_extensions_schema` | `pg_net` dans le schéma `extensions` |

Supabase attribue ses propres numéros de version (horodatage
d'application) ; le contenu SQL est celui des fichiers du repo, sans les
commentaires.

### Secret du dispatcher

Le secret est généré **dans la base** (`extensions.gen_random_bytes(32)`),
stocké dans Supabase Vault (`rushour_dispatch_secret`), et vérifié par
l'Edge Function via `rushour_verify_dispatch_secret` (service_role
uniquement). Il n'a jamais été affiché, copié ni committé. C'est la même
source que lit pg_net/pg_cron. Script : `supabase/ops/rushour_dispatch_secret.sql`.

### Edge Function

`rushour-dispatch-order` v2, `verify_jwt=false` (authentification par
secret), aucun `RUSHOUR_MODE` défini, donc `mock` par défaut. Le code
déployé a été relu via l'API et comparé : **13/13 fichiers identiques au
repo**. La v1 avait été déployée par erreur avec un fichier incomplet ;
elle ne pouvait pas démarrer, n'a jamais été appelée, et a été remplacée
quelques minutes plus tard.

### Parcours validé sur le staging réel

Restaurant de test `rushour-test-staging` (données fictives), connexion
`mock-staging-integration` activée, 3 produits et 3 mappings
`mock-rh-product-1..3`. Le restaurant `demo-charge`, utilisé par l'e2e
Playwright, n'a pas été touché.

1. `POST /rest/v1/rpc/create_order` via la **passerelle API Supabase**,
   avec la clé publishable (mêmes en-têtes et même corps que
   `supabaseStore.mjs`), émis depuis la base par pg_net car l'environnement
   de l'agent n'a pas d'accès HTTPS au staging → HTTP 200,
   `FA-260929-7ABFD9`, total serveur 3200 cts (3 lignes, 6 articles,
   options).
2. Trigger → outbox **PENDING**, 1 ligne, clé `fdt1_…` conforme.
3. `POST /functions/v1/rushour-dispatch-order`, secret lu dans Vault →
   HTTP 200 `{"mode":"mock","claimed":1,"sent":1}`.
4. Outbox **SENT**, 1 tentative, `external_order_id = mock_…`, événement
   `COMPLETE:SENT`.
5. Deux dispatchs supplémentaires → `claimed: 0`, rien ne change.
6. Mauvais secret → 401 ; anon `GET /rest/v1/rushour_order_outbox` → 401
   (42501) ; anon `rpc/rushour_reconcile` → 401 (42501).

Les scénarios d'échec (timeout, 429, 500, 400, 401, mapping manquant,
désactivation, panne d'enqueue, concurrence, reprise de bail) sont
prouvés sur la pile locale équivalente (`supabase/tests/rushour/e2e/`,
56 assertions). Sur le staging, ils nécessitent de changer
`RUSHOUR_MOCK_SCENARIO` dans les secrets de la fonction, ce que les outils
de l'agent ne permettent pas (voir limites).

### Pile locale équivalente (preuve des scénarios d'échec)

- Postgres 16 avec la vraie `create_order()` de production et les
  migrations RusHour ;
- PostgREST 12 ;
- la vraie Edge Function sous Deno, avec `--allow-net` limité à la pile ;
- les commandes créées par le module frontend `supabaseStore.mjs`.

Les seules interventions SQL directes sont marquées `[TEST-ONLY]`.

### timeout_after_accept — prouvé / non prouvé

- **prouvé** : même clé d'export et même payload au retry, ni seconde
  commande ni seconde outbox, un seul export logique côté mock ;
- **UNKNOWN** : la déduplication par le **vrai** RusHour sur
  `id`/`externalId`. Sans elle, un timeout ambigu suivi d'un retry
  créerait deux commandes RusHour. C'est le premier point à confirmer.
- l'état du mock vit dans l'isolate (recyclé par Supabase) : c'est un
  confort de test, pas une garantie.

## 16. Bloc 2 : client HTTP réel (préparé, live verrouillé)

- **`RushourHttpClient`** (`httpClient.mjs`) : token d'intégration côté
  serveur, avec cache mémoire par intégration, marge avant expiration et
  requête unique partagée entre appels simultanés. Timeout explicite sur
  chaque requête. Classification HTTP. Un seul renouvellement de token sur
  401, et seulement si le profil l'autorise. Validation du corps de réponse.
  Aucun secret ni corps de réponse dans les erreurs.
- **`apiProfile.mjs`** : seul endroit où vivent les valeurs dépendant de
  RusHour. `verified: false` → client réel désactivé. Détail des 20 points :
  [`RUSHOUR_API_VERIFIED.md`](./RUSHOUR_API_VERIFIED.md).
- **Mode `live`** (`runtime.mjs`), accepté seulement si tous ces verrous sont
  levés ; sinon 503, sans aucun réseau :
  1. projet `kkhlpeqherxfdnilewkp` uniquement ; `ffuykessameuonpnyiyc`
     explicitement refusé ;
  2. profil d'API **et** schéma de payload vérifiés ;
  3. `RUSHOUR_APP_ID` et `RUSHOUR_APP_SECRET` présents dans les secrets de
     la fonction ;
  4. destinations `target_environment = 'test'` uniquement.

  Le mode par défaut reste `mock`.
- **Statut `UNCERTAIN`** (migration `20260930090000`). Tant que la
  déduplication RusHour n'est pas confirmée, les cas suivants mènent à
  `UNCERTAIN`, jamais réclamé à nouveau :
  - timeout après POST ;
  - coupure réseau pendant l'envoi ;
  - réponse 2xx illisible ;
  - délai du dispatcher dépassé ;
  - bail expiré en live.

  Résolution humaine après vérification côté RusHour :
  `rushour_resolve_uncertain(order_id, exists_in_rushour, external_id)`.
- **Payment gate configurable** : voir
  [`PAYMENT_GATE_RUSHOUR.md`](./PAYMENT_GATE_RUSHOUR.md).
- **Observabilité** : `duration_ms` et `endpoint` sur `rushour_sync_events` ;
  vue `rushour_dispatch_metrics`, qui expose les compteurs `success`,
  `failed`, `retry`, `uncertain`, `auth_error`, `mapping_error` et la durée
  moyenne, avec la RLS appliquée.
- **Webhooks RusHour** : non implémentés. La signature n'est pas documentée,
  donc aucun endpoint entrant ne peut être sécurisé.
