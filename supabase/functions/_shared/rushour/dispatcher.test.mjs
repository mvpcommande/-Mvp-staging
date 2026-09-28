import test from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchBatch, dispatchOutboxEntry, DISPATCH_OUTCOME } from './dispatcher.mjs';
import { RushourMockClient } from './mockClient.mjs';
import { InMemoryOutbox } from './inMemoryOutbox.mjs';
import { computeExportKey } from './idempotency.mjs';
import { ErrorCategory } from './errors.mjs';
import { OUTBOX_STATUS } from './types.mjs';
import {
  RESTAURANT_A, RESTAURANT_B, RESTAURANT_C, PRODUCTS, CONNECTIONS, PRODUCT_MAPPINGS,
  orderRow, itemRow, simpleOrderA
} from './fixtures.mjs';

const T0 = Date.parse('2026-09-28T12:05:00.000Z');

function setup({ connections = [CONNECTIONS.A, CONNECTIONS.B], mappings = PRODUCT_MAPPINGS } = {}) {
  const clock = { now: T0 };
  const outbox = new InMemoryOutbox({ nowMs: () => clock.now });
  connections.forEach(c => outbox.addConnection(c));
  mappings.forEach(m => outbox.addProductMapping(m));
  return { outbox, clock };
}

const run = (outbox, client, workerId = 'worker-1', extra = {}) =>
  runDispatchBatch({ repo: outbox, client, workerId, limit: 10, timeoutMs: 50, ...extra });

// M. succès mock
test('M. succès mock : Foodatoi Order -> Normalized -> Mapper -> Mock -> SENT', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  const row = await outbox.insertOrder(order, items);
  assert.equal(row.status, OUTBOX_STATUS.PENDING);

  const client = new RushourMockClient({ scenarios: ['success'] });
  const summary = await run(outbox, client);

  assert.deepEqual(summary, { claimed: 1, sent: 1, retryScheduled: 0, failed: 0, leaseLost: 0, uncertain: 0 });
  const after = outbox.rowForOrder(order.id);
  assert.equal(after.status, OUTBOX_STATUS.SENT);
  assert.equal(after.attempts, 1);
  assert.match(after.externalOrderId, /^mock_[0-9a-f]{16}$/);
  assert.equal(client.calls[0].integrationId, 'test-integration-a');
  assert.equal(client.calls[0].payload.externalId, after.exportKey);
  assert.equal(outbox.events.at(-1).outcome, 'SENT');
});

// N + S. timeout puis retry puis succès
test('N/S. timeout -> retry dans 5 s -> SUCCESS (même clé d’export)', async () => {
  const { outbox, clock } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient({ scenarios: ['timeout', 'success'] });

  const first = await run(outbox, client);
  assert.equal(first.retryScheduled, 1);
  let row = outbox.rowForOrder(order.id);
  assert.equal(row.status, OUTBOX_STATUS.PENDING);
  assert.equal(row.lastErrorCategory, ErrorCategory.TIMEOUT);
  assert.equal(row.nextAttemptAt, T0 + 5_000);

  assert.equal((await run(outbox, client)).claimed, 0, 'pas de reprise avant l’échéance');

  clock.now += 5_000;
  const second = await run(outbox, client);
  assert.equal(second.sent, 1);
  row = outbox.rowForOrder(order.id);
  assert.equal(row.status, OUTBOX_STATUS.SENT);
  assert.equal(row.attempts, 2);
  assert.equal(client.calls[0].exportKey, client.calls[1].exportKey, 'retry = même identité logique');
  assert.deepEqual(client.calls[0].payload, client.calls[1].payload, 'retry = même payload');
});

test('N. un client qui ignore le signal d’annulation ne bloque pas le worker', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const hanging = { sendOrder: () => new Promise(() => {}) };
  const summary = await run(outbox, hanging);
  assert.equal(summary.retryScheduled, 1);
  assert.equal(outbox.rowForOrder(order.id).lastErrorCode, 'TIMEOUT');
});

