// RushourHttpClient contre un serveur HTTP LOCAL contrôlé.
// Aucun test ne dépend de la vraie API RusHour.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { RushourHttpClient } from './httpClient.mjs';
import { ErrorCategory } from './errors.mjs';
import { runDispatchBatch } from './dispatcher.mjs';
import { InMemoryOutbox } from './inMemoryOutbox.mjs';
import { CONNECTIONS, PRODUCT_MAPPINGS, simpleOrderA, FAKE_SECRETS } from './fixtures.mjs';

const APP_ID = 'app-local-test';
const DEST = Object.freeze({ restaurantId: 'r', integrationId: 'itg-test', storeId: null, targetEnvironment: 'test' });
const KEY = 'fdt1_0123456789abcdef0123456789abcdef';

/** Serveur local : chaque requête est journalisée puis traitée par `handler`. */
async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      handler(entry, res, requests);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { requests, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const tokenOk = (res, expiresIn = 3600) =>
  json(res, 200, { access_token: FAKE_SECRETS.accessToken, expires_in: expiresIn, token_type: 'Bearer' });
const isToken = req => req.url.endsWith('/token');

function profile(baseUrl, extra = {}) {
  return {
    id: 'local-test-profile', verified: true, baseUrl,
    token: { path: '/apps/{appId}/integrations/{integrationId}/token', body: { scopes: ['public/oauth'] },
      accessTokenField: 'access_token', expiresInField: 'expires_in', tokenTypeField: 'token_type', expectedTokenType: 'Bearer' },
    order: { path: '/apps/{appId}/integrations/{integrationId}/orders', externalIdField: null },
    dedupOnExternalId: false, refreshTokenOn401: false, tokenSafetyMarginSeconds: 60,
    ...extra
  };
}

function client(baseUrl, { profileExtra = {}, ...options } = {}) {
  return new RushourHttpClient({
    profile: profile(baseUrl, profileExtra), appId: APP_ID, appSecret: FAKE_SECRETS.appSecret, timeoutMs: 500, ...options
  });
}

const send = (c, extra = {}) => c.sendOrder({ destination: DEST, payload: { id: KEY, total: 1900 }, exportKey: KEY, ...extra });

async function expectError(promise, category, code) {
  const err = await promise.then(() => null, e => e);
  assert.ok(err, 'une erreur était attendue');
  assert.equal(err.category, category, `catégorie (code reçu ${err.code})`);
  if (code) assert.equal(err.code, code);
  const text = `${err.message} ${err.code} ${JSON.stringify(err)}`;
  assert.ok(!text.includes(FAKE_SECRETS.appSecret) && !text.includes(FAKE_SECRETS.accessToken), 'aucun secret dans l’erreur');
  return err;
}

test('token success + commande 200 {} : requêtes conformes au profil, secrets dans les en-têtes seulement', async () => {
  const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, 200, {})));
  try {
    const result = await send(client(srv.baseUrl));
    assert.deepEqual(result, { externalOrderId: null, duplicate: false });
    const [tokenReq, orderReq] = srv.requests;
    assert.equal(tokenReq.method, 'POST');
    assert.equal(tokenReq.url, `/apps/${APP_ID}/integrations/itg-test/token`);
    assert.equal(tokenReq.headers.authorization, `Basic ${Buffer.from(`${APP_ID}:${FAKE_SECRETS.appSecret}`).toString('base64')}`);
    assert.deepEqual(JSON.parse(tokenReq.body), { scopes: ['public/oauth'] });
    assert.equal(orderReq.url, `/apps/${APP_ID}/integrations/itg-test/orders`);
    assert.equal(orderReq.headers.authorization, `Bearer ${FAKE_SECRETS.accessToken}`);
    assert.deepEqual(JSON.parse(orderReq.body), { id: KEY, total: 1900 });
  } finally { await srv.close(); }
});

test('commande 201 avec identifiant externe (si le profil le déclare)', async () => {
  const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, 201, { id: 'rh-order-1' })));
  try {
    const result = await send(client(srv.baseUrl, { profileExtra: { order: { path: '/apps/{appId}/integrations/{integrationId}/orders', externalIdField: 'id' } } }));
    assert.deepEqual(result, { externalOrderId: 'rh-order-1', duplicate: false });
  } finally { await srv.close(); }
});

test('token : 401 -> AUTH_ERROR ; JSON invalide -> RETRYABLE ; timeout -> TIMEOUT ; aucune commande émise', async () => {
  for (const [behavior, category, code] of [
    [(req, res) => json(res, 401, { error: 'bad' }), ErrorCategory.AUTH_ERROR, 'TOKEN_HTTP_401'],
    [(req, res) => json(res, 200, '<html>oops'), ErrorCategory.RETRYABLE, 'TOKEN_INVALID_RESPONSE'],
    [(req, res) => json(res, 200, { access_token: '', expires_in: 3600, token_type: 'Bearer' }), ErrorCategory.RETRYABLE, 'TOKEN_INVALID_RESPONSE'],
    [() => { /* ne répond jamais */ }, ErrorCategory.TIMEOUT, 'TOKEN_TIMEOUT']
  ]) {
    const srv = await startServer(behavior);
    try {
      await expectError(send(client(srv.baseUrl)), category, code);
      assert.ok(srv.requests.every(isToken), 'aucune commande envoyée sans token valide');
    } finally { await srv.close(); }
  }
});

