# RusHour API — état de vérification (Bloc 2)

**Date de vérification : 2026-09-29**

## Verdict

**Aucun élément n'est CONFIRMED.** La documentation officielle actuelle n'a
pas pu être consultée, donc aucune valeur ci-dessous ne peut être tenue pour
la spécification en vigueur.

- `developers.rushour.io`, `postman.rushour.io` et `api.rushour.io` sont
  refusés par la politique réseau de l'environnement d'exécution (proxy,
  `connect_rejected` / `EGRESS_BLOCKED`) ;
- aucun accès développeur RusHour n'a été fourni : ni appId, ni appSecret,
  ni integrationId de test.

## Sources consultées

Deux dépôts de l'organisation GitHub officielle `rushour-io`. Ce sont des
**sources secondaires anciennes**, qui ne valent pas spécification actuelle :

| Source | Date | Contenu |
|---|---|---|
| [`rushour-io/developers-api-demo`](https://github.com/rushour-io/developers-api-demo) | 2022-08 (commit `3271e70`) | client JS de démonstration + cookbooks |
| [`rushour-io/types`](https://github.com/rushour-io/types) | 2021-11 (v2.1.0, commit `773662d`) | types TypeScript publics `Rushour.Order`, `OrderItem`, `Menu` |

Dans le tableau, la colonne « Indice secondaire » rapporte **ce que disent
ces sources**, pour guider la vérification. Ce n'est pas une confirmation.

## Les 20 points

| # | Élément | STATUS | Indice secondaire (non confirmé) |
|---|---|---|---|
| 1 | Authentification | UNKNOWN | Token d'intégration obtenu avec HTTP Basic `appId:appSecret`, corps `{"scopes":["public/oauth"]}`, réponse `{access_token, expires_in: 3600, token_type: "Bearer"}` (demo `getIntegrationToken.js`) |
| 2 | Endpoint token | UNKNOWN | `POST https://api.rushour.io/apps/{appId}/integrations/{integrationId}/token` (demo `rushourClient.js`) |
| 3 | Endpoint commande | UNKNOWN | `POST /apps/{appId}/integrations/{integrationId}/orders`, `Authorization: Bearer <token>` ; réponse de l'exemple : `{}` |
| 4 | Schéma `items[]` | UNKNOWN | `OrderItem = { id, menuItemId?, name, quantity, price, instructions, modifiers?: OrderItem[] }` (types 2.1.0) |
| 5 | Options / modifiers | UNKNOWN | `modifiers` = liste récursive d'`OrderItem` ; côté menu, `MenuModifiers` avec `id`, `externalId`, `minSelection`, `maxSelection` |
| 6 | Identifiant produit attendu | UNKNOWN | `OrderItem.id` + `menuItemId?` (optionnel) ; les éléments de menu ont `id` et `externalId` |
| 7 | Menu à synchroniser avant les commandes ? | UNKNOWN | `POST /apps/{appId}/integrations/{integrationId}/menus` existe ; `menuItemId` est optionnel |
| 8 | Type click & collect | UNKNOWN | `orderType = 'delivery' \| 'pickup' \| 'dineIn'` (types 2.1.0) |
| 9 | Unité monétaire | UNKNOWN | `total: number` ; exemple `total: 1190` pour une commande de pâtes (centimes probables, non documenté) |
| 10 | `paymentMethod` | UNKNOWN | `'cash' \| 'meal_voucher' \| 'voucher' \| 'card'` (optionnel) |
| 11 | `isPaid` | UNKNOWN | `isPaid?: boolean` ; sémantique non documentée |
| 12 | Sémantique HTTP 400/401/403/404/409/422/429/5xx | UNKNOWN | Seul indice : « l'app doit être validée, sinon 404 » (création de webhook) |
| 13 | `Retry-After` | UNKNOWN | aucun |
| 14 | Limites de débit | UNKNOWN | aucun |
| 15 | Format / longueur `externalId` | UNKNOWN | `externalId?: string` ; exemple numérique `"1242179412"` |
| 16 | **Déduplication sur `externalId`** | **UNKNOWN** | aucun |
| 17 | `integrationId` vs store / restaurant | UNKNOWN | `integrationId` fourni par l'équipe RusHour, présent dans tous les chemins ; aucun store id dans les sources |
| 18 | Statuts commande | UNKNOWN | `'new' \| 'accepted' \| 'completed' \| 'rejected' \| 'canceled' \| 'in transit'` ; actions `accept`, `complete`, `delivery` |
| 19 | Webhooks de statut | UNKNOWN | événements `IntegrationCreated`, `MenuSaved`, `OrderSaved`, `RestaurantOpened`, `RestaurantClosed` ; corps `{ event, ... }` |
| 20 | Signature / auth webhooks | UNKNOWN | aucune (l'exemple de serveur webhook ne vérifie rien) |

## Écarts entre le mapper actuel et les indices secondaires

Le mapper n'a **pas** été modifié : la règle est de ne le changer qu'après
confirmation du schéma. Les écarts suivants sont à traiter au moment de la
vérification :

| Champ | Mapper actuel | Types 2021 |
|---|---|---|
| `items[].productId` | id RusHour mappé | `id` (+ `menuItemId?`) |
| `items[].unitPrice` / `total` | centimes | `price` (unité inconnue) |
| `items[].options[{name,value}]` | texte libre | `modifiers: OrderItem[]` (identifiants) → un mapping explicite des modifiers serait nécessaire |
| `items[].instructions` | absent | requis (`string`) |
| `cutleryRequested`, `actions`, `couriers`, `fees` | absents | requis dans le type 2021 |
| `type` | `pickup` / `delivery` | `pickup` / `delivery` / `dineIn` |

## Conséquences d'implémentation (Bloc 2)

- `apiProfile.mjs` centralise toutes les valeurs dépendant de RusHour, avec
  `verified: false`. Tant que ce drapeau reste à false, `RushourHttpClient`
  refuse de s'instancier et le mode `live` répond 503.
- `dedupOnExternalId: false` : tout envoi ambigu devient **UNCERTAIN**,
  sans retry automatique.
- `refreshTokenOn401: false` : pas de renouvellement + nouvelle tentative
  sur un 401, faute de sémantique confirmée.
- 409 : comportement conservateur maintenu (NON_RETRYABLE, revue humaine).
  Un 409 n'est pas interprété comme un doublon.
- Webhooks : **non implémentés**. Sans signature documentée, aucun endpoint
  entrant ne peut être sécurisé.

## Procédure de levée des UNKNOWN

1. Obtenir un accès à `developers.rushour.io` (ou un export PDF / OpenAPI de
   la documentation) et un accès développeur RusHour.
2. Pour chaque ligne, remplir `STATUS = CONFIRMED`, l'URL de la page
   officielle, la date et un exemple réel.
3. Poser en priorité la question 16 à RusHour (déduplication sur
   `externalId`, ou existence d'un en-tête d'idempotence).
4. Mettre à jour `apiProfile.mjs` et `mapper.mjs`, avec un test par champ,
   puis passer `verified: true` dans un commit dédié et revu.