// O / P / Q / R. erreurs HTTP
test('O. HTTP 400 : NON_RETRYABLE -> FAILED immédiat, pas de retry aveugle', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const summary = await run(outbox, new RushourMockClient({ scenarios: ['http_400'] }));
  assert.equal(summary.failed, 1);
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.status, OUTBOX_STATUS.FAILED);
  assert.equal(row.lastErrorCode, 'HTTP_400');
  assert.equal(row.lastErrorCategory, ErrorCategory.NON_RETRYABLE);
  assert.equal(row.attempts, 1);
});

test('P. HTTP 401 : AUTH_ERROR, retry borné et espacé (≥ 10 min)', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const summary = await run(outbox, new RushourMockClient({ scenarios: ['http_401'] }));
  assert.equal(summary.retryScheduled, 1);
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.lastErrorCategory, ErrorCategory.AUTH_ERROR);
  assert.equal(row.nextAttemptAt, T0 + 600_000);
});

test('Q. HTTP 429 + Retry-After : délai RusHour respecté', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const summary = await run(outbox, new RushourMockClient({ scenarios: ['http_429'], retryAfterSeconds: 90 }));
  assert.equal(summary.retryScheduled, 1);
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.lastErrorCategory, ErrorCategory.RATE_LIMIT);
  assert.equal(row.nextAttemptAt, T0 + 90_000);
});

test('R. HTTP 500 : RETRYABLE -> retry', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const summary = await run(outbox, new RushourMockClient({ scenarios: ['http_500'] }));
  assert.equal(summary.retryScheduled, 1);
  assert.equal(outbox.rowForOrder(order.id).lastErrorCode, 'HTTP_500');
});

test('HTTP 409 : conflit non documenté -> FAILED (revue humaine), pas de rejeu', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const summary = await run(outbox, new RushourMockClient({ scenarios: ['http_409'] }));
  assert.equal(summary.failed, 1);
  assert.equal(outbox.rowForOrder(order.id).lastErrorCode, 'HTTP_409');
});

test('réseau inaccessible : RETRYABLE ; réponse invalide : UNKNOWN -> FAILED (doublon possible)', async () => {
  const { outbox } = setup();
  const a = simpleOrderA();
  const b = simpleOrderA();
  await outbox.insertOrder(a.order, a.items);
  const net = await run(outbox, new RushourMockClient({ scenarios: ['network'] }));
  assert.equal(net.retryScheduled, 1);
  assert.equal(outbox.rowForOrder(a.order.id).lastErrorCode, 'NETWORK_UNREACHABLE');

  await outbox.insertOrder(b.order, b.items);
  const invalid = await run(outbox, new RushourMockClient({ scenarios: ['invalid_response'] }));
  assert.equal(invalid.failed, 1);
  const row = outbox.rowForOrder(b.order.id);
  assert.equal(row.lastErrorCategory, ErrorCategory.UNKNOWN);
  assert.equal(row.lastErrorCode, 'INVALID_RESPONSE');
});

// T. dépassement max attempts
test('T. 5 échecs retryables -> FAILED, plus aucun envoi (pas de boucle infinie)', async () => {
  const { outbox, clock } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient({ scenarios: ['http_500'] });

  const delays = [];
  for (let i = 0; i < 20; i++) {
    const row = outbox.rowForOrder(order.id);
    if (row.status === OUTBOX_STATUS.FAILED) break;
    clock.now = row.nextAttemptAt;
    const before = clock.now;
    await run(outbox, client);
    const afterRow = outbox.rowForOrder(order.id);
    if (afterRow.status === OUTBOX_STATUS.PENDING) delays.push((afterRow.nextAttemptAt - before) / 1000);
  }
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.status, OUTBOX_STATUS.FAILED);
  assert.equal(row.attempts, 5);
  assert.equal(client.callCount, 5);
  assert.deepEqual(delays, [5, 30, 120, 600]);

  clock.now += 86_400_000;
  assert.equal((await run(outbox, client)).claimed, 0);
  assert.equal(client.callCount, 5);
});