test('commande 400 / 409 / 422 -> NON_RETRYABLE ; 401 -> AUTH_ERROR ; 500 -> RETRYABLE ; 429 + Retry-After', async () => {
  const cases = [
    [400, ErrorCategory.NON_RETRYABLE, 'HTTP_400'],
    [401, ErrorCategory.AUTH_ERROR, 'HTTP_401'],
    [409, ErrorCategory.NON_RETRYABLE, 'HTTP_409'],
    [422, ErrorCategory.NON_RETRYABLE, 'HTTP_422'],
    [500, ErrorCategory.RETRYABLE, 'HTTP_500']
  ];
  for (const [status, category, code] of cases) {
    const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, status, { secret_echo: FAKE_SECRETS.accessToken })));
    try {
      const err = await expectError(send(client(srv.baseUrl)), category, code);
      assert.equal(err.httpStatus, status);
      assert.ok(!err.message.includes('secret_echo'), 'le corps de réponse n’est jamais recopié');
    } finally { await srv.close(); }
  }
  const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, 429, {}, { 'Retry-After': '42' })));
  try {
    const err = await expectError(send(client(srv.baseUrl)), ErrorCategory.RATE_LIMIT, 'HTTP_429');
    assert.equal(err.retryAfterMs, 42_000);
  } finally { await srv.close(); }
});

test('401 commande : un seul renouvellement de token + une seule nouvelle tentative (si le profil l’autorise)', async () => {
  let orderCalls = 0;
  const srv = await startServer((req, res) => {
    if (isToken(req)) return tokenOk(res);
    orderCalls += 1;
    return orderCalls === 1 ? json(res, 401, {}) : json(res, 200, {});
  });
  try {
    await send(client(srv.baseUrl, { profileExtra: { refreshTokenOn401: true } }));
    assert.equal(srv.requests.filter(isToken).length, 2);
    assert.equal(orderCalls, 2);
  } finally { await srv.close(); }

  const loop = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, 401, {})));
  try {
    await expectError(send(client(loop.baseUrl, { profileExtra: { refreshTokenOn401: true } })), ErrorCategory.AUTH_ERROR, 'HTTP_401');
    assert.equal(loop.requests.filter(isToken).length, 2, 'jamais de boucle 401 -> token -> 401');
    assert.equal(loop.requests.filter(r => !isToken(r)).length, 2);
  } finally { await loop.close(); }

  const noRefresh = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, 401, {})));
  try {
    await expectError(send(client(noRefresh.baseUrl)), ErrorCategory.AUTH_ERROR, 'HTTP_401');
    assert.equal(noRefresh.requests.length, 2, 'profil non vérifié sur ce point : aucune nouvelle tentative');
  } finally { await noRefresh.close(); }
});

test('AMBIGUÏTÉ (dédup non confirmée) : timeout, coupure, 2xx illisible -> UNCERTAIN', async () => {
  const cases = [
    [(req, res) => { /* POST reçu, jamais de réponse */ }, 'ORDER_TIMEOUT_AMBIGUOUS'],
    [(req, res) => res.socket.destroy(), 'ORDER_NETWORK_AMBIGUOUS'],
    [(req, res) => json(res, 200, '<html>502 Bad Gateway</html>'), 'ORDER_RESPONSE_INVALID'],
    [(req, res) => json(res, 200, '[1,2]'), 'ORDER_RESPONSE_INVALID']
  ];
  for (const [orderBehavior, code] of cases) {
    const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res) : orderBehavior(req, res)));
    try {
      await expectError(send(client(srv.baseUrl)), ErrorCategory.UNCERTAIN, code);
      assert.equal(srv.requests.filter(r => !isToken(r)).length, 1, 'une seule émission, aucun rejeu interne');
    } finally { await srv.close(); }
  }
  const idField = await startServer((req, res) => (isToken(req) ? tokenOk(res) : json(res, 201, { id: 'bad id!' })));
  try {
    await expectError(send(client(idField.baseUrl, { profileExtra: { order: { path: '/apps/{appId}/integrations/{integrationId}/orders', externalIdField: 'id' } } })),
      ErrorCategory.UNCERTAIN, 'ORDER_RESPONSE_INVALID');
  } finally { await idField.close(); }
});

test('si la dédup RusHour était confirmée : timeout -> TIMEOUT (retry sûr)', async () => {
  const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res) : undefined));
  try {
    const c = client(srv.baseUrl, { profileExtra: { dedupOnExternalId: true } });
    assert.equal(c.idempotencyGuaranteed, true);
    await expectError(send(c), ErrorCategory.TIMEOUT, 'TIMEOUT');
  } finally { await srv.close(); }
});

