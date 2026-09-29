/**
 * Données de test du connecteur RusHour. Entièrement fictives : aucun
 * identifiant réel de restaurant, de produit ou d'intégration RusHour.
 * Trois établissements pour prouver le routage multi-tenant (le code
 * ne connaît aucun nombre d'établissements).
 */

export const RESTAURANT_A = '0a000000-0000-4000-8000-00000000000a';
export const RESTAURANT_B = '0b000000-0000-4000-8000-00000000000b';
export const RESTAURANT_C = '0c000000-0000-4000-8000-00000000000c';

export const PRODUCTS = Object.freeze({
  A_KEBAB: 'a1000000-0000-4000-8000-000000000001',
  A_TACOS: 'a1000000-0000-4000-8000-000000000002',
  A_DRINK: 'a1000000-0000-4000-8000-000000000003',
  B_PIZZA: 'b1000000-0000-4000-8000-000000000001',
  C_BURGER: 'c1000000-0000-4000-8000-000000000001'
});

export const connectionRow = (restaurantId, integrationId, extra = {}) => ({
  restaurant_id: restaurantId,
  rushour_integration_id: integrationId,
  rushour_store_id: null,
  enabled: true,
  ...extra
});

export const CONNECTIONS = Object.freeze({
  A: connectionRow(RESTAURANT_A, 'test-integration-a'),
  B: connectionRow(RESTAURANT_B, 'test-integration-b', { rushour_store_id: 'test-store-b' }),
  C: connectionRow(RESTAURANT_C, 'test-integration-c')
});

export const mappingRow = (restaurantId, productId, rushourProductId) => ({
  restaurant_id: restaurantId,
  product_id: productId,
  rushour_product_id: rushourProductId
});

export const PRODUCT_MAPPINGS = Object.freeze([
  mappingRow(RESTAURANT_A, PRODUCTS.A_KEBAB, 'rh-a-kebab'),
  mappingRow(RESTAURANT_A, PRODUCTS.A_TACOS, 'rh-a-tacos'),
  mappingRow(RESTAURANT_A, PRODUCTS.A_DRINK, 'rh-a-drink'),
  mappingRow(RESTAURANT_B, PRODUCTS.B_PIZZA, 'rh-b-pizza'),
  mappingRow(RESTAURANT_C, PRODUCTS.C_BURGER, 'rh-c-burger')
]);

export const itemRow = (orderId, productId, name, quantity, unitPriceCents, options = {}) => ({
  order_id: orderId,
  product_id: productId,
  product_name: name,
  quantity,
  unit_price_cents: unitPriceCents,
  line_total_cents: unitPriceCents * quantity,
  options
});

let orderSeq = 0;

/** Ligne `orders` telle que produite par create_order(). */
export function orderRow({ id, restaurantId = RESTAURANT_A, items, ...extra }) {
  orderSeq += 1;
  const orderId = id ?? `d0000000-0000-4000-8000-${String(orderSeq).padStart(12, '0')}`;
  const total = items.reduce((acc, i) => acc + i.line_total_cents, 0);
  return {
    order: {
      id: orderId,
      restaurant_id: restaurantId,
      order_number: `FA-260928-${String(orderSeq).padStart(6, '0')}`,
      status: 'NEW',
      payment_status: 'PAY_AT_STORE',
      fulfillment_type: 'PICKUP',
      pickup_time: '2026-09-28T12:30:00.000Z',
      created_at: '2026-09-28T12:05:00.000Z',
      customer_name: 'Client Test',
      customer_phone: '0600000000',
      notes: null,
      total_cents: total,
      delivery_address: null,
      ...extra
    },
    items: items.map(i => ({ ...i, order_id: orderId }))
  };
}

/** Commande simple du restaurant A : 2 kebabs (options) + 1 boisson. */
export function simpleOrderA(extra = {}) {
  return orderRow({
    restaurantId: RESTAURANT_A,
    items: [
      itemRow(null, PRODUCTS.A_KEBAB, 'Kebab', 2, 850, { meat: 'Poulet', sauce: 'Blanche' }),
      itemRow(null, PRODUCTS.A_DRINK, 'Coca 33cl', 1, 200)
    ],
    ...extra
  });
}

// Valeurs "secrètes" factices, utilisées UNIQUEMENT pour prouver qu'elles
// ne fuient jamais dans un log ou un payload.
export const FAKE_SECRETS = Object.freeze({
  appSecret: 'fake-app-secret-DO-NOT-LEAK-7f3a9c',
  accessToken: 'fake-access-token-DO-NOT-LEAK-91bd2e'
});
