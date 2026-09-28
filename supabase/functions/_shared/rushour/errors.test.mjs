import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyHttpStatus, toRushourError, parseRetryAfter, ErrorCategory, RushourError } from './errors.mjs';
import { decideRetry, DEFAULT_RETRY_POLICY } from './retryPolicy.mjs';
import { RushourMockClient, MOCK_SCENARIOS } from './mockClient.mjs';
import { validateSendResult, RushourHttpClient } from './client.mjs';

test('classification HTTP -> catégorie', () => {
  const cases = [
    [400, ErrorCategory.NON_RETRYABLE], [401, ErrorCategory.AUTH_ERROR], [403, ErrorCategory.AUTH_ERROR],
    [404, ErrorCategory.NON_RETRYABLE], [408, ErrorCategory.TIMEOUT], [409, ErrorCategory.NON_RETRYABLE],
    [422, ErrorCategory.NON_RETRYABLE], [429, ErrorCategory.RATE_LIMIT], [500, ErrorCategory.RETRYABLE],
    [502, ErrorCategory.RETRYABLE], [503, ErrorCategory.RETRYABLE], [302, ErrorCategory.UNKNOWN]
  ];
  for (const [status, category] of cases) {
    const err = classifyHttpStatus(status);
    assert.equal(err.category, category, `HTTP ${status}`);
    assert.equal(err.httpStatus, status);
  }
});

test('Retry-After : secondes, date HTTP, valeurs illisibles', () => {
  assert.equal(parseRetryAfter('120', 0), 120_000);
  const now = Date.parse('2026-09-28T12:00:00Z');
  assert.equal(parseRetryAfter('Mon, 28 Sep 2026 12:01:00 GMT', now), 60_000);
  assert.equal(parseRetryAfter('bientôt', now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
  assert.equal(classifyHttpStatus(429, { headers: { 'retry-after': '30' } }).retryAfterMs, 30_000);
  assert.equal(classifyHttpStatus(503, { headers: new Headers({ 'Retry-After': '7' }) }).retryAfterMs, 7_000);
});

test('erreurs levées : timeout, réseau, inconnue', () => {
  const abort = new Error('aborted'); abort.name = 'AbortError';
  assert.equal(toRushourError(abort).category, ErrorCategory.TIMEOUT);
  assert.equal(toRushourError(new TypeError('fetch failed')).category, ErrorCategory.RETRYABLE);
  const unknown = toRushourError(new Error('Bearer abc.def secret'));
  assert.equal(unknown.category, ErrorCategory.UNKNOWN);
  assert.doesNotMatch(unknown.message, /Bearer|secret/, 'le message brut n’est pas recopié');
  const own = new RushourError(ErrorCategory.MAPPING_ERROR, 'X', 'x');
  assert.equal(toRushourError(own), own);
  assert.throws(() => new RushourError('NOPE', 'X', 'x'), TypeError);
});

test('S. politique de retry : 5 s, 30 s, 2 min, 10 min puis FAILED', () => {
  const delays = [1, 2, 3, 4].map(attempt => decideRetry({ category: ErrorCategory.RETRYABLE, attempt }));
  assert.deepEqual(delays.map(d => d.delaySeconds), [5, 30, 120, 600]);
  assert.deepEqual(decideRetry({ category: ErrorCategory.RETRYABLE, attempt: 5 }), { action: 'FAIL', reason: 'MAX_ATTEMPTS_REACHED' });
  assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 5);
});

test('S. politique de retry : catégories non rejouables', () => {
  for (const category of [ErrorCategory.NON_RETRYABLE, ErrorCategory.MAPPING_ERROR,
    ErrorCategory.VALIDATION_ERROR, ErrorCategory.UNKNOWN]) {
    assert.deepEqual(decideRetry({ category, attempt: 1 }), { action: 'FAIL', reason: 'NOT_RETRYABLE' }, category);
  }
  for (const category of [ErrorCategory.RETRYABLE, ErrorCategory.TIMEOUT, ErrorCategory.RATE_LIMIT, ErrorCategory.AUTH_ERROR]) {
    assert.equal(decideRetry({ category, attempt: 1 }).action, 'RETRY', category);
  }
});

test('S. Retry-After respecté, plafonné à 1 h ; AUTH_ERROR espacé', () => {
  assert.equal(decideRetry({ category: ErrorCategory.RATE_LIMIT, attempt: 1, retryAfterMs: 90_000 }).delaySeconds, 90);
  assert.equal(decideRetry({ category: ErrorCategory.RATE_LIMIT, attempt: 3, retryAfterMs: 1_000 }).delaySeconds, 120,
    'jamais plus court que la politique');
  assert.equal(decideRetry({ category: ErrorCategory.RATE_LIMIT, attempt: 1, retryAfterMs: 86_400_000 }).delaySeconds, 3600);
  assert.equal(decideRetry({ category: ErrorCategory.AUTH_ERROR, attempt: 1 }).delaySeconds, 600);
  assert.throws(() => decideRetry({ category: ErrorCategory.RETRYABLE, attempt: 0 }), RangeError);
});

test('mock : couvre les 10 comportements demandés + aucun accès réseau', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK FORBIDDEN IN MOCK'); };
  try {
    const expected = {
      success: 'ok', duplicate: 'ok', http_400: ErrorCategory.NON_RETRYABLE, http_401: ErrorCategory.AUTH_ERROR,
      http_409: ErrorCategory.NON_RETRYABLE, http_429: ErrorCategory.RATE_LIMIT, http_500: ErrorCategory.RETRYABLE,
      timeout: ErrorCategory.TIMEOUT, timeout_after_accept: ErrorCategory.TIMEOUT,
      network: ErrorCategory.RETRYABLE, invalid_response: ErrorCategory.UNKNOWN
    };
    assert.deepEqual(Object.keys(expected).sort(), [...MOCK_SCENARIOS].sort());
    for (const [scenario, outcome] of Object.entries(expected)) {
      const client = new RushourMockClient({ scenarios: [scenario] });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      const request = { destination: { integrationId: 'x' }, payload: {}, exportKey: 'fdt1_0123456789abcdef0123456789abcdef', signal: controller.signal };
      if (outcome === 'ok') {
        const result = await client.sendOrder(request);
        assert.equal(result.duplicate, scenario === 'duplicate', scenario);
      } else {
        await assert.rejects(() => client.sendOrder(request), err => err.category === outcome, scenario);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mock : un timeout sans signal est refusé (un worker ne peut jamais rester bloqué)', async () => {
  const client = new RushourMockClient({ scenarios: ['timeout'] });
  await assert.rejects(() => client.sendOrder({ destination: {}, payload: {}, exportKey: 'fdt1_x' }),
    { code: 'MISSING_ABORT_SIGNAL' });
  assert.throws(() => new RushourMockClient({ scenarios: ['nope'] }), TypeError);
});

test('contrat client : réponses invalides rejetées', () => {
  assert.deepEqual(validateSendResult({ externalOrderId: 'rh-1' }), { externalOrderId: 'rh-1', duplicate: false });
  for (const bad of [null, 'ok', [], { externalOrderId: 'bad id' }, { duplicate: 'yes' }]) {
    assert.throws(() => validateSendResult(bad), { code: 'INVALID_RESPONSE' });
  }
});

test('client HTTP réel : désactivé tant que le schéma RusHour n’est pas vérifié', () => {
  assert.throws(() => new RushourHttpClient(), { code: 'REAL_CLIENT_DISABLED' });
});
