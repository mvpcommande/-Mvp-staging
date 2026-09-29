# Edge Function : rushour-dispatch-order

Worker de l'outbox RusHour (`rushour_order_outbox`). Mode par défaut :
**mock**. Mode `live` (Bloc 2) verrouillé : il exige le projet staging, un
profil d'API RusHour **vérifié** (ce n'est pas le cas), les secrets
`RUSHOUR_APP_ID` / `RUSHOUR_APP_SECRET` et une destination
`target_environment = 'test'`. Sinon 503, sans aucun appel réseau. Voir
`docs/RUSHOUR_API_VERIFIED.md`.

Toute la logique vit dans `../_shared/rushour/` (ESM pur, testé par
`npm test`) ; ce fichier n'est qu'un adaptateur HTTP → `runDispatchBatch`.

## Pré-requis
Migrations `20260928090000_rushour_connector_foundation.sql` puis
`20260929090000_rushour_reconciliation_and_fixes.sql` appliquées sur le
projet **staging** (jamais la prod dans ce bloc).

## Secrets (Dashboard → Edge Functions → Secrets)
| Nom | Valeur | Requis |
|---|---|---|
| `RUSHOUR_DISPATCH_SECRET` | aléatoire, ≥ 32 caractères (`openssl rand -hex 32`) | oui |
| `RUSHOUR_MODE` | `mock` (défaut) \| `live` (verrouillé) | non |
| `RUSHOUR_APP_ID` / `RUSHOUR_APP_SECRET` | credentials RusHour (live uniquement, jamais `VITE_`) | live |
| `RUSHOUR_MOCK_SCENARIO` | `success`, `http_500`, `timeout`… ou séquence `timeout,success` | non (défaut `success`) |
| `RUSHOUR_MOCK_RETRY_AFTER_SECONDS` | `0..3600` (Retry-After du mock 429) | non |
| `RUSHOUR_SEND_TIMEOUT_MS` | `500..15000` | non (défaut `10000`) |

En mode `mock`, `RUSHOUR_APP_ID` / `RUSHOUR_APP_SECRET` ne sont **pas lus** :
même définis par erreur, aucun appel réseau n'a lieu.

Aucun de ces noms n'est préfixé `VITE_` : ils n'existent que côté serveur.

## Déploiement (staging)
```bash
supabase link --project-ref kkhlpeqherxfdnilewkp   # staging, vérifier avant !
supabase functions deploy rushour-dispatch-order --no-verify-jwt
```
`--no-verify-jwt` : l'accès n'est PAS basé sur un JWT utilisateur (une clé
anon suffirait à en produire un) mais sur `x-rushour-dispatch-secret`,
comparé à temps constant ; sans secret configuré la fonction répond 503.

## Appel manuel
```bash
curl -X POST "https://kkhlpeqherxfdnilewkp.supabase.co/functions/v1/rushour-dispatch-order" \
  -H "x-rushour-dispatch-secret: $RUSHOUR_DISPATCH_SECRET" \
  -H "Content-Type: application/json" -d '{"limit": 10}'
# -> {"mode":"mock","claimed":1,"sent":1,"retryScheduled":0,"failed":0,...}
```

Ordonnancement (pg_cron + pg_net) : voir `docs/RUSHOUR_CONNECTOR.md`.
