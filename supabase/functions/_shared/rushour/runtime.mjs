/**
 * Configuration d'exécution de l'Edge Function, à partir de l'environnement.
 *
 * GARDE-FOU (Bloc 1.1) : RUSHOUR_MODE=mock force le RushourMockClient,
 * même si RUSHOUR_APP_ID / RUSHOUR_APP_SECRET (ou toute autre variable)
 * sont présents par erreur. Ce module ne lit JAMAIS ces variables et
 * n'importe pas RushourHttpClient : aucun chemin de code ne peut
 * atteindre l'API RusHour depuis cette version.
 */

import { RushourMockClient, MOCK_SCENARIOS } from './mockClient.mjs';

export const SUPPORTED_MODES = Object.freeze(['mock']);
export const MIN_DISPATCH_SECRET_LENGTH = 32;

// Un client mock par configuration et par isolate : l'état "côté RusHour
// simulé" (commandes acceptées, séquence de scénarios) survit entre deux
// invocations servies par le même isolate. Supabase recycle les isolates :
// c'est un confort de test, pas une garantie (cf. docs, UNKNOWN RusHour).
const mockClients = new Map();

export class RuntimeConfigError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.status = status;
  }
}

function parseScenarios(raw) {
  const scenarios = String(raw ?? 'success').split(',').map(s => s.trim()).filter(Boolean);
  if (scenarios.length === 0 || scenarios.some(s => !MOCK_SCENARIOS.includes(s))) {
    throw new RuntimeConfigError('invalid_mock_scenario', 500);
  }
  return scenarios;
}

function parseTimeout(raw) {
  if (raw === undefined || raw === null || raw === '') return 10_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 500 || value > 15_000) {
    throw new RuntimeConfigError('invalid_send_timeout', 500);
  }
  return value;
}

function parseRetryAfterSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3600) {
    throw new RuntimeConfigError('invalid_mock_retry_after', 500);
  }
  return value;
}

/**
 * @param {(name: string) => string|undefined} getEnv
 * @returns {{ mode: 'mock', client: RushourMockClient, timeoutMs: number, scenarios: string[] }}
 */
export function resolveRuntime(getEnv) {
  const mode = getEnv('RUSHOUR_MODE') ?? 'mock';
  if (!SUPPORTED_MODES.includes(mode)) {
    throw new RuntimeConfigError('real_mode_not_available', 503);
  }
  const scenarios = parseScenarios(getEnv('RUSHOUR_MOCK_SCENARIO'));
  const timeoutMs = parseTimeout(getEnv('RUSHOUR_SEND_TIMEOUT_MS'));
  const retryAfterSeconds = parseRetryAfterSeconds(getEnv('RUSHOUR_MOCK_RETRY_AFTER_SECONDS'));

  const key = `${scenarios.join(',')}|${retryAfterSeconds}`;
  if (!mockClients.has(key)) {
    mockClients.set(key, new RushourMockClient({ scenarios, retryAfterSeconds, nowMs: () => Date.now() }));
  }
  return { mode, client: mockClients.get(key), timeoutMs, scenarios };
}

// Comparaison à temps constant (pas de fuite par timing du secret).
export function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Retourne null si autorisé, sinon { error, status }. */
export function checkDispatchAuth(getEnv, providedSecret) {
  const expected = getEnv('RUSHOUR_DISPATCH_SECRET') ?? '';
  if (expected.length < MIN_DISPATCH_SECRET_LENGTH) {
    return { error: 'dispatcher_not_configured', status: 503 };
  }
  if (!safeEqual(providedSecret ?? '', expected)) {
    return { error: 'unauthorized', status: 401 };
  }
  return null;
}
