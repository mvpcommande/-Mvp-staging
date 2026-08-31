# Caz Food — MVP commande directe

## Supabase
Le frontend peut utiliser Supabase avec deux variables Netlify/Vite :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Ne jamais mettre la `service_role` key dans le frontend.

Le schéma Supabase utilisé par le MVP comprend : `products`, `orders`, `order_items`, `order_events`, avec RLS et Realtime sur `orders`.

## Local

```bash
npm install
npm test
npm run build
npm run dev
```

Le mode local reste disponible si les variables Supabase sont absentes.