// K / L. idempotence d'export
test('K. clé d’export stable : indépendante de l’heure et des tentatives', async () => {
  const { order } = simpleOrderA();
  const keys = [];
  for (let i = 0; i < 3; i++) keys.push(await computeExportKey({ orderId: order.id, integrationId: 'test-integration-a' }));
  assert.equal(new Set(keys).size, 1);
  assert.equal(
    await computeExportKey({ orderId: order.id.toUpperCase(), integrationId: 'test-integration-a' }), keys[0],
    'insensible à la casse de l’UUID'
  );
  await assert.rejects(() => computeExportKey({ orderId: 'x', integrationId: 'test-integration-a' }), { code: 'INVALID_ORDER_ID' });
});

test('L. même commande enqueue 3 fois + dispatch 3 fois -> UN SEUL export logique', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  const r1 = await outbox.insertOrder(order, items);
  const r2 = await outbox.enqueue(order.id);
  const r3 = await outbox.enqueue(order.id);
  assert.equal(r1.id, r2.id);
  assert.equal(r2.id, r3.id);
  assert.equal(outbox.rows.size, 1);

  const client = new RushourMockClient({ scenarios: ['success'] });
  await run(outbox, client);
  await run(outbox, client);
  await run(outbox, client);
  assert.equal(client.callCount, 1);
  assert.equal(client.acceptedOrders.size, 1);
});

test('L. timeout ambigu (commande arrivée, réponse perdue) -> retry -> RusHour signale un doublon -> 1 seule commande', async () => {
  const { outbox, clock } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient({ scenarios: ['timeout_after_accept', 'success'] });

  await run(outbox, client);
  clock.now += 5_000;
  await run(outbox, client);

  assert.equal(client.callCount, 2);
  assert.equal(client.acceptedOrders.size, 1, 'un seul export logique côté destination');
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.status, OUTBOX_STATUS.SENT);
  assert.ok(outbox.events.some(e => /doublon/.test(e.message ?? '')));
});

test('réponse "duplicate" de RusHour : traitée comme succès idempotent', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient({ scenarios: ['duplicate'] });
  const summary = await run(outbox, client);
  assert.equal(summary.sent, 1);
  assert.equal(client.acceptedOrders.size, 1);
});

// U. concurrence
test('U. deux workers réclament la même commande simultanément -> une seule tentative', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient({ scenarios: ['success'] });

  const [a, b] = await Promise.all([run(outbox, client, 'worker-A'), run(outbox, client, 'worker-B')]);
  assert.equal(a.claimed + b.claimed, 1);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(client.callCount, 1);
  assert.equal(outbox.rowForOrder(order.id).attempts, 1);
});

test('U. worker au bail expiré : ne peut plus écrire (LEASE_LOST), la reprise porte la même clé', async () => {
  const { outbox, clock } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const [stale] = await outbox.claim({ workerId: 'worker-dead', limit: 1 });

  clock.now += 601_000;
  const client = new RushourMockClient({ scenarios: ['success'] });
  const summary = await run(outbox, client, 'worker-alive');
  assert.equal(summary.sent, 1);
  assert.equal(client.calls[0].exportKey, stale.exportKey);

  const late = await dispatchOutboxEntry(stale, { repo: outbox, client, workerId: 'worker-dead', timeoutMs: 50 });
  assert.equal(late.outcome, DISPATCH_OUTCOME.LEASE_LOST);
  assert.equal(outbox.rowForOrder(order.id).status, OUTBOX_STATUS.SENT);
  assert.equal(client.acceptedOrders.size, 1);
});

// Multi-établissements de bout en bout
test('E/F. trois établissements dans un même lot : chaque commande vers SA destination', async () => {
  const { outbox } = setup({ connections: [CONNECTIONS.A, CONNECTIONS.B, CONNECTIONS.C] });
  const a = simpleOrderA();
  const b = orderRow({ restaurantId: RESTAURANT_B, items: [itemRow(null, PRODUCTS.B_PIZZA, 'Pizza', 2, 1100)] });
  const c = orderRow({ restaurantId: RESTAURANT_C, items: [itemRow(null, PRODUCTS.C_BURGER, 'Burger', 1, 950)] });
  for (const f of [a, b, c]) await outbox.insertOrder(f.order, f.items);

  const client = new RushourMockClient({ scenarios: ['success'] });
  const summary = await run(outbox, client);
  assert.equal(summary.sent, 3);
  const routes = Object.fromEntries(client.calls.map(call => [call.payload.displayId, call.integrationId]));
  assert.deepEqual(routes, {
    [a.order.order_number]: 'test-integration-a',
    [b.order.order_number]: 'test-integration-b',
    [c.order.order_number]: 'test-integration-c'
  });
});

