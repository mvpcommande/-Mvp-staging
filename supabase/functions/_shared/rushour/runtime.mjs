/**
 * Configuration d'exécution de l'Edge Function, à partir de l'environnement.
 *
 * MODES :
 * - mock (DÉFAUT) : RushourMockClient, zéro réseau. RUSHOUR_APP_ID /
 *   RUSHOUR_APP_SECRET ne sont même pas lus, même s'ils sont présents.
 * - live : RushourHttpClient, UNIQUEMENT si TOUS les verrous sont levés :
 *     1. projet Supabase = staging autorisé (jamais la production) ;
 *     2. profil d'API ET schéma de payload RusHour vérifiés (Bloc 2 :
 *        ils ne le sont pas -> live impossible) ;
 *     3. RUSHOUR_APP_ID + RUSHOUR_APP_SECRET présents (secrets serveur) ;
 *     4. le client n'accepte que les destinations target_environment='test'.
 *   Tout verrou manquant -> 503, aucun appel réseau (fail closed).
 * Aucune autre valeur de RUSHOUR_MODE n'est acceptée.
 */

import { RushourMockClient, MOCK_SCENARIOS } from './mockClient.mjs';
import { RushourHttpClient } from './httpClient.mjs';
import { RUSHOUR_API_PROFILE } from './apiProfile.mjs';
import { RUSHOUR_PAYLOAD_SCHEMA } from './mapper.mjs';

export const SUPPORTED_MODES = Object.freeze(['mock', 'live']);

// Bloc 2 : le seul projet autorisé à parler à la VRAIE API RusHour est le
// staging Foodatoi. Ouvrir la production = modification de code revue.
export const LIVE_ALLOWED_PROJECT_REFS = Object.freeze(['kkhlpeqherxfdnilewkp']);
export const PRODUCTION_PROJECT_REFS = Object.freeze(['ffuykessameuonpnyiyc']);
export const LIVE_ALLOWED_TARGETS = Object.freeze(['test']);

export function projectRefFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.split('.')[0] : null;
  } catch {
    return null;
  }
}

const liveClients = new Map();
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

function resolveLiveRuntime(getEnv, { profile, payloadSchema, fetchImpl }) {
  const ref = projectRefFromUrl(getEnv('SUPABASE_URL'));
  if (ref !== null && PRODUCTION_PROJECT_REFS.includes(ref)) {
    throw new RuntimeConfigError('live_forbidden_on_production', 503);
  }
  if (ref === null || !LIVE_ALLOWED_PROJECT_REFS.includes(ref)) {
    throw new RuntimeConfigError('live_project_not_allowed', 503);
  }
  if (profile?.verified !== true || payloadSchema?.verified !== true) {
    throw new RuntimeConfigError('live_profile_unverified', 503);
  }
  const appId = getEnv('RUSHOUR_APP_ID');
  const appSecret = getEnv('RUSHOUR_APP_SECRET');
  if (!appId || !appSecret) {
    throw new RuntimeConfigError('live_credentials_missing', 503);
  }
  const timeoutMs = parseTimeout(getEnv('RUSHOUR_SEND_TIMEOUT_MS'));
  const key = `${profile.id}|${appId}`;
  if (!liveClients.has(key)) {
    liveClients.set(key, new RushourHttpClient({
      profile, appId, appSecret, fetchImpl,
      allowedTargets: [...LIVE_ALLOWED_TARGETS],
      // Le client coupe AVANT le délai du dispatcher : c'est lui qui qualifie
      // l'ambiguïté (UNCERTAIN) avec le code le plus précis.
      timeoutMs: Math.max(500, Math.min(timeoutMs - 1000, 8000))
    }));
  }
  return { mode: 'live', client: liveClients.get(key), timeoutMs, scenarios: [] };
}

/**
 * @param {(name: string) => string|undefined} getEnv
 * @param {{ profile?: object, payloadSchema?: object, fetchImpl?: typeof fetch }} [overrides]
 *   réservé aux tests : le runtime de l'Edge Function utilise les profils
 *   committés (non vérifiés au Bloc 2).
 */
export function resolveRuntime(getEnv, overrides = {}) {
  const mode = getEnv('RUSHOUR_MODE') ?? 'mock';
  if (!SUPPORTED_MODES.includes(mode)) {
    throw new RuntimeConfigError('unsupported_mode', 503);
  }
  if (mode === 'live') {
    return resolveLiveRuntime(getEnv, {
      profile: overrides.profile ?? RUSHOUR_API_PROFILE,
      payloadSchema: overrides.payloadSchema ?? RUSHOUR_PAYLOAD_SCHEMA,
      fetchImpl: overrides.fetchImpl ?? globalThis.fetch
    });
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

/**
 * Autorisation du dispatcher. Deux sources de vérité possibles :
 * 1. RUSHOUR_DISPATCH_SECRET dans les secrets de l'Edge Function
 *    (comparaison à temps constant) ;
 * 2. à défaut, le secret Vault 'rushour_dispatch_secret' de la base,
 *    vérifié par la RPC rushour_verify_dispatch_secret (service_role
 *    uniquement, comparaison d'empreintes sha256). C'est la même source
 *    que lit pg_cron/pg_net : un seul secret, jamais exposé.
 *
 * @param {{ getEnv: Function, providedSecret: string|null,
 *           verifyWithDb: (candidate: string) => Promise<boolean|null> }} input
 * @returns {Promise<null | { error: string, status: number }>}
 */
export async function authorizeDispatch({ getEnv, providedSecret, verifyWithDb }) {
  const envSecret = getEnv('RUSHOUR_DISPATCH_SECRET');
  if (envSecret !== undefined && envSecret !== null && envSecret !== '') {
    return checkDispatchAuth(getEnv, providedSecret);
  }
  if (typeof providedSecret !== 'string' || providedSecret.length < MIN_DISPATCH_SECRET_LENGTH) {
    return { error: 'unauthorized', status: 401 };
  }
  let verdict;
  try {
    verdict = await verifyWithDb(providedSecret);
  } catch {
    return { error: 'dispatcher_not_configured', status: 503 };
  }
  if (verdict === true) return null;
  if (verdict === false) return { error: 'unauthorized', status: 401 };
  return { error: 'dispatcher_not_configured', status: 503 };
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
