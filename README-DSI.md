# FOODATOI — Dossier technique DSI

Document destiné à une direction des systèmes d'information (audit, partenariat,
reprise, ou intégration). Il décrit l'architecture, le modèle de sécurité, la
conformité RGPD, et surtout **les procédures de diagnostic** : la consigne produit est
qu'*aucune erreur silencieuse ne reste non répertoriée*.

Aucun secret n'est présent dans ce document. Les identifiants de projet Supabase et la
clé publique (anon) sont déjà visibles dans le bundle déployé ; la clé `service_role` et
les jetons d'accès ne sont jamais versionnés ni exposés au front.

---

## 1. Architecture

```
Navigateur (client / restaurateur)
      │  HTTPS
      ▼
GitHub Pages  ──  app statique Vite (www.foodatoi.fr)
      │  supabase-js (REST + Realtime WSS)
      ▼
Supabase (PostgreSQL managé, région EU eu-west-1)
   ├─ RLS sur toutes les tables sensibles
   ├─ Fonctions RPC SECURITY DEFINER (logique métier + sécurité)
   ├─ Realtime (comptoir temps réel)
   ├─ Storage (photos produits, logos)
   └─ Auth (restaurateurs + clients)
```

Il n'existe **pas de serveur applicatif intermédiaire** : la surface d'attaque serveur
se réduit à PostgreSQL/Supabase et à ses règles RLS. C'est un choix assumé (un seul
endroit à sécuriser, coûts mutualisés). Les backends `oracle-*` (Railway/Render) que l'on
peut croiser appartiennent à un **autre** projet (ORAKL) et ne font pas partie de FOODATOI.

## 2. Environnements & dépôts

| | Production | Staging |
|---|---|---|
| Dépôt | `mvpcommande/Mvp-` | `mvpcommande/-Mvp-staging` |
| Supabase | `ffuykessameuonpnyiyc` (eu-west-1) | `kkhlpeqherxfdnilewkp` |
| Domaine | `www.foodatoi.fr` | (Netlify de test) |
| Déploiement | GitHub Actions → gh-pages | idem, base isolée |

CI (`.github/workflows/ci.yml`) : `npm ci` → `npm test` → `npm run build` → publication.
Les tests conditionnent le déploiement. Health-check (`health-check.yml`) toutes les 2 h.

## 3. Modèle de sécurité

### 3.1 Isolation multi-tenant
Chaque table sensible porte un `restaurant_id` et une politique RLS. L'identité du tenant
et le rôle proviennent de `auth.jwt() -> 'app_metadata'` (`restaurant_id`, `role`), champ
**écrit uniquement côté serveur** (via `provision_restaurant`, `SECURITY DEFINER`,
réservée au `service_role`). Un client authentifié **ne peut pas** modifier son
`restaurant_id` ni son rôle : c'est le socle de l'étanchéité entre restaurants.

Helpers : `current_restaurant_id()`, `is_restaurant_admin()`, `is_restaurant_member()`.

### 3.2 Intégrité des commandes & paiement
`create_order` (RPC) :
- **prix lus en base**, jamais fournis par le client → pas de falsification de total ;
- validations avant tout write : restaurant actif, panier non vide, produit du bon tenant,
  **quantité bornée 1–99** (évite l'overflow `integer` du total), `pickup_time` obligatoire
  et borné (pas dans le passé, ≤ 60 jours), **horaires d'ouverture vérifiés contre l'heure
  de retrait** ;
- **idempotency key** (anti double-commande) ;
- **rate-limit** par téléphone (5 commandes / 10 min) ;
- statut de paiement `PENDING` pour SumUp / `PAY_AT_STORE` sinon.

> Limite connue : le rate-limit par téléphone est contournable (le téléphone vient du
> client). L'anti-abus « dur » doit être posé au niveau edge (Supabase Edge Function /
> WAF / Cloudflare). À prévoir avant montée en charge grand public.

### 3.3 Fidélité
`redeem_loyalty_reward` : rachat **atomique** (`FOR UPDATE`), exige un utilisateur
authentifié, vérifie le solde, écrit au grand livre (`loyalty_ledger`) et met à jour le
compte dans la même transaction. Mutation directe du grand livre interdite
(`prevent_loyalty_ledger_mutation`, `EXECUTE` révoqué pour anon/authenticated).

