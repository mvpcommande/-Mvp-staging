/**
 * RushourHttpClient : implémentation RÉELLE du contrat client.mjs.
 *
 * - Refuse de s'instancier si le profil d'API n'est pas vérifié
 *   (apiProfile.mjs) : aucun appel live possible tant que la
 *   documentation RusHour actuelle n'a pas été validée.
 * - Refuse toute destination hors `allowedTargets` (Bloc 2 : 'test').
 * - Token d'intégration obtenu côté serveur, mis en cache en mémoire par
 *   integrationId (renouvellement anticipé, single-flight), jamais
 *   persisté, jamais journalisé.
 * - Chaque requête a un timeout explicite.
 * - Ambiguïté (la commande a PEUT-ÊTRE été créée) : timeout ou coupure
 *   après émission du POST, réponse 2xx illisible -> UNCERTAIN (aucun
 *   rejeu automatique) tant que profile.dedupOnExternalId est false.
 * - 401 sur la commande : un seul renouvellement + une seule nouvelle
 *   tentative, et uniquement si profile.refreshTokenOn401 est true.
 * - Aucun message d'erreur ne contient d'en-tête, de token, de secret ni le
 *   corps de réponse (qui peut contenir des données personnelles).
 */

import { RushourError, ErrorCategory, classifyHttpStatus } from './errors.mjs';
import { validateSendResult } from './client.mjs';
import { isValidExternalId } from './config.mjs';
import { buildUrl, assertProfileShape } from './apiProfile.mjs';

