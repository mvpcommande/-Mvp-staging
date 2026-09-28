/**
 * Classification des erreurs du connecteur RusHour.
 *
 * Toute erreur qui sort du connecteur (mapping, config, transport) est une
 * RushourError portant une catégorie explicite : c'est la catégorie, et
 * elle seule, qui décide du retry (voir retryPolicy.mjs). Aucune décision
 * n'est prise sur le texte d'un message.
 *
 * ATTENTION : la sémantique des codes HTTP côté RusHour n'est PAS
 * documentée publiquement (portail developers.rushour.io non consultable
 * depuis cet environnement, cf. docs/RUSHOUR_CONNECTOR.md § UNKNOWN). Le
 * mapping HTTP -> catégorie ci-dessous est la convention HTTP standard,
 * à reconfirmer en Bloc 2 contre la documentation officielle.
 */

export const ErrorCategory = Object.freeze({
  RETRYABLE: 'RETRYABLE',
  NON_RETRYABLE: 'NON_RETRYABLE',
  AUTH_ERROR: 'AUTH_ERROR',
  MAPPING_ERROR: 'MAPPING_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN'
});

const CATEGORIES = new Set(Object.values(ErrorCategory));

export class RushourError extends Error {
  /**
   * @param {string} category  une valeur de ErrorCategory
   * @param {string} code      code machine stable (ex: PRODUCT_NOT_MAPPED)
   * @param {string} message   message lisible, SANS donnée sensible
   * @param {{ httpStatus?: number, retryAfterMs?: number|null, details?: object }} [extra]
   */
  constructor(category, code, message, extra = {}) {
    super(message);
    if (!CATEGORIES.has(category)) {
      throw new TypeError(`Unknown RusHour error category: ${category}`);
    }
    this.name = 'RushourError';
    this.category = category;
    this.code = code;
    this.httpStatus = extra.httpStatus ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.details = extra.details ?? null;
  }
}

export const mappingError = (code, message, details) =>
  new RushourError(ErrorCategory.MAPPING_ERROR, code, message, { details });

export const validationError = (code, message, details) =>
  new RushourError(ErrorCategory.VALIDATION_ERROR, code, message, { details });

/**
 * Lit un en-tête Retry-After (secondes entières ou date HTTP, RFC 9110).
 * Retourne un délai en ms, ou null si absent/illisible. `nowMs` est
 * injecté pour rester déterministe en test.
 */
export function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date) || typeof nowMs !== 'number') return null;
  return Math.max(0, date - nowMs);
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/**
 * Traduit une réponse HTTP non-2xx en RushourError catégorisée.
 *
 * 409 : sémantique RusHour UNKNOWN (doublon ? conflit d'état ?). Par
 * prudence on ne rejoue pas aveuglément : NON_RETRYABLE, revue humaine.
 */
export function classifyHttpStatus(status, { headers = null, nowMs } = {}) {
  const retryAfterMs = parseRetryAfter(readHeader(headers, 'retry-after'), nowMs);
  const extra = { httpStatus: status, retryAfterMs };

  if (status === 401 || status === 403) {
    return new RushourError(ErrorCategory.AUTH_ERROR, `HTTP_${status}`,
      'RusHour a refusé les identifiants (configuration/credentials à vérifier)', extra);
  }
  if (status === 429) {
    return new RushourError(ErrorCategory.RATE_LIMIT, 'HTTP_429',
      'RusHour limite le débit (rate limit)', extra);
  }
  if (status === 408) {
    return new RushourError(ErrorCategory.TIMEOUT, 'HTTP_408', 'RusHour a expiré la requête', extra);
  }
  if (status === 409) {
    return new RushourError(ErrorCategory.NON_RETRYABLE, 'HTTP_409',
      'Conflit RusHour (sémantique non confirmée) : revue manuelle requise', extra);
  }
  if (status >= 500 && status <= 599) {
    return new RushourError(ErrorCategory.RETRYABLE, `HTTP_${status}`,
      'Erreur serveur RusHour', extra);
  }
  if (status >= 400 && status <= 499) {
    return new RushourError(ErrorCategory.NON_RETRYABLE, `HTTP_${status}`,
      'Requête refusée par RusHour (payload ou mapping à corriger)', extra);
  }
  return new RushourError(ErrorCategory.UNKNOWN, `HTTP_${status}`,
    'Statut HTTP inattendu', extra);
}

/**
 * Normalise n'importe quelle valeur levée en RushourError. Les erreurs
 * déjà catégorisées passent telles quelles.
 */
export function toRushourError(err) {
  if (err instanceof RushourError) return err;

  const name = err && typeof err === 'object' ? err.name : null;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new RushourError(ErrorCategory.TIMEOUT, 'TIMEOUT', 'Délai dépassé en attendant RusHour');
  }
  // fetch() lève un TypeError sur échec réseau (DNS, connexion refusée...).
  if (err instanceof TypeError) {
    return new RushourError(ErrorCategory.RETRYABLE, 'NETWORK_UNREACHABLE', 'RusHour injoignable (réseau)');
  }
  return new RushourError(ErrorCategory.UNKNOWN, 'UNEXPECTED_ERROR', 'Erreur inattendue du connecteur');
}
