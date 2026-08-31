# Ajouter un nouveau restaurant à FOODATOI

Ce document couvre ce qui reste manuel après `provision_restaurant()`.
La fonction gère la partie qui, si elle est oubliée, casse tout
silencieusement (le lien entre le compte du propriétaire et l'accès
RLS) ; le reste (menu, photos, horaires) est spécifique à chaque
restaurant et ne peut pas être généralisé dans une fonction SQL.

Réservé à un rôle privilégié (SQL editor Supabase, ou un outil interne
plus tard) — jamais exposé au public, exécuté pour le compte du
restaurant, pas par le restaurant lui-même.

## 0. Prérequis : le compte du propriétaire doit déjà exister

`provision_restaurant()` cherche un compte Supabase Auth existant par
email. S'il n'existe pas encore, le créer d'abord :
**Authentication > Users > Add user** dans le dashboard Supabase (ou
`supabase.auth.signUp()` côté client). `provision_restaurant()`
échoue avec un message clair si l'email ne correspond à aucun compte.

## 1. Créer le restaurant + l'accès propriétaire

```sql
select * from public.provision_restaurant(
  p_name           => 'Nom du restaurant',
  p_slug           => 'nom-du-restaurant',       -- minuscules, tirets
  p_sector         => 'pizza',                    -- pizza|kebab|burger|restaurant|snack|boulangerie|sushi|other
  p_owner_email    => 'proprietaire@example.com',
  p_domain         => 'nom-du-restaurant.foodatoi.fr',  -- optionnel
  p_phone          => '0600000000',
  p_address_street => '1 rue Exemple',
  p_address_postal_code => '31000',
  p_address_city   => 'Toulouse'
);
```

Ceci crée : le restaurant (`onboarding_status = 'DRAFT'`), la ligne
`restaurant_members` (owner), un programme de fidélité désactivé par
défaut, l'entrée `restaurant_domains` si un domaine est fourni, **et**
règle `app_metadata.role`/`restaurant_id` sur le compte du
propriétaire — c'est cette dernière partie qui, oubliée, avait cassé
l'admin de Caz Food ce soir. Le propriétaire doit se déconnecter/
reconnecter pour qu'un nouveau JWT reflète ces claims.

## 2. Horaires, livraison, réseaux sociaux

Tout passe par `settings` (jsonb), même format que Caz Food :

```sql
update public.restaurants
set settings = settings || jsonb_build_object(
  'opening_hours', jsonb_build_object(
    'mon', jsonb_build_array(jsonb_build_array('11:30','14:00'), jsonb_build_array('18:30','22:00'))
    -- ... un jour par clé : sun, mon, tue, wed, thu, fri, sat
    -- jour absent ou tableau vide = fermé ce jour-là
  ),
  'delivery_redirect_url', 'https://...',  -- optionnel, si le resto garde un partenaire livraison
  'facebook_url', 'https://...'            -- optionnel
)
where slug = 'nom-du-restaurant';
```

Aucune de ces clés n'est obligatoire : absente, la fonctionnalité
correspondante ne s'affiche simplement pas (pas d'horaires = pas de
restriction, pas de lien livraison = pas de bandeau, etc.).

## 3. Menu

Pas de fonction générique possible ici, chaque menu est différent.
Format à respecter (voir `main.js`, constantes `MEATS`/`SAUCES`/`DRINKS`
pour les valeurs déjà supportées par les sélecteurs) :

```sql
insert into public.products (restaurant_id, name, category, description, price_cents, is_active, sort_order, options) values
(
  (select id from public.restaurants where slug = 'nom-du-restaurant'),
  'Nom du produit', 'Catégorie', 'Description.', 1290, true, 0,
  '{"meat": true, "sauce": true, "drink": true, "emoji": "🌮"}'::jsonb
  -- flags disponibles : meat, sauce, drink (booléens),
  -- multipleMeat / tripleMeat (pour 2/3 viandes), emoji (icône de repli)
);
```

## 4. Photos produits

Pas de bucket Supabase Storage utilisé (volontairement, pour rester
simple) : les fichiers vivent dans `public/product-images/` du repo,
`product_images.public_url` stocke juste le chemin relatif
(`product-images/xxx.jpg`, sans `/` initial — c'est
`import.meta.env.BASE_URL` côté client qui le complète, donc ça reste
portable entre Netlify et GitHub Pages sans donnée différente par
déploiement).

```sql
insert into public.product_images (restaurant_id, product_id, storage_path, public_url, alt_text, sort_order, is_primary)
values (
  '<restaurant_id>', '<product_id>',
  'repo:public/product-images/nom-fichier.jpg',
  'product-images/nom-fichier.jpg',
  'Description courte', 0, true
);
```

Puis commit + push le fichier image + rebuild/redeploy (voir le
processus habituel : `npm run build` pour Netlify,
`vite build --base=/Mvp-/` pour GitHub Pages tant qu'on y est).

## 5. Vérifier

- Le propriétaire se déconnecte/reconnecte sur `/admin.html`, doit
  voir 0 commande sans erreur (pas d'écran cassé).
- Une commande de test passe côté client, apparaît en direct côté
  admin sans recharger.
- `onboarding_status` reste `'DRAFT'` tant que tout n'est pas vérifié ;
  passer à `'READY'` manuellement une fois satisfait
  (`update restaurants set onboarding_status = 'READY' where slug = '...'`).

## Ce qui n'est toujours pas généralisable sans plus de travail

- Le menu et les photos restent manuels par nature (contenu propre à
  chaque restaurant), mais **le code, lui, n'a besoin d'aucune
  modification par nouveau restaurant** — `resolve_restaurant()` et
  toute la RLS sont déjà génériques, un nouveau tenant fonctionne dès
  que ses données existent.
- Le schéma et les policies RLS ne sont toujours versionnés nulle
  part dans ce repo (appliqués directement en base au fil de l'eau) —
  séparé de ce ticket, mais ça vaudra le coup avant d'onboarder
  beaucoup plus de restaurants.
