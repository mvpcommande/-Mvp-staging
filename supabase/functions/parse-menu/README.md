# Edge Function : parse-menu

Extrait les produits d'un menu (PDF ou photo) via l'API Anthropic et remplit
`menu_imports.extracted_payload` (statut `REVIEW`). L'onboarding affiche ensuite
un tableau de relecture éditable ; la validation appelle le RPC
`import_products_from_payload` (migration `20260906150000`).

## Déploiement
- `verify_jwt = false` (CORS géré + JWT validé dans la fonction via `auth.getUser`).
- Secret requis : `ANTHROPIC_API_KEY` (Dashboard → Edge Functions → Secrets).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement.

```bash
supabase functions deploy parse-menu --no-verify-jwt
```

## Sécurité
La fonction valide le JWT (auth.getUser) et vérifie que le restaurant de
l'import correspond à `app_metadata.restaurant_id` du proprio appelant.
Toute panne est journalisée dans `menu_imports.error_message`.