test('cache de token : réutilisé, renouvelé avant expiration (marge), single-flight concurrent', async () => {
  const clock = { now: 1_000_000 };
  const srv = await startServer((req, res) => (isToken(req) ? tokenOk(res, 120) : json(res, 200, {})));
  try {
    const c = client(srv.baseUrl, { nowMs: () => clock.now });
    await Promise.all([send(c), send(c), send(c)]);
    assert.equal(srv.requests.filter(isToken).length, 1, 'single-flight : un seul token pour 3 envois simultanés');
    clock.now += 50_000;
    await send(c);
    assert.equal(srv.requests.filter(isToken).length, 1, 'token réutilisé tant que valide');
    clock.now += 15_000; // 65 s écoulées sur 120 : dans la marge de 60 s
    await send(c);
    assert.equal(srv.requests.filter(isToken).length, 2, 'renouvelé avant expiration');
  } finally { await srv.close(); }
});

test('garde-fous : destination non "test" refusée SANS réseau ; profil non vérifié ; credentials ; HTTPS', async () => {
  let calls = 0;
  const c = new RushourHttpClient({ profile: profile('https://rushour.example.test'), appId: APP_ID, appSecret: 'x',
    fetchImpl: () => { calls += 1; throw new Error('no network'); } });
  await expectError(c.sendOrder({ destination: { ...DEST, targetEnvironment: 'production' }, payload: {}, exportKey: KEY }),
    ErrorCategory.NON_RETRYABLE, 'LIVE_TARGET_NOT_ALLOWED');
  assert.equal(calls, 0);
  assert.throws(() => new RushourHttpClient({ profile: { ...profile('https://x.test'), verified: false }, appId: 'a', appSecret: 's' }),
    { code: 'REAL_CLIENT_DISABLED' });
  assert.throws(() => new RushourHttpClient({ profile: profile('https://x.test'), appId: 'a', appSecret: '' }), { code: 'MISSING_CREDENTIALS' });
  assert.throws(() => new RushourHttpClient({ profile: profile('http://rushour.example.test'), appId: 'a', appSecret: 's' }), TypeError);
  assert.ok(!JSON.stringify(c).includes(APP_ID) || JSON.stringify(c) === JSON.stringify({ client: 'RushourHttpClient', profile: 'local-test-profile' }));
});

// --- Pipeline complet : outbox + dispatcher + client HTTP réel + serveur local ---

async function pipeline(orderBehavior) {
  const srv = await startServer((req, res, all) => (isToken(req) ? tokenOk(res) : orderBehavior(req, res, all)));
  const outbox = new InMemoryOutbox({ nowMs: () => Date.now() });
  outbox.addConnection({ ...CONNECTIONS.A, target_environment: 'test' });
  PRODUCT_MAPPINGS.forEach(m => outbox.addProductMapping(m));
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const c = client(srv.baseUrl);
  const summary = await runDispatchBatch({ repo: outbox, client: c, workerId: 'w', timeoutMs: 2000 });
  return { srv, outbox, order, summary, c };
}

test('pipeline HTTP : commande acceptée -> SENT, une seule émission, payload = sortie du mapper', async () => {
  const { srv, outbox, order, summary } = await pipeline((req, res) => json(res, 201, {}));
  try {
    assert.equal(summary.sent, 1);
    const row = outbox.rowForOrder(order.id);
    assert.equal(row.status, 'SENT');
    const orders = srv.requests.filter(r => !isToken(r));
    assert.equal(orders.length, 1);
    const body = JSON.parse(orders[0].body);
    assert.equal(body.externalId, row.exportKey);
    assert.equal(body.total, order.total_cents);
    assert.equal(outbox.events.at(-1).endpoint, 'orders.create');
    assert.ok(Number.isInteger(outbox.events.at(-1).duration_ms));
  } finally { await srv.close(); }
});

test('pipeline HTTP : timeout après POST -> UNCERTAIN, JAMAIS rejoué automatiquement', async () => {
  const { srv, outbox, order, summary, c } = await pipeline(() => { /* jamais de réponse */ });
  try {
    assert.equal(summary.uncertain, 1);
    assert.equal(outbox.rowForOrder(order.id).status, 'UNCERTAIN');
    const again = await runDispatchBatch({ repo: outbox, client: c, workerId: 'w2', timeoutMs: 2000 });
    assert.equal(again.claimed, 0);
    assert.equal(srv.requests.filter(r => !isToken(r)).length, 1, 'une seule émission au total');
  } finally { await srv.close(); }
});

test('pipeline HTTP : 500 -> retry planifié (même identité)', async () => {
  const { srv, outbox, order, summary } = await pipeline((req, res) => json(res, 500, {}));
  try {
    assert.equal(summary.retryScheduled, 1);
    assert.equal(outbox.rowForOrder(order.id).status, 'PENDING');
    assert.equal(outbox.rowForOrder(order.id).lastErrorCode, 'HTTP_500');
  } finally { await srv.close(); }
});
