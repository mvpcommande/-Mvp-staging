import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { createSupabaseOutboxRepository, toOutboxEntry } from './supabaseRepository.mjs';
import { ErrorCategory } from './errors.mjs';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const RUSHOUR_MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter(f => /rushour/.test(f)).sort()
  .map(f => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
const MIGRATION = RUSHOUR_MIGRATIONS.join('\n');

/** Paramètres de la DERNIÈRE définition d'une fonction SQL (migrations triées). */
function sqlParams(fnName) {
  const matches = [...MIGRATION.matchAll(new RegExp(`create or replace function public\\.${fnName}\\(([^)]*)\\)`, 'gm'))];
  assert.ok(matches.length > 0, `fonction ${fnName} absente des migrations`);
  return [...matches.at(-1)[1].matchAll(/\b(p_[a-z_]+)\b/g)].map(m => m[1]);
}

/** Faux client supabase-js : enregistre les appels, renvoie des réponses scriptées. */
function fakeDb({ rpc = {}, tables = {}, failOn = null } = {}) {
  const calls = [];
  const builder = table => {
    const q = { table, filters: [] };
    const result = () => (failOn === table ? { data: null, error: { message: 'boom secret=x' } } : { data: tables[table] ?? null, error: null });
    const chain = {
      select(cols) { q.select = cols; return chain; },
      eq(col, v) { q.filters.push(['eq', col, v]); return chain; },
      in(col, v) { q.filters.push(['in', col, v]); return chain; },
      maybeSingle() { calls.push(q); return Promise.resolve(result()); },
      insert(row) { q.insert = row; calls.push(q); return Promise.resolve(result()); },
      then(resolve, reject) { calls.push(q); return Promise.resolve(result()).then(resolve, reject); }
    };
    return chain;
  };
  return {
    calls,
    from: builder,
    rpc(name, args) {
      calls.push({ rpc: name, args });
      if (failOn === name) return Promise.resolve({ data: null, error: { message: 'boom' } });
      return Promise.resolve({ data: rpc[name] ?? null, error: null });
    }
  };
}

test('contrat repo ↔ SQL : noms de RPC et de paramètres identiques à la migration', async () => {
  const db = fakeDb({ rpc: { rushour_claim_outbox: [], rushour_mark_sent: true, rushour_mark_failed: 'PENDING' } });
  const repo = createSupabaseOutboxRepository(db);
  await repo.claim({ workerId: 'w', limit: 3 });
  await repo.markSent({ id: 'o', workerId: 'w', externalOrderId: null });
  await repo.markFailed({ id: 'o', workerId: 'w', errorCode: 'X', errorCategory: 'TIMEOUT', errorMessage: 'm', retryInSeconds: 5 });
  await repo.markUncertain({ id: 'o', workerId: 'w', errorCode: 'X', errorMessage: 'm' });

  for (const call of db.calls.filter(c => c.rpc)) {
    assert.deepEqual(Object.keys(call.args).sort(), sqlParams(call.rpc).sort(), call.rpc);
  }
});

test('contrat repo ↔ SQL : colonnes outbox et journal cohérentes avec la migration', async () => {
  const row = {
    id: 'o', order_id: 'ord', restaurant_id: 'r', export_key: 'fdt1_x', destination_integration_id: 'itg',
    attempts: 1, max_attempts: 5
  };
  for (const col of Object.keys(row)) {
    assert.match(MIGRATION, new RegExp(`\\n\\s+${col} `), `colonne outbox ${col}`);
  }
  assert.deepEqual(toOutboxEntry(row), {
    id: 'o', orderId: 'ord', restaurantId: 'r', exportKey: 'fdt1_x', destinationIntegrationId: 'itg', attempts: 1, maxAttempts: 5
  });

  const db = fakeDb();
  const repo = createSupabaseOutboxRepository(db);
  const event = { outbox_id: 'o', restaurant_id: 'r', order_id: 'ord', step: 'SEND', outcome: 'SENT',
    attempt: 1, error_category: null, error_code: null, http_status: null, message: null, duration_ms: 12, endpoint: 'orders.create' };
  await repo.logEvent(event);
  const eventsTable = MIGRATION.slice(MIGRATION.indexOf('create table public.rushour_sync_events'));
  for (const col of Object.keys(event)) {
    assert.match(eventsTable, new RegExp(`(\\n\\s+|add column if not exists )${col} `), `colonne journal ${col}`);
  }
});

test('loadExportContext : lecture scopée au restaurant de l’entrée, mappings filtrés', async () => {
  const db = fakeDb({
    tables: {
      orders: { id: 'ord', restaurant_id: 'r' },
      order_items: [{ product_id: 'p1' }, { product_id: 'p1' }, { product_id: 'p2' }],
      restaurant_rushour_connections: { restaurant_id: 'r', enabled: true },
      rushour_product_mappings: [{ restaurant_id: 'r', product_id: 'p1', rushour_product_id: 'x' }]
    }
  });
  const repo = createSupabaseOutboxRepository(db);
  const ctx = await repo.loadExportContext({ orderId: 'ord', restaurantId: 'r' });
  assert.equal(ctx.productMappings.length, 1);
  const mappingQuery = db.calls.find(c => c.table === 'rushour_product_mappings');
  assert.deepEqual(mappingQuery.filters, [['eq', 'restaurant_id', 'r'], ['in', 'product_id', ['p1', 'p2']]]);
  const connectionQuery = db.calls.find(c => c.table === 'restaurant_rushour_connections');
  assert.deepEqual(connectionQuery.filters, [['eq', 'restaurant_id', 'r']]);
  assert.doesNotMatch(connectionQuery.select, /secret|token/i);
});

test('erreurs base : RETRYABLE DB_ERROR, sans détail Postgres propagé', async () => {
  for (const failOn of ['rushour_claim_outbox', 'orders', 'rushour_mark_failed']) {
    const repo = createSupabaseOutboxRepository(fakeDb({ failOn }));
    const attempt = failOn === 'rushour_claim_outbox'
      ? repo.claim({ workerId: 'w', limit: 1 })
      : failOn === 'orders'
        ? repo.loadExportContext({ orderId: 'ord', restaurantId: 'r' })
        : repo.markFailed({ id: 'o', workerId: 'w', errorCode: 'X', errorCategory: 'TIMEOUT', errorMessage: 'm', retryInSeconds: 5 });
    await assert.rejects(attempt, err => {
      assert.equal(err.category, ErrorCategory.RETRYABLE);
      assert.equal(err.code, 'DB_ERROR');
      assert.doesNotMatch(err.message, /boom|secret/);
      return true;
    }, failOn);
  }
  assert.throws(() => createSupabaseOutboxRepository({}), TypeError);
});