### 3.4 Front
- Échappement HTML systématique (`escapeHtml`) sur toute donnée affichée, y compris les
  champs contrôlés par le client (nom, téléphone, options de commande) côté comptoir.
- **Content-Security-Policy** stricte (`script-src 'self'`) sur toutes les pages ; aucun
  script inline dans le build ; `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`.
- Clé publique anon uniquement ; `service_role` absente du front.

> Limite connue : GitHub Pages ne pose pas d'en-têtes HTTP → la CSP est en balise
> `<meta>` (couvre `script-src`, pas `frame-ancestors`). Pour un durcissement complet
> (anti-clickjacking, HSTS), placer le front derrière Cloudflare/Netlify avec de vrais
> en-têtes.

### 3.5 Fonctions à privilèges
`provision_restaurant`, `onboard_restaurant` : `EXECUTE` **révoqué** pour anon et
authenticated (déclenchables seulement via `service_role`, donc onboarding maîtrisé).

## 4. RGPD & données personnelles

- Hébergement **UE** (Supabase eu-west-1).
- Données personnelles : `customers` (nom, téléphone, e-mail), `orders`
  (nom/téléphone de retrait), consentements marketing horodatés (`marketing_consents`)
  avec **historique** (`marketing_consent_events`).
- Suppression RGPD gérée pour le périmètre fidélité ; page légale (`legal.html`) et
  contact CNIL fournis.
- Lecture des données d'un tenant strictement limitée à son staff par RLS ; un client ne
  voit que ses propres commandes.

## 5. Observabilité — « aucune erreur silencieuse »

### 5.1 Principe
Deux niveaux, tous deux écrivant dans la table `client_error_logs` :

1. **Log explicite** : `logClientError(client, { restaurantId, context, message, details, page })`.
2. **Filet global** : `installGlobalErrorLogging()` (appelé au démarrage de chaque page)
   capture :
   - `window.onerror` (exceptions non gérées),
   - `unhandledrejection` (promesses rejetées),
   - **toute** sortie `console.error` / `console.warn` (interception),
   avec garde anti-récursion et déduplication anti-flood (10 s).

Résultat : les ~30 points de `console.error` existants — plus tout futur — sont
catalogués **sans** réécriture, avec `page`, `restaurant_id`, message et `stack`.

### 5.2 Schéma de la table
`client_error_logs (id, restaurant_id, context, message, details jsonb, page, user_agent, created_at)`.
RLS : insertion ouverte (anon inclus, pour tracer même avant résolution du tenant) ;
**lecture réservée** au staff du tenant concerné (+ erreurs sans `restaurant_id`).

### 5.3 Procédure de diagnostic (DSI)
Depuis le SQL editor Supabase (accès staff/service) :

```sql
-- Dernières erreurs, tous tenants
select created_at, page, context, message, restaurant_id
from public.client_error_logs
order by created_at desc
limit 100;

-- Erreurs d'un restaurant précis sur 24 h
select created_at, page, context, message, details
from public.client_error_logs
where restaurant_id = '<uuid>'
  and created_at > now() - interval '24 hours'
order by created_at desc;

-- Top des contextes en erreur (7 jours) : où ça casse le plus
select context, count(*) as n
from public.client_error_logs
where created_at > now() - interval '7 days'
group by context order by n desc;
```

Contextes notables : `window.onerror`, `unhandledrejection`, `console.error`,
`console.warn`, plus les contextes métier explicites (résolution restaurant, création de
commande, fidélité, impression, etc.).

### 5.4 Supervision
- Health-check GitHub Actions toutes les 2 h ; GitHub notifie par e-mail en cas d'échec
  d'un job programmé.
- Recommandations DSI : alerting sur un seuil de volume dans `client_error_logs`
  (ex. > N erreurs/heure), et rétention/purge planifiée de la table.

## 6. Points de vigilance (backlog durcissement)

1. Anti-abus edge (rate-limit réel) devant `create_order` avant ouverture grand public.
2. En-têtes HTTP de sécurité (CSP complète, HSTS, anti-clickjacking) via un CDN devant
   GitHub Pages.
3. Purge/rétention `client_error_logs` + alerting.
4. Vérification de l'alignement de l'activité déclarée de l'entité juridique avec un
   modèle SaaS (à valider avec un comptable avant encaissement en ligne).
5. Rotation documentée des clés / jetons (le jeton de déploiement ne doit vivre que dans
   les secrets GitHub Actions).
