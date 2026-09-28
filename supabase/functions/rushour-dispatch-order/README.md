# Edge Function : rushour-dispatch-order

Worker de l'outbox RusHour (`rushour_order_outbox`). **Mode mock uniquement**
dans ce bloc : aucune requête n'atteint l'API RusHour réelle.

Toute la logique vit dans `../_shared/rushour/` (ESM pur, testé par
`npm test`) ; ce fichier n'est qu'un adaptateur HTTP → `runDispatchBatch`.

## Pré-requis
Migration `20260928090000_rushour_connector_foundation.sql` appliquée sur le
projet **staging** (jamais la prod dans ce bloc).

## Secrets (Dashboard → Edge Functions → Secrets)
| Nom | Valeur | Requis |
|---|---|---|
| `RUSHOUR_DISPATCH_SECRET` | aléatoire, ≥ 32 caractères (`openssl rand -hex 32`) | oui |
| `RUSHOUR_MODE` | `mock` | non (défaut `mock`) |
| `RUSHOUR_MOCK_SCENARIO` | `success`, `http_500`, `timeout`… | non (défaut `success`) |

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
