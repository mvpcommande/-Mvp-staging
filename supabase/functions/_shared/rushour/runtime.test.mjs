// K. Garde-fou : RUSHOUR_MODE=mock => aucun appel externe, même avec des
// credentials RusHour présents par erreur dans l'environnement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveRuntime, checkDispatchAuth, safeEqual, authorizeDispatch } from './runtime.mjs';
import { RushourMockClient } from './mockClient.mjs';
import { runDispatchBatch } from './dispatcher.mjs';
import { InMemoryOutbox } from './inMemoryOutbox.mjs';
import { CONNECTIONS, PRODUCT_MAPPINGS, simpleOrderA, FAKE_SECRETS } from './fixtures.mjs';

const envOf = vars => name => vars[name];

test('K. mode mock + RUSHOUR_APP_ID/SECRET présents : MockClient, zéro fetch', async () => {
  const env = envOf({
    RUSHOUR_MODE: 'mock',
    RUSHOUR_APP_ID: 'accidental-app-id',
    RUSHOUR_APP_SECRET: FAKE_SECRETS.appSecret
  });
  const runtime = resolveRuntime(env);
  assert.ok(runtime.client instanceof RushourMockClient);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls += 1; throw new Error('NETWORK FORBIDDEN'); };
  try {
    const outbox = new InMemoryOutbox({ nowMs: () => 0 });
    outbox.addConnection(CONNECTIONS.A);
    PRODUCT_MAPPINGS.forEach(m => outbox.addProductMapping(m));
    const { order, items } = simpleOrderA();
    await outbox.insertOrder(order, items);
    const summary = await runDispatchBatch({ repo: outbox, client: runtime.client, workerId: 'w', timeoutMs: runtime.timeoutMs });
    assert.equal(summary.sent, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('K. mode par défaut = mock ; tout autre mode est refusé (503)', () => {
  assert.equal(resolveRuntime(envOf({})).mode, 'mock');
  for (const mode of ['live', 'real', 'http', 'MOCK', '']) {
    assert.throws(() => resolveRuntime(envOf({ RUSHOUR_MODE: mode, RUSHOUR_APP_SECRET: 'x' })),
      err => err.code === 'real_mode_not_available' && err.status === 503, mode);
  }
});

test('K. aucun chemin de code runtime/Edge Function vers l’API RusHour', () => {
  const sources = [
    readFileSync(new URL('./runtime.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../../rushour-dispatch-order/index.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./dispatcher.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('./mockClient.mjs', import.meta.url), 'utf8')
  ].join('\n');
  assert.doesNotMatch(sources, /api\.rushour\.io|RushourHttpClient\(|fetch\(/);
  assert.doesNotMatch(sources, /Deno\.env\.get\(["']RUSHOUR_APP/);
});

test('scénarios mock : séquence, validation, timeout borné, instance partagée par configuration', () => {
  const r1 = resolveRuntime(envOf({ RUSHOUR_MOCK_SCENARIO: 'timeout_after_accept, success', RUSHOUR_SEND_TIMEOUT_MS: '1500' }));
  const r2 = resolveRuntime(envOf({ RUSHOUR_MOCK_SCENARIO: 'timeout_after_accept,success' }));
  assert.deepEqual(r1.scenarios, ['timeout_after_accept', 'success']);
  assert.equal(r1.timeoutMs, 1500);
  assert.equal(r1.client, r2.client, 'même isolate + même config => même état mock');
  assert.throws(() => resolveRuntime(envOf({ RUSHOUR_MOCK_SCENARIO: 'success,nope' })), { code: 'invalid_mock_scenario' });
  assert.throws(() => resolveRuntime(envOf({ RUSHOUR_SEND_TIMEOUT_MS: '60000' })), { code: 'invalid_send_timeout' });
  assert.throws(() => resolveRuntime(envOf({ RUSHOUR_MOCK_RETRY_AFTER_SECONDS: '-1' })), { code: 'invalid_mock_retry_after' });
  const ra = resolveRuntime(envOf({ RUSHOUR_MOCK_SCENARIO: 'http_429', RUSHOUR_MOCK_RETRY_AFTER_SECONDS: '90' }));
  assert.notEqual(ra.client, resolveRuntime(envOf({ RUSHOUR_MOCK_SCENARIO: 'http_429' })).client);
});

test('authentification du dispatcher : secret requis, long, comparé à temps constant', () => {
  const good = 'a'.repeat(40);
  assert.deepEqual(checkDispatchAuth(envOf({}), good), { error: 'dispatcher_not_configured', status: 503 });
  assert.deepEqual(checkDispatchAuth(envOf({ RUSHOUR_DISPATCH_SECRET: 'short' }), 'short'),
    { error: 'dispatcher_not_configured', status: 503 });
  assert.deepEqual(checkDispatchAuth(envOf({ RUSHOUR_DISPATCH_SECRET: good }), 'b'.repeat(40)), { error: 'unauthorized', status: 401 });
  assert.deepEqual(checkDispatchAuth(envOf({ RUSHOUR_DISPATCH_SECRET: good }), null), { error: 'unauthorized', status: 401 });
  assert.equal(checkDispatchAuth(envOf({ RUSHOUR_DISPATCH_SECRET: good }), good), null);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('autorisation via Vault (RPC) quand aucun secret d’environnement', async () => {
  const good = 'c'.repeat(64);
  const verifyWithDb = async candidate => candidate === good;
  const noEnv = envOf({});
  assert.equal(await authorizeDispatch({ getEnv: noEnv, providedSecret: good, verifyWithDb }), null);
  assert.deepEqual(await authorizeDispatch({ getEnv: noEnv, providedSecret: 'd'.repeat(64), verifyWithDb }),
    { error: 'unauthorized', status: 401 });
  assert.deepEqual(await authorizeDispatch({ getEnv: noEnv, providedSecret: 'short', verifyWithDb }),
    { error: 'unauthorized', status: 401 }, 'secret trop court rejeté sans appel base');
  assert.deepEqual(await authorizeDispatch({ getEnv: noEnv, providedSecret: good, verifyWithDb: async () => null }),
    { error: 'dispatcher_not_configured', status: 503 }, 'Vault non configuré -> 503');
  assert.deepEqual(await authorizeDispatch({ getEnv: noEnv, providedSecret: good, verifyWithDb: async () => { throw new Error('db'); } }),
    { error: 'dispatcher_not_configured', status: 503 }, 'erreur base -> fail closed');
  let called = false;
  const envSecret = envOf({ RUSHOUR_DISPATCH_SECRET: 'e'.repeat(40) });
  assert.equal(await authorizeDispatch({ getEnv: envSecret, providedSecret: 'e'.repeat(40), verifyWithDb: async () => { called = true; return false; } }), null);
  assert.equal(called, false, 'secret d’environnement prioritaire, pas d’appel base');
});