export const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const uncertain = (code, message, extra) => new RushourError(ErrorCategory.UNCERTAIN, code, message, extra);

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function combinedSignal(outer, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

async function readJson(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new SyntaxError('response too large');
  return text === '' ? null : JSON.parse(text);
}

const isAbort = err => err && (err.name === 'AbortError' || err.name === 'TimeoutError');

export class RushourHttpClient {
  /**
   * @param {{
   *   profile: object, appId: string, appSecret: string,
   *   fetchImpl?: typeof fetch, nowMs?: () => number,
   *   allowedTargets?: string[], timeoutMs?: number
   * }} options
   */
  constructor({ profile, appId, appSecret, fetchImpl = globalThis.fetch, nowMs = () => Date.now(),
    allowedTargets = ['test'], timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
    if (!profile || profile.verified !== true) {
      throw new RushourError(ErrorCategory.NON_RETRYABLE, 'REAL_CLIENT_DISABLED',
        'Client RusHour réel désactivé : profil d’API non vérifié');
    }
    assertProfileShape(profile);
    if (typeof appId !== 'string' || appId.length === 0 || typeof appSecret !== 'string' || appSecret.length === 0) {
      throw new RushourError(ErrorCategory.AUTH_ERROR, 'MISSING_CREDENTIALS', 'Identifiants RusHour absents');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15_000) {
      throw new TypeError('timeoutMs doit être compris entre 500 et 15000');
    }
    this._profile = profile;
    this._fetch = fetchImpl;
    this._now = nowMs;
    this._allowedTargets = new Set(allowedTargets);
    this._timeoutMs = timeoutMs;
    this._tokens = new Map();
    this._inflight = new Map();
    // Propriétés non énumérables : jamais sérialisées par accident.
    Object.defineProperty(this, '_appId', { value: appId, enumerable: false });
    Object.defineProperty(this, '_basic', { value: `Basic ${base64(`${appId}:${appSecret}`)}`, enumerable: false });
  }

  /** true seulement si RusHour garantit la déduplication (documentation). */
  get idempotencyGuaranteed() {
    return this._profile.dedupOnExternalId === true;
  }

  toJSON() {
    return { client: 'RushourHttpClient', profile: this._profile.id };
  }

  invalidateToken(integrationId) {
    this._tokens.delete(integrationId);
  }

  async _getToken(integrationId, signal) {
    const cached = this._tokens.get(integrationId);
    const marginMs = this._profile.tokenSafetyMarginSeconds * 1000;
    if (cached && this._now() < cached.expiresAtMs - marginMs) return cached.token;

    // Single-flight : les demandes simultanées partagent la même requête.
    if (!this._inflight.has(integrationId)) {
      const pending = this._fetchToken(integrationId, signal)
        .finally(() => this._inflight.delete(integrationId));
      this._inflight.set(integrationId, pending);
    }
    return this._inflight.get(integrationId);
  }

  async _fetchToken(integrationId, signal) {
    const spec = this._profile.token;
    const url = buildUrl(this._profile.baseUrl, spec.path, { appId: this._appId, integrationId });
    let response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers: { Authorization: this._basic, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(spec.body ?? {}),
        signal: combinedSignal(signal, this._timeoutMs)
      });
    } catch (err) {
      // Aucune commande n'a été émise : un échec du token est toujours sûr à rejouer.
      if (isAbort(err)) throw new RushourError(ErrorCategory.TIMEOUT, 'TOKEN_TIMEOUT', 'Délai dépassé (token RusHour)');
      throw new RushourError(ErrorCategory.RETRYABLE, 'TOKEN_NETWORK_ERROR', 'RusHour injoignable (token)');
    }

    if (!response.ok) {
      const err = classifyHttpStatus(response.status, { headers: response.headers, nowMs: this._now() });
      err.code = `TOKEN_${err.code}`;
      throw err;
    }

    let body;
    try {
      body = await readJson(response);
    } catch {
      throw new RushourError(ErrorCategory.RETRYABLE, 'TOKEN_INVALID_RESPONSE', 'Réponse token RusHour illisible');
    }
    const token = body?.[spec.accessTokenField];
    const expiresIn = body?.[spec.expiresInField];
    const type = body?.[spec.tokenTypeField];
    if (typeof token !== 'string' || token.length === 0 || !Number.isFinite(expiresIn) || expiresIn <= 0
      || (spec.expectedTokenType && String(type).toLowerCase() !== spec.expectedTokenType.toLowerCase())) {
      throw new RushourError(ErrorCategory.RETRYABLE, 'TOKEN_INVALID_RESPONSE', 'Réponse token RusHour invalide');
    }
    this._tokens.set(integrationId, { token, expiresAtMs: this._now() + expiresIn * 1000 });
    return token;
  }

  async _postOrder(url, token, payload, signal) {
    try {
      return await this._fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: combinedSignal(signal, this._timeoutMs)
      });
    } catch (err) {
      const guaranteed = this.idempotencyGuaranteed;
      if (isAbort(err)) {
        throw guaranteed
          ? new RushourError(ErrorCategory.TIMEOUT, 'TIMEOUT', 'Délai dépassé en attendant RusHour')
          : uncertain('ORDER_TIMEOUT_AMBIGUOUS', 'Timeout après émission de la commande : existence côté RusHour à vérifier');
      }
      throw guaranteed
        ? new RushourError(ErrorCategory.RETRYABLE, 'NETWORK_UNREACHABLE', 'RusHour injoignable (réseau)')
        : uncertain('ORDER_NETWORK_AMBIGUOUS', 'Coupure réseau pendant l’envoi : existence côté RusHour à vérifier');
    }
  }

  async sendOrder({ destination, payload, exportKey, signal }) {
    if (!destination || !this._allowedTargets.has(destination.targetEnvironment)) {
      throw new RushourError(ErrorCategory.NON_RETRYABLE, 'LIVE_TARGET_NOT_ALLOWED',
        'Destination RusHour non autorisée pour ce client');
    }
    if (!isValidExternalId(destination.integrationId) || typeof exportKey !== 'string') {
      throw new RushourError(ErrorCategory.VALIDATION_ERROR, 'INVALID_DESTINATION', 'Destination RusHour invalide');
    }
    const url = buildUrl(this._profile.baseUrl, this._profile.order.path,
      { appId: this._appId, integrationId: destination.integrationId });

    let token = await this._getToken(destination.integrationId, signal);
    let response = await this._postOrder(url, token, payload, signal);

    if (response.status === 401 && this._profile.refreshTokenOn401) {
      // UN seul renouvellement + UNE seule nouvelle tentative : jamais de boucle.
      this.invalidateToken(destination.integrationId);
      token = await this._getToken(destination.integrationId, signal);
      response = await this._postOrder(url, token, payload, signal);
    }

    if (!response.ok) {
      if (response.status === 401) this.invalidateToken(destination.integrationId);
      throw classifyHttpStatus(response.status, { headers: response.headers, nowMs: this._now() });
    }

    let body;
    try {
      body = await readJson(response);
    } catch {
      body = undefined;
    }
    const field = this._profile.order.externalIdField;
    const bodyValid = body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body)
      && (field === null || isValidExternalId(body[field]));
    if (!bodyValid) {
      throw this.idempotencyGuaranteed
        ? new RushourError(ErrorCategory.UNKNOWN, 'INVALID_RESPONSE', 'Réponse RusHour illisible')
        : uncertain('ORDER_RESPONSE_INVALID', 'Réponse 2xx illisible : existence côté RusHour à vérifier',
          { httpStatus: response.status });
    }
    return validateSendResult({ externalOrderId: field === null ? null : body[field], duplicate: false });
  }
}
