# FOODATOI — Potentiel financier & positionnement

> Document de cadrage à usage interne / partenaire. Ce sont des **estimations de
> planification**, pas une valorisation formelle ni un conseil en investissement. Les
> multiples et chiffres de marché sont datés de 2026 et doivent être revérifiés au moment
> d'une décision (levée, cession, partenariat).

## 1. Le problème marché

Les agrégateurs (Uber Eats, Deliveroo, Just Eat) prélèvent en France, en 2026, une
commission nominale de 25–30 % HT, mais un **coût effectif de 33–36 %** du CA livraison
une fois ajoutés TVA, frais de service, litiges et promotions partagées (sources :
commandeici, fooderise, tech-food, 2026). Sur un restaurant à 600 € de livraison/jour,
cela représente ~200 €/jour — l'équivalent d'un mi-temps cuisine.

Le marché HoReCa français est estimé à plus de **200 Md€** (2024), en croissance.
Le canal de commande **directe** est unanimement présenté comme le meilleur ROI long
terme pour protéger la marge et récupérer la donnée client.

## 2. Positionnement

**Piège à éviter** : vendre « 0 % de commission ». Ce n'est plus un différenciateur —
c'est le prix d'entrée d'un marché désormais encombré : Commandeici (~29,99 €/mois),
Fooderise, Collectly (~49,99 €/mois), Zelty (~70–150 €/mois).

**Angle FOODATOI** : ne pas vendre la techno mais le **résultat chiffré** (« voici ce que
tu récupères sur ce que tu verses aux agrégateurs »), preuve à l'appui via le pilote
Caz Food, et cibler en priorité le **multi-sites** (offre Réseau), là où le revenu par
client est le plus élevé et le churn le plus faible.

## 3. Tarification

| Palier | Prix | Cible |
|---|---|---|
| Commerce | 39 €/mois | indépendant simple |
| Pro | 69 €/mois | resto avec fidélité / branding |
| Réseau | 89 €/mois **par établissement** | groupes multi-sites |

Repères concurrents : Collectly 49,99 €/mois, Zelty 70–150 €/mois. Le paiement en ligne
(SumUp, fondations posées) doit être activé rapidement : rester en « paiement sur place »
seul plafonne la proposition de valeur face aux concurrents qui encaissent.

Leviers anti-churn recommandés : engagement annuel (−2 mois), ou frais de mise en service
offerts contre 12 mois. Coûts d'infrastructure Supabase **mutualisés** (pas par
établissement) → marge brute élevée typique du SaaS.

## 4. Valorisation — méthodes et fourchettes

État actuel : **pré-revenu** (1 pilote non payant). Il n'y a donc pas encore d'ARR à
multiplier : la valeur se lit surtout en **coût de reconstruction + optionalité**.

### 4.1 Valeur d'actif (plancher)
Base de code : ~9 500 lignes JS + ~1 900 lignes SQL, multi-tenant RLS propre, fidélité,
impression thermique, onboarding, CI/CD, 74 tests, observabilité. Reconstruire
proprement au tarif dev senior FR : **~40–70 k€** de travail. C'est un plancher
« coût de remplacement » défendable.

### 4.2 Valeur de marché « en l'état »
Actif + pilote qui tourne, 0–2 clients payants : réalistement **15–40 k€** sur un flip
type place de marché de micro-SaaS (la borne haute suppose le pilote opérationnel et
1–2 clients payants).

### 4.3 Dès qu'il y a de l'ARR
Multiples micro-SaaS < 1 M$ ARR en 2026 : **2,5–4× ARR** (sources : ctacquisitions,
livmo, adastraequity, 2026). Scénarios (panier moyen ~60–65 €/mois) :

| Clients payants | ARR ≈ | Valorisation indicative |
|---|---|---|
| 10 | ~7,2 k€ | ~15–30 k€ |
| 50 | ~36 k€ | ~90–145 k€ |
| 200 (mix, part Réseau qui monte) | ~156 k€ | **~400–620 k€** |

La borne haute d'un multiple exige rétention forte (NRR), Rule of 40 et faible
concentration client.

## 5. Le vrai moteur de valeur

Le code n'est **plus** le facteur limitant — il est déjà de bon niveau. Ce qui crée la
valeur maintenant, c'est la **preuve de rétention payante**. Chaque restaurant payant
retenu ajoute ~2,5–4× son ARR annuel à la valorisation.

**Séquence recommandée** : corriger la sécurité (fait), activer SumUp, signer ~10 restos
payants et les **retenir** → passage de « bel actif à 15–40 k€ » à « entreprise à six
chiffres ». La métrique nord n'est pas le nombre d'inscrits mais
**restaurants payants actifs × rétention**.

## 6. Risques à traiter avant d'encaisser

- Alignement de l'activité déclarée de l'entité juridique avec un modèle SaaS
  (à valider avec un comptable avant encaissement en ligne).
- Anti-abus edge + en-têtes de sécurité (voir `README-DSI.md`) avant ouverture grand
  public.
- Dépendance à un marché « 0 % commission » encombré → tenir la différenciation par la
  preuve chiffrée et le multi-sites.
