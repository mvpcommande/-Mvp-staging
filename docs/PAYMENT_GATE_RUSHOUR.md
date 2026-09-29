# Payment gate avant export RusHour

> Règle client : **une commande ne part en cuisine (RusHour) que si le
> paiement est confirmé**, pour les établissements qui l'exigent.
> Ce document est l'entrée du Bloc 3 (PSP). Le Bloc 2 n'intègre **aucun**
> PSP (ni SumUp, ni Stripe) : il pose et teste l'invariant.

## Invariant (implémenté au Bloc 2)

```
PAYMENT REQUIRED (restaurant_rushour_connections.payment_required = true)
        ↓
create_order(p_payment_method => 'ONLINE')  →  payment_status = 'PENDING'
        ↓
outbox PENDING, mais rushour_claim_outbox() NE LA RÉCLAME PAS
(aucune tentative consommée, aucun appel RusHour)
        ↓
[Bloc 3] WEBHOOK PSP CONFIRMÉ (signature vérifiée)
        ↓
payment_status = 'PAID'
        ↓
RUSHOUR ELIGIBLE → dispatcher → RusHour
```

## Règle d'éligibilité (liste blanche, fail closed)

Elle est appliquée à deux niveaux :
- en base, par `rushour_claim_outbox()` (migration `20260930090000`) ;
- dans le dispatcher, par `isPaymentEligible()`, en défense en profondeur.

| `payment_status` | `payment_required = false` (défaut, historique) | `payment_required = true` |
|---|---|---|
| `PAID` | exporté | exporté |
| `PAY_AT_STORE` | exporté | **bloqué** |
| `PENDING` | **bloqué** | **bloqué** |
| toute autre valeur (`FAILED`, `REFUNDED`, inconnue…) | **bloqué** | **bloqué** |

- **Configurable par restaurant** : `payment_required` est une colonne de
  `restaurant_rushour_connections`, à `false` par défaut. Le comportement
  historique des restaurants payés au comptoir est donc inchangé. Imposer
  le paiement en ligne à tous exige une décision produit explicite.
- Une commande bloquée reste `PENDING` dans l'outbox **sans consommer de
  tentative**. Elle part dès que son paiement passe `PAID`, au plus tard à
  la prochaine exécution du dispatcher.
- La réconciliation (`rushour_reconcile`) crée des entrées outbox sans
  préjuger du paiement : c'est le claim qui filtre.

Ces règles sont prouvées par des tests à trois niveaux :
- tests SQL `supabase/tests/rushour/10_rushour_tests.sql` §9 ;
- tests unitaires `dispatcher.test.mjs` (« payment gate ») ;
- test du mapper (PENDING refusé).

## À faire au Bloc 3 (PSP)

1. Webhook PSP : Edge Function dédiée, avec signature vérifiée, protection
   anti-rejeu (horodatage + identifiant d'événement unique) et idempotence.
2. Transition `payment_status` : `PENDING → PAID` (ou `FAILED`), réalisée
   **uniquement** par cette fonction serveur, jamais par le navigateur.
3. Montant : vérifier que le montant payé correspond à `orders.total_cents`
   (calculé serveur), sinon refuser le passage à `PAID`.
4. Délai : définir le sort d'une commande `PENDING` jamais payée
   (expiration, annulation). Elle ne doit jamais être exportée.
5. Activer `payment_required = true` restaurant par restaurant, après
   validation.

## Ce que le Bloc 2 ne fait pas

- Pas de PSP, pas de webhook de paiement, pas de changement de checkout.
- Aucun passage automatique à `PAID`. Aujourd'hui, aucun flux Foodatoi ne
  produit `PAID` : le paiement en ligne n'est pas finalisé.