test('G/H. restaurant sans config ou désactivé : commande locale OK, rien en file, rien envoyé', async () => {
  const { outbox } = setup({ connections: [CONNECTIONS.A, { ...CONNECTIONS.B, enabled: false }] });
  const b = orderRow({ restaurantId: RESTAURANT_B, items: [itemRow(null, PRODUCTS.B_PIZZA, 'Pizza', 1, 1100)] });
  const c = orderRow({ restaurantId: RESTAURANT_C, items: [itemRow(null, PRODUCTS.C_BURGER, 'Burger', 1, 950)] });
  assert.equal(await outbox.insertOrder(b.order, b.items), null);
  assert.equal(await outbox.insertOrder(c.order, c.items), null);
  assert.ok(outbox.orders.has(b.order.id) && outbox.orders.has(c.order.id));
  const client = new RushourMockClient();
  assert.equal((await run(outbox, client)).claimed, 0);
  assert.equal(client.callCount, 0);
});

test('I. produit non mappé en file : FAILED immédiat, AUCUN appel RusHour', async () => {
  const { outbox } = setup({ mappings: PRODUCT_MAPPINGS.filter(m => m.product_id !== PRODUCTS.A_DRINK) });
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient();
  const summary = await run(outbox, client);
  assert.equal(summary.failed, 1);
  assert.equal(client.callCount, 0);
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.lastErrorCategory, ErrorCategory.MAPPING_ERROR);
  assert.equal(row.lastErrorCode, 'PRODUCT_NOT_MAPPED');
  assert.equal(outbox.events.at(-1).step, 'MAP');
});

test('destination modifiée après la mise en file : pas d’envoi vers la nouvelle cible sans décision humaine', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  outbox.addConnection({ ...CONNECTIONS.A, rushour_integration_id: 'test-integration-a-v2' });
  const client = new RushourMockClient();
  const summary = await run(outbox, client);
  assert.equal(summary.failed, 1);
  assert.equal(client.callCount, 0);
  assert.equal(outbox.rowForOrder(order.id).lastErrorCode, 'DESTINATION_CHANGED');
});

test('clé d’export altérée en base : détectée, aucun envoi', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  const row = await outbox.insertOrder(order, items);
  row.exportKey = await computeExportKey({ orderId: RESTAURANT_B, integrationId: 'test-integration-a' });
  const client = new RushourMockClient();
  await run(outbox, client);
  assert.equal(client.callCount, 0);
  assert.equal(outbox.rowForOrder(order.id).lastErrorCode, 'EXPORT_KEY_MISMATCH');
});

test('échec d’écriture SENT après envoi réussi : pas de rejeu immédiat (COMPLETION_UNCERTAIN)', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  outbox.markSent = async () => { throw new Error('connection reset'); };
  const client = new RushourMockClient();
  const summary = await run(outbox, client);
  assert.equal(summary.uncertain, 1);
  const row = outbox.rowForOrder(order.id);
  assert.equal(row.status, OUTBOX_STATUS.SENDING, 'reste SENDING jusqu’à expiration du bail');
  assert.equal(client.callCount, 1);
});

test('une panne de journalisation ne fait jamais échouer un export', async () => {
  const { outbox } = setup();
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  outbox.logEvent = async () => { throw new Error('log table down'); };
  const summary = await run(outbox, new RushourMockClient());
  assert.equal(summary.sent, 1);
});

test('runDispatchBatch : limite bornée', async () => {
  const { outbox } = setup();
  await assert.rejects(() => run(outbox, new RushourMockClient(), 'w', { limit: 0 }), RangeError);
  await assert.rejects(() => run(outbox, new RushourMockClient(), 'w', { limit: 1000 }), RangeError);
});
