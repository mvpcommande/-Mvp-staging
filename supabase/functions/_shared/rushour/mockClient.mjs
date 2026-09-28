/**
 * RushourMockClient : implémentation du contrat client.mjs SANS AUCUN
 * RÉSEAU. Sert aux tests et au mode "mock" de l'Edge Function.
 *
 * Scénarios (un par appel, dans l'ordre ; le dernier se répète) :
 *   success | duplicate | http_400 | http_401 | http_409 | http_429 |
 *   http_500 | timeout | timeout_after_accept | network | invalid_response
 *
 * Le mock simule aussi un RusHour qui déduplique sur la clé d'export
 * (hypothèse UNKNOWN pour le vrai RusHour, cf. docs) : `acceptedOrders`
 * compte les commandes logiques réellement "créées" côté destination,
 * ce qui permet de PROUVER en test qu'une commande rejouée N fois ne
 * produit qu'un seul export logique.
 *
 * Les erreurs HTTP passent par classifyHttpStatus(), exactement comme le
 * fera le client HTTP réel : la classification testée ici est celle de
 * la production.
 */

import { classifyHttpStatus, toRushourError, RushourError, ErrorCategory } from './errors.mjs';
import { validateSendResult } from './client.mjs';

export const MOCK_SCENARIOS = Object.freeze([
  'success', 'duplicate', 'http_400', 'http_401', 'http_409', 'http_429',
  'http_500', 'timeout', 'timeout_after_accept', 'network', 'invalid_response'
]);

const HTTP_SCENARIOS = { http_400: 400, http_401: 401, http_409: 409, http_429: 429, http_500: 500 };

const mockExternalId = exportKey => `mock_${exportKey.slice(5, 21)}`;

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function waitForAbort(signal) {
  if (!signal) {
    // Sans signal, un "timeout" bloquerait le worker indéfiniment : c'est
    // précisément le bug que le dispatcher doit rendre impossible.
    return Promise.reject(new RushourError(ErrorCategory.VALIDATION_ERROR, 'MISSING_ABORT_SIGNAL',
      'Appel client sans signal de timeout'));
  }
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

export class RushourMockClient {
  /**
   * @param {{ scenarios?: string[], retryAfterSeconds?: number|null, nowMs?: () => number }} [options]
   */
  constructor({ scenarios = ['success'], retryAfterSeconds = null, nowMs = () => 0 } = {}) {
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      throw new TypeError('scenarios doit être une liste non vide');
    }
    for (const s of scenarios) {
      if (!MOCK_SCENARIOS.includes(s)) throw new TypeError(`Scénario mock inconnu : ${s}`);
    }
    this._scenarios = [...scenarios];
    this._retryAfterSeconds = retryAfterSeconds;
    this._nowMs = nowMs;
    this.calls = [];
    this.acceptedOrders = new Map();
  }

  get callCount() {
    return this.calls.length;
  }

  _nextScenario() {
    const index = Math.min(this.calls.length - 1, this._scenarios.length - 1);
    return this._scenarios[index];
  }

  _accept(exportKey) {
    const already = this.acceptedOrders.has(exportKey);
    if (!already) this.acceptedOrders.set(exportKey, mockExternalId(exportKey));
    return { externalOrderId: this.acceptedOrders.get(exportKey), duplicate: already };
  }

  async sendOrder({ destination, payload, exportKey, signal }) {
    this.calls.push({
      integrationId: destination?.integrationId ?? null,
      exportKey,
      payload: JSON.parse(JSON.stringify(payload))
    });
    const scenario = this._nextScenario();

    try {
      if (scenario in HTTP_SCENARIOS) {
        const headers = this._retryAfterSeconds === null ? {} : { 'Retry-After': String(this._retryAfterSeconds) };
        throw classifyHttpStatus(HTTP_SCENARIOS[scenario], { headers, nowMs: this._nowMs() });
      }

      switch (scenario) {
        case 'success':
        case 'duplicate':
          // "duplicate" : RusHour répond que la commande existe déjà (même
          // clé). On le simule en pré-acceptant la clé.
          if (scenario === 'duplicate' && !this.acceptedOrders.has(exportKey)) {
            this.acceptedOrders.set(exportKey, mockExternalId(exportKey));
          }
          return validateSendResult(this._accept(exportKey));
        case 'timeout':
          return await waitForAbort(signal);
        case 'timeout_after_accept':
          // Cas ambigu réel : la commande est arrivée, la réponse s'est perdue.
          this._accept(exportKey);
          return await waitForAbort(signal);
        case 'network':
          throw new TypeError('fetch failed');
        case 'invalid_response':
          return validateSendResult('<html>502 Bad Gateway</html>');
        default:
          throw new TypeError(`Scénario mock inconnu : ${scenario}`);
      }
    } catch (err) {
      throw toRushourError(err);
    }
  }
}
