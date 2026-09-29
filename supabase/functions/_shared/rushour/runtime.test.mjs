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

test('K. mode par défaut = mock ; mode inconnu refusé (503)', () => {
  assert.equal(resolveRuntime(envOf({})).mode, 'mock');
  for (const mode of ['real', 'http', 'MOCK', 'LIVE', '']) {
    assert.throws(() => resolveRuntime(envOf({ RUSHOUR_MODE: mode, RUSHOUR_APP_SECRET: 'x' })),
      err => err.code === 'unsupported_mode' && err.status === 503, mode);
  }
});

test('K. aucun chemin réseau hors du client HTTP (dispatcher, mock, Edge Function)', () => {
  const sources = [
    readFileSync(new URL('../../rushour-dispatch-order/index.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./dispatcher.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('./mockClient.mjs', import.meta.url), 'utf8')
  ].join('\n');
  assert.doesNotMatch(sources, /api\.rushour\.io|RushourHttpClient\(|fetch\(/);
  assert.doesNotMatch(sources, /Deno\.env\.get\(["']RUSHOUR_APP/, 'credentials lus uniquement via runtime.mjs');
});

const STAGING_URL = 'https://kkhlpeqherxfdnilewkp.supabase.co';
const PROD_URL = 'https://ffuykessameuonpnyiyc.supabase.co';
const VERIFIED_TEST_PROFILE = Object.freeze({
  id: 'test-profile', verified: true, baseUrl: 'https://rushour.example.test',
  token: { path: '/t/{appId}/{integrationId}', body: {}, accessTokenField: 'access_token',
    expiresInField: 'expires_in', tokenTypeField: 'token_type', expectedTokenType: 'Bearer' },
  order: { path: '/o/{appId}/{integrationId}', externalIdField: null },
  dedupOnExternalId: false, refreshTokenOn401: false, tokenSafetyMarginSeconds: 60
});
const liveEnv = extra => envOf({ RUSHOUR_MODE: 'live', SUPABASE_URL: STAGING_URL,
  RUSHOUR_APP_ID: 'app-test', RUSHOUR_APP_SECRET: FAKE_SECRETS.appSecret, ...extra });

test('Bloc 2 : live IMPOSSIBLE avec les profils committés (non vérifiés), même credentials présents', () => {
  assert.throws(() => resolveRuntime(liveEnv({})), err => err.code === 'live_profile_unverified' && err.status === 503);
});

test('Bloc 2 : live refusé hors staging, et explicitement sur la production', () => {
  const ok = { profile: VERIFIED_TEST_PROFILE, payloadSchema: { verified: true }, fetchImpl: () => { throw new Error('no'); } };
  assert.throws(() => resolveRuntime(liveEnv({ SUPABASE_URL: PROD_URL }), ok), { code: 'live_forbidden_on_production' });
  assert.throws(() => resolveRuntime(liveEnv({ SUPABASE_URL: 'http://127.0.0.1:54321' }), ok), { code: 'live_project_not_allowed' });
  assert.throws(() => resolveRuntime(liveEnv({ SUPABASE_URL: 'https://autreprojet.supabase.co' }), ok), { code: 'live_project_not_allowed' });
  assert.throws(() => resolveRuntime(liveEnv({ RUSHOUR_APP_SECRET: '' }), ok), { code: 'live_credentials_missing' });
  assert.throws(() => resolveRuntime(liveEnv({}), { ...ok, payloadSchema: { verified: false } }), { code: 'live_profile_unverified' });
  const runtime = resolveRuntime(liveEnv({}), ok);
  assert.equal(runtime.mode, 'live');
  assert.equal(runtime.client.idempotencyGuaranteed, false);
  const serialized = JSON.stringify(runtime.client);
  assert.ok(!serialized.includes(FAKE_SECRETS.appSecret) && !serialized.includes('app-test'),
    'client non sérialisable avec ses secrets');
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
