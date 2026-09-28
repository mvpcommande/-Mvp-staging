import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFoodatoiOrder, normalizeOptions } from './types.mjs';
import { resolveRushourDestination } from './config.mjs';
import { computeExportKey } from './idempotency.mjs';
import { foodatoiOrderToRushour, RUSHOUR_PAYLOAD_SCHEMA } from './mapper.mjs';
import { ErrorCategory, RushourError } from './errors.mjs';
import {
  RESTAURANT_A, RESTAURANT_B, RESTAURANT_C, PRODUCTS, CONNECTIONS, PRODUCT_MAPPINGS,
  orderRow, itemRow, simpleOrderA, mappingRow
} from './fixtures.mjs';

// Comme le repository : seuls les mappings du restaurant de la commande
// sont chargés. Une liste mélangée est un bug amont, refusé (test J).
const tenantMappings = restaurantId => PRODUCT_MAPPINGS.filter(m => m.restaurant_id === restaurantId);

async function mapFixture({ order, items }, connection = CONNECTIONS.A, mappings = tenantMappings(order.restaurant_id)) {
  const normalized = normalizeFoodatoiOrder(order, items);
  const destination = resolveRushourDestination(connection, order.restaurant_id);
  const exportKey = await computeExportKey({ orderId: order.id, integrationId: destination.integrationId });
  return foodatoiOrderToRushour({ order: normalized, destination, productMappings: mappings, exportKey });
}

