# Plan de test — Connecteur RusHour (Bloc 1)

## Commandes

```bash
npm ci
npm test                    # historiques (87) + RusHour (73), node --test
npm run build               # puis relancer npm test : contrôle du bundle dist/
RUSHOUR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
  npm run test:db:rushour   # Postgres LOCAL jetable (refuse toute URL distante)
npm run test:e2e            # parcours réel sur le site staging (réseau requis)
RUSHOUR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
POSTGREST_BIN=/chemin/postgrest DENO_BIN=/chemin/deno \
  npm run test:e2e:rushour-local   # pile locale équivalente au staging (Bloc 1.1)
```

CI (`.github/workflows/deploy.yml`) : `test-and-build` (npm test + build) et
`rushour-db-tests` (service `postgres:16`) sur chaque PR vers `main` ; le
déploiement staging ne part que sur `main` et exige les deux jobs verts.

## Checklist — tests unitaires (node)

| # | Scénario | Fichier |
|---|---|---|
| A | mapping simple valide ; mapper pur et déterministe | `mapper.test.mjs` |
| B | multi-items | `mapper.test.mjs` |
| C | options produit (groupes, choix, doublons ignorés, options mal formées refusées) | `mapper.test.mjs` |
| D | total en centimes ; incohérences de montant refusées | `mapper.test.mjs` |
| E | restaurant A → intégration A | `mapper.test.mjs`, `dispatcher.test.mjs` |
| F | restaurant B → intégration B (+ lot 3 établissements) | `mapper.test.mjs`, `dispatcher.test.mjs` |
| G | absence de configuration RusHour | `mapper.test.mjs`, `dispatcher.test.mjs` |
| H | intégration désactivée | `mapper.test.mjs`, `dispatcher.test.mjs` |
| I | produit non mappé → FAILED, aucun appel | `mapper.test.mjs`, `dispatcher.test.mjs` |
| J | mapping / destination cross-tenant refusés | `mapper.test.mjs` |
| K | clé d'export stable | `dispatcher.test.mjs` |
| L | double appel / triple dispatch → un seul export logique ; timeout ambigu → doublon détecté | `dispatcher.test.mjs` |
| M | succès mock de bout en bout | `dispatcher.test.mjs` |
| N | timeout (y compris client qui ignore l'annulation) | `dispatcher.test.mjs` |
| O | HTTP 400 → FAILED immédiat | `dispatcher.test.mjs` |
| P | HTTP 401 → AUTH_ERROR, retry espacé | `dispatcher.test.mjs` |
| Q | HTTP 429 + Retry-After | `dispatcher.test.mjs` |
| R | HTTP 500 → retry | `dispatcher.test.mjs` |
| S | retry 5 s / 30 s / 2 min / 10 min ; timeout → retry → succès | `errors.test.mjs`, `dispatcher.test.mjs` |
| T | dépassement max attempts → FAILED, plus aucun envoi | `dispatcher.test.mjs` |
| U | concurrence simulée ; bail expiré → LEASE_LOST | `dispatcher.test.mjs` |
| V | payload/commande invalide (10 cas) ; annulée ; paiement en attente | `mapper.test.mjs` |
| W | aucune fuite de secret (logs, outbox, payload, frontend, dist/, repo) | `security.test.mjs` |
| + | 409, réseau, réponse invalide, duplicate, mock sans réseau, client réel verrouillé | `errors.test.mjs`, `dispatcher.test.mjs` |
| + | contrat repository ↔ signatures SQL (RPC, paramètres, colonnes), erreurs DB non fatales | `supabaseRepository.test.mjs` |

## Checklist — tests Postgres réels (`supabase/tests/rushour/run.sh`)

- [ ] `create_order()` **de production** (migration 20260922080200 appliquée telle quelle) enqueue en PENDING
- [ ] idempotence checkout préservée ; replay → une seule entrée outbox ; enqueue répété idempotent
- [ ] restaurant sans config / désactivé : commande créée, rien en outbox
- [ ] transaction annulée : ni commande ni outbox
- [ ] panne outbox simulée : commande créée quand même + `ENQUEUE_FAILED` journalisé + rattrapage
- [ ] FK composites : mapping cross-tenant et outbox cross-tenant refusés ; intégration partagée refusée
- [ ] RLS/privilèges : anon ne lit/écrit rien, n'appelle aucune fonction worker ; admin A ne voit que A et ne modifie rien
- [ ] cycle worker : claim, LEASE_LOST, retry planifié, même clé, SENT terminal
- [ ] 5 échecs → FAILED ; requeue explicite ; non-retryable → FAILED immédiat
- [ ] bail expiré → reprise ; ancien worker bloqué ; bail expiré + tentatives épuisées → FAILED
- [ ] paiement en attente / intégration désactivée → non réclamé, 0 tentative consommée
- [ ] parité clé d'export SQL == JS
- [ ] concurrence : 8 workers / 40 entrées → 40 réclamations uniques, 40 SENT, attempts = 1
- [ ] SKIP LOCKED : un worker qui garde ses verrous n'est jamais doublé
- [ ] rollback propre (commandes intactes) puis ré-application

## Checklist — non-régression Foodatoi

Automatisé : `npm test` (87 tests historiques inchangés), `npm run build`.

À vérifier manuellement sur staging **après** application de la migration :

CLIENT
- [ ] menu s'affiche ; panier ; options produit
- [ ] commande (`create_order`) aboutit, confirmation affichée
- [ ] double-clic / refresh sur « Commander » → une seule commande (idempotence checkout)

COMPTOIR
- [ ] la commande apparaît en temps réel
- [ ] coupure réseau → polling de secours → reprise
- [ ] transitions NEW → ACCEPTED → PREPARING → READY
- [ ] un compte du restaurant A ne voit rien du restaurant B

RUSHOUR (mode mock, restaurant de test)
- [ ] commande passée → ligne outbox PENDING
- [ ] appel de l'Edge Function → SENT, `external_order_id` = `mock_…`
- [ ] `RUSHOUR_MOCK_SCENARIO=http_500` → PENDING + `next_attempt_at`, `rushour_sync_events` renseigné
- [ ] restaurant non configuré → aucune ligne outbox
- [ ] Edge Function sans secret → 401 ; `RUSHOUR_MODE=live` → 503

## Critères de sortie

Tous les tests automatisés verts, aucun test existant désactivé ou modifié,
aucun appel RusHour réel, aucun secret dans le repo ni le bundle.

## Bloc 1.1 — ajouts

### Tests Postgres (`run.sh`, 89 assertions)

- [ ] DEGRADED PATH : trigger d'enqueue en échec → order EXISTS, outbox DOES NOT EXIST, `ENQUEUE_FAILED`
- [ ] `rushour_reconcile()` n°1 → outbox EXACTLY ONCE (même clé que le primary path) ; n°2 → toujours EXACTLY ONE ; événement `RECONCILE`
- [ ] deux restaurants avec le même `integrationId` acceptés (invariant externe non imposé)
- [ ] intégration désactivée → pas d'outbox, réconciliation inactive ; réactivée → récupérée une fois
- [ ] première activation : pas de renvoi d'historique (`export_from`) ; commande `READY` non réconciliée ; lookback borné
- [ ] anon ne peut pas appeler `rushour_reconcile`
- [ ] 6 réconciliations concurrentes sur 30 commandes → 30 entrées, aucune en double
- [ ] rollback Bloc 1.1 puis Bloc 1, ré-application des deux migrations

### Tests Node ajoutés (`runtime.test.mjs`)

- [ ] K. `RUSHOUR_MODE=mock` + `RUSHOUR_APP_ID/SECRET` présents → MockClient, zéro `fetch`
- [ ] tout mode ≠ `mock` → 503 ; aucun chemin de code vers `api.rushour.io`
- [ ] séquences de scénarios, timeout borné, Retry-After mock, secret du dispatcher

### Parcours d'intégration locale (`e2e/`, 54 assertions)

Pile : Postgres + PostgREST + vraie Edge Function (Deno, réseau limité à la
pile) + module frontend `supabaseStore.mjs`.

- [ ] accès : mauvais secret / JWT anon seul → 401
- [ ] happy path (3 produits, quantités, options) : orders=1, items OK, PENDING → Edge Function → SENT, `mock_…`, événements, pas de doublon
- [ ] idempotence checkout préservée
- [ ] double dispatch ×3 → un seul export logique
- [ ] timeout → retry (vraie attente 5 s) → SENT
- [ ] timeout_after_accept → retry même clé → SENT, doublon signalé par le mock
- [ ] HTTP 500 → retry → SENT ; HTTP 429 + Retry-After 90 s respecté → SENT
- [ ] HTTP 400 → FAILED, 1 tentative ; HTTP 401 → retry 10 min → SENT
- [ ] mapping manquant → FAILED → mapping → `rushour_requeue` → SENT
- [ ] désactivé → réactivé → réconciliation (1 puis 0) → SENT
- [ ] panne d'enqueue → réconciliation (1 puis 0) → SENT
- [ ] concurrence : 3 invocations simultanées, 12 commandes → 12 SENT, attempts = 1
- [ ] lease : worker mort → SENDING conservé → reprise après expiration → ancien worker bloqué
- [ ] RLS via PostgREST : anon (SELECT/INSERT/UPDATE/RPC refusés), admin A ≠ B, non-admin sans accès

### À exécuter sur le VRAI staging (non fait : projet inaccessible)

Même checklist, après application des migrations et déploiement de la
fonction, avec le restaurant de test staging.
