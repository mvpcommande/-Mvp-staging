# Plan de test — Connecteur RusHour (Bloc 1)

## Commandes

```bash
npm ci
npm test                    # historiques (87) + RusHour (68), node --test
npm run build               # puis relancer npm test : contrôle du bundle dist/
RUSHOUR_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
  npm run test:db:rushour   # Postgres LOCAL jetable (refuse toute URL distante)
npm run test:e2e            # parcours réel sur le site staging (réseau requis)
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