function assertRushourError(fn, category, code) {
  return assert.rejects(fn, err => {
    assert.ok(err instanceof RushourError, `RushourError attendue, reçu ${err}`);
    assert.equal(err.category, category);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

// A. mapping simple valide
test('A. mapping simple valide : payload RusHour complet et cohérent', async () => {
  const fixture = orderRow({
    restaurantId: RESTAURANT_A,
    items: [itemRow(null, PRODUCTS.A_TACOS, 'Tacos', 1, 900)]
  });
  const payload = await mapFixture(fixture);

  assert.equal(payload.displayId, fixture.order.order_number);
  assert.equal(payload.status, 'new');
  assert.equal(payload.type, 'pickup');
  assert.equal(payload.total, 900);
  assert.equal(payload.isPaid, false);
  assert.equal(payload.prepareBy, '2026-09-28T12:30:00.000Z');
  assert.equal(payload.orderedAt, '2026-09-28T12:05:00.000Z');
  assert.deepEqual(payload.customer, { name: 'Client Test', phone: '0600000000' });
  assert.deepEqual(payload.items, [
    { productId: 'rh-a-tacos', name: 'Tacos', quantity: 1, unitPrice: 900, total: 900, options: [] }
  ]);
  assert.match(payload.id, /^fdt1_[0-9a-f]{32}$/);
  assert.equal(payload.externalId, payload.id);
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.items[0]), 'payload immuable');
});

test('A. mapper pur : mêmes entrées -> même sortie, quel que soit l’ordre des lignes en base', async () => {
  const fixture = simpleOrderA();
  const first = await mapFixture(fixture);
  const reversed = await mapFixture({ order: fixture.order, items: [...fixture.items].reverse() });
  assert.deepEqual(first, reversed);
  assert.deepEqual(await mapFixture(fixture), first);
});

// B. multi-items
test('B. multi-items : chaque ligne mappée vers son produit RusHour', async () => {
  const fixture = orderRow({
    restaurantId: RESTAURANT_A,
    items: [
      itemRow(null, PRODUCTS.A_KEBAB, 'Kebab', 2, 850),
      itemRow(null, PRODUCTS.A_TACOS, 'Tacos', 1, 900),
      itemRow(null, PRODUCTS.A_DRINK, 'Coca 33cl', 3, 200)
    ]
  });
  const payload = await mapFixture(fixture);
  assert.equal(payload.items.length, 3);
  assert.deepEqual(payload.items.map(i => [i.productId, i.quantity, i.total]).sort(), [
    ['rh-a-drink', 3, 600], ['rh-a-kebab', 2, 1700], ['rh-a-tacos', 1, 900]
  ]);
});

// C. options produit
test('C. options produit : groupes et choix simples aplatis de façon déterministe', async () => {
  const fixture = orderRow({
    restaurantId: RESTAURANT_A,
    items: [itemRow(null, PRODUCTS.A_KEBAB, 'Kebab', 1, 850, {
      meat: 'Poulet', meat2: 'Kefta', meats: ['Poulet', 'Kefta'], sauce: 'Blanche', popular: true,
      groups: [{ label: 'Pain', choice: 'Galette' }, { label: 'Cuisson', choice: 'Bien cuit' }]
    })]
  });
  const payload = await mapFixture(fixture);
  assert.deepEqual(payload.items[0].options, [
    { name: 'Pain', value: 'Galette' },
    { name: 'Cuisson', value: 'Bien cuit' },
    { name: 'meat', value: 'Poulet' },
    { name: 'meat2', value: 'Kefta' },
    { name: 'sauce', value: 'Blanche' }
  ]);
});

test('C. options mal formées : VALIDATION_ERROR (fail closed)', () => {
  assert.throws(() => normalizeOptions({ groups: 'Pain' }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => normalizeOptions({ groups: [{ label: 'Pain' }] }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => normalizeOptions(['x']), { code: 'INVALID_OPTIONS' });
  assert.deepEqual(normalizeOptions(null), []);
});

// D. total en centimes
test('D. total en centimes : entier, somme exacte des lignes', async () => {
  const payload = await mapFixture(simpleOrderA());
  assert.equal(payload.total, 2 * 850 + 200);
  assert.ok(Number.isInteger(payload.total));
  assert.equal(payload.items.reduce((acc, i) => acc + i.total, 0), payload.total);
});

test('D. incohérences de montant refusées (jamais recalculées côté connecteur)', () => {
  const { order, items } = simpleOrderA();
  assert.throws(() => normalizeFoodatoiOrder({ ...order, total_cents: order.total_cents + 1 }, items),
    { code: 'ORDER_TOTAL_MISMATCH' });
  assert.throws(() => normalizeFoodatoiOrder(order, [{ ...items[0], line_total_cents: 1 }, items[1]]),
    { code: 'LINE_TOTAL_MISMATCH' });
  assert.throws(() => normalizeFoodatoiOrder(order, [{ ...items[0], unit_price_cents: 8.5 }, items[1]]),
    { code: 'INVALID_AMOUNT' });
});

// E / F. multi-établissements
test('E. restaurant A -> intégration A', async () => {
  const fixture = simpleOrderA();
  const destination = resolveRushourDestination(CONNECTIONS.A, fixture.order.restaurant_id);
  assert.equal(destination.integrationId, 'test-integration-a');
  const payload = await mapFixture(fixture);
  assert.ok(payload.items.every(i => i.productId.startsWith('rh-a-')));
});

test('F. restaurant B -> intégration B (store optionnel conservé)', async () => {
  const fixture = orderRow({ restaurantId: RESTAURANT_B, items: [itemRow(null, PRODUCTS.B_PIZZA, 'Pizza', 1, 1100)] });
  const destination = resolveRushourDestination(CONNECTIONS.B, RESTAURANT_B);
  assert.deepEqual(destination, { restaurantId: RESTAURANT_B, integrationId: 'test-integration-b', storeId: 'test-store-b' });
  const payload = await mapFixture(fixture, CONNECTIONS.B);
  assert.equal(payload.items[0].productId, 'rh-b-pizza');
});

test('E/F. même commande, destinations différentes -> clés d’export différentes', async () => {
  const { order } = simpleOrderA();
  const a = await computeExportKey({ orderId: order.id, integrationId: 'test-integration-a' });
  const b = await computeExportKey({ orderId: order.id, integrationId: 'test-integration-b' });
  assert.notEqual(a, b);
});

// G / H. configuration
test('G. absence de configuration RusHour : NON_RETRYABLE, rien n’est mappé', () => {
  assert.throws(() => resolveRushourDestination(null, RESTAURANT_C),
    err => err.category === ErrorCategory.NON_RETRYABLE && err.code === 'RUSHOUR_NOT_CONFIGURED');
});

test('H. intégration désactivée : aucun envoi', () => {
  const disabled = { ...CONNECTIONS.A, enabled: false };
  assert.throws(() => resolveRushourDestination(disabled, RESTAURANT_A), { code: 'RUSHOUR_INTEGRATION_DISABLED' });
  // enabled doit valoir exactement true (pas "truthy").
  assert.throws(() => resolveRushourDestination({ ...CONNECTIONS.A, enabled: 'true' }, RESTAURANT_A),
    { code: 'RUSHOUR_INTEGRATION_DISABLED' });
});

test('H. configuration d’un autre restaurant ou identifiant invalide : refus', () => {
  assert.throws(() => resolveRushourDestination(CONNECTIONS.B, RESTAURANT_A), { code: 'CROSS_TENANT_CONNECTION' });
  assert.throws(() => resolveRushourDestination({ ...CONNECTIONS.A, rushour_integration_id: '../../admin' }, RESTAURANT_A),
    { code: 'INVALID_INTEGRATION_ID' });
});

// I. produit non mappé
test('I. produit non mappé : MAPPING_ERROR, FAIL CLOSED', async () => {
  const withoutDrink = tenantMappings(RESTAURANT_A).filter(m => m.product_id !== PRODUCTS.A_DRINK);
  await assertRushourError(() => mapFixture(simpleOrderA(), CONNECTIONS.A, withoutDrink),
    ErrorCategory.MAPPING_ERROR, 'PRODUCT_NOT_MAPPED');
});

test('I. mapping RusHour invalide ou ambigu : MAPPING_ERROR', async () => {
  const invalid = [...tenantMappings(RESTAURANT_A).filter(m => m.product_id !== PRODUCTS.A_DRINK),
    mappingRow(RESTAURANT_A, PRODUCTS.A_DRINK, '')];
  await assertRushourError(() => mapFixture(simpleOrderA(), CONNECTIONS.A, invalid),
    ErrorCategory.MAPPING_ERROR, 'INVALID_RUSHOUR_PRODUCT_ID');
  const ambiguous = [...tenantMappings(RESTAURANT_A), mappingRow(RESTAURANT_A, PRODUCTS.A_DRINK, 'rh-a-other-drink')];
  await assertRushourError(() => mapFixture(simpleOrderA(), CONNECTIONS.A, ambiguous),
    ErrorCategory.MAPPING_ERROR, 'AMBIGUOUS_PRODUCT_MAPPING');
});

// J. cross-tenant
test('J. mapping produit d’un autre restaurant refusé, même avec le bon product_id', async () => {
  const leaked = [
    ...PRODUCT_MAPPINGS.filter(m => m.restaurant_id === RESTAURANT_A && m.product_id !== PRODUCTS.A_DRINK),
    mappingRow(RESTAURANT_B, PRODUCTS.A_DRINK, 'rh-b-pizza')
  ];
  await assertRushourError(() => mapFixture(simpleOrderA(), CONNECTIONS.A, leaked),
    ErrorCategory.MAPPING_ERROR, 'CROSS_TENANT_PRODUCT_MAPPING');
});

test('J. liste de mappings mélangeant plusieurs restaurants : refusée en bloc', async () => {
  await assertRushourError(() => mapFixture(simpleOrderA(), CONNECTIONS.A, PRODUCT_MAPPINGS),
    ErrorCategory.MAPPING_ERROR, 'CROSS_TENANT_PRODUCT_MAPPING');
});

test('J. destination d’un autre restaurant refusée par le mapper', async () => {
  const { order, items } = simpleOrderA();
  const normalized = normalizeFoodatoiOrder(order, items);
  const destinationB = resolveRushourDestination(CONNECTIONS.B, RESTAURANT_B);
  const exportKey = await computeExportKey({ orderId: order.id, integrationId: destinationB.integrationId });
  assert.throws(() => foodatoiOrderToRushour({ order: normalized, destination: destinationB, productMappings: PRODUCT_MAPPINGS, exportKey }),
    { code: 'CROSS_TENANT_DESTINATION' });
});

// V. payload invalide
test('V. commande invalide : chaque incohérence est refusée (VALIDATION_ERROR)', () => {
  const { order, items } = simpleOrderA();
  const cases = [
    [{ ...order, id: 'not-a-uuid' }, items, 'INVALID_ORDER'],
    [{ ...order, order_number: '  ' }, items, 'INVALID_ORDER'],
    [{ ...order, fulfillment_type: 'DRONE' }, items, 'INVALID_FULFILLMENT_TYPE'],
    [{ ...order, pickup_time: 'demain midi' }, items, 'INVALID_TIMESTAMP'],
    [order, [], 'EMPTY_ORDER'],
    [order, [{ ...items[0], quantity: 0, line_total_cents: 0 }, items[1]], 'INVALID_QUANTITY'],
    [order, [{ ...items[0], quantity: 100, line_total_cents: 85000 }, items[1]], 'INVALID_QUANTITY'],
    [order, [{ ...items[0], product_id: null }, items[1]], 'INVALID_PRODUCT_ID'],
    [order, [{ ...items[0], order_id: RESTAURANT_B }, items[1]], 'ITEM_ORDER_MISMATCH'],
    [{ ...order, fulfillment_type: 'DELIVERY', delivery_address: { street: '1 rue X' } }, items, 'MISSING_DELIVERY_ADDRESS']
  ];
  for (const [o, i, code] of cases) {
    assert.throws(() => normalizeFoodatoiOrder(o, i),
      err => err.category === ErrorCategory.VALIDATION_ERROR && err.code === code, code);
  }
});

test('V. livraison : type delivery + adresse texte', async () => {
  const fixture = simpleOrderA({
    fulfillment_type: 'DELIVERY',
    delivery_address: { street: '8 rue des Lilas', postal_code: '31000', city: 'Toulouse' }
  });
  const payload = await mapFixture(fixture);
  assert.equal(payload.type, 'delivery');
  assert.deepEqual(payload.customer.address, { address: '8 rue des Lilas, 31000 Toulouse' });
});

test('V. commande annulée ou paiement en ligne en attente : non exportée', async () => {
  await assertRushourError(() => mapFixture(simpleOrderA({ status: 'CANCELLED' })),
    ErrorCategory.NON_RETRYABLE, 'ORDER_CANCELLED');
  await assertRushourError(() => mapFixture(simpleOrderA({ payment_status: 'PENDING' })),
    ErrorCategory.RETRYABLE, 'PAYMENT_PENDING');
  const paid = await mapFixture(simpleOrderA({ payment_status: 'PAID' }));
  assert.equal(paid.isPaid, true);
});

test('V. clé d’export invalide refusée par le mapper', async () => {
  const { order, items } = simpleOrderA();
  const destination = resolveRushourDestination(CONNECTIONS.A, RESTAURANT_A);
  assert.throws(() => foodatoiOrderToRushour({
    order: normalizeFoodatoiOrder(order, items), destination, productMappings: PRODUCT_MAPPINGS, exportKey: 'retry-2'
  }), { code: 'INVALID_EXPORT_KEY' });
});

test('schéma RusHour explicitement NON vérifié (garde-fou Bloc 2)', () => {
  assert.equal(RUSHOUR_PAYLOAD_SCHEMA.verified, false);
  assert.ok(RUSHOUR_PAYLOAD_SCHEMA.unverified.length > 0);
});
