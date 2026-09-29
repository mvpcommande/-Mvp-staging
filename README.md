# FOODATOI — commande directe pour restaurants indépendants

Plateforme SaaS multi-tenant (marque blanche) de **commande en ligne click-and-collect
et livraison interne**, sans commission par commande. Chaque restaurant dispose de sa
page de commande, de son comptoir (back-office temps réel), de son programme de fidélité
et de son impression de tickets thermiques.

- **Front** : application statique Vite (vanilla JS), déployée sur GitHub Pages
  (domaine `www.foodatoi.fr`).
- **Back** : Supabase (PostgreSQL + RLS + fonctions RPC + Realtime + Storage + Auth).
  Il n'y a **pas** de serveur applicatif maison : toute la logique métier et la sécurité
  vivent dans la base.
- **Pilote** : Caz Food (`caz-food`).

> Deux documents complémentaires :
> - [`README-DSI.md`](./README-DSI.md) — architecture, modèle de sécurité, RGPD,
>   observabilité et procédures de diagnostic (destiné à une DSI / audit technique).
> - [`README-POTENTIEL-FINANCIER.md`](./README-POTENTIEL-FINANCIER.md) — marché,
>   positionnement, tarification et fourchettes de valorisation.

## Stack

| Couche | Techno |
|---|---|
| Build / dev | Vite 8.2.2 |
| Client base de données | @supabase/supabase-js 2.57.0 |
| Impression thermique | @point-of-sale/receipt-printer-encoder + webusb (Chrome/Edge) |
| Tests unitaires | `node --test` (74 tests) |
| Tests E2E | Playwright |
| CI/CD | GitHub Actions → déploiement gh-pages |

Les versions sont **épinglées** (pas de `latest`) pour des builds reproductibles ;
`npm ci` en CI ; mises à jour pilotées par Dependabot.

## Variables d'environnement

Deux variables (Netlify/Vite), injectées au build :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` — clé **publique** (anon/publishable). Elle est
  visible dans le bundle : ce n'est pas un secret, elle ne donne accès qu'à ce que la
  RLS autorise déjà publiquement.

**Ne jamais** mettre la clé `service_role` dans le front. Le mode local (sans variables
Supabase) reste fonctionnel pour le développement.

## Développement local

```bash
npm ci          # installation reproductible
npm test        # 74 tests unitaires
npm run build   # build de production
npm run dev     # serveur de dev
npm run test:e2e  # parcours de commande Playwright
```

## Modèle de données (Supabase)

Tenants et catalogue : `restaurants`, `products`, `product_images`, `restaurant_domains`,
`restaurant_members`, `menu_imports`, `sector_templates`.
Commandes : `orders`, `order_items`, `order_events`.
Clients & fidélité : `customers`, `loyalty_programs`, `loyalty_accounts`,
`loyalty_ledger`, `loyalty_rewards`.
Consentements RGPD : `marketing_consents`, `marketing_consent_events`.
Exploitation : `client_error_logs`.

Fonctions RPC clés (toutes en `SECURITY DEFINER`, `search_path` verrouillé) :
`resolve_restaurant`, `create_order` (prix calculés côté serveur), `redeem_loyalty_reward`
(rachat atomique), `provision_restaurant` / `onboard_restaurant` (réservées au
`service_role`).

## Sécurité (résumé)

- Isolation multi-tenant par **RLS** sur toutes les tables sensibles ; identité du tenant
  dérivée de `auth.jwt() -> app_metadata` (**non falsifiable** par le client).
- Prix **calculés côté serveur** dans `create_order` (jamais fournis par le client).
- Bornes anti-abus sur l'endpoint public : quantité 1–99, `pickup_time` validé, horaires
  d'ouverture contrôlés, rate-limit, idempotency key.
- Échappement HTML systématique + **Content-Security-Policy** stricte sur toutes les pages.
- Détail complet dans [`README-DSI.md`](./README-DSI.md).

## Observabilité — aucune erreur silencieuse

Toute erreur côté client est **répertoriée** dans `client_error_logs` :
exceptions non gérées (`window.onerror`), promesses rejetées (`unhandledrejection`) et
tout `console.error`/`console.warn` sont interceptés par `installGlobalErrorLogging()`
(`errorLog.mjs`) et écrits en base, avec le contexte (page, restaurant, stack).
Consultable par le staff du restaurant et, en cas de partenariat, par une DSI —
voir la procédure de diagnostic dans [`README-DSI.md`](./README-DSI.md).

## Déploiement

Push sur `main` → GitHub Actions : tests + build, puis publication sur la branche
`gh-pages` (servie sur `www.foodatoi.fr`). Un health-check tourne toutes les 2 h
(page client, comptoir, résolution du tenant, catalogue non vide).
Environnement de test isolé : `mvpcommande/-Mvp-staging` + base Supabase séparée.
