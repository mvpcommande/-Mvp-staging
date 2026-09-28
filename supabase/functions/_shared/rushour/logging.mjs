/**
 * Journalisation du connecteur RusHour (table rushour_sync_events,
 * écrite UNIQUEMENT par le worker serveur - pas client_error_logs, qui
 * est inscriptible par anon et lisible par le navigateur).
 *
 * Un événement dit : quel restaurant, quelle commande, quelle étape,
 * quel type d'erreur, quelle tentative, quand. Il ne contient JAMAIS :
 * payload, appSecret, access/refresh token, en-tête Authorization,
 * donnée carte. Défense en profondeur : même si un message d'erreur
 * contenait un secret, redact() le masque avant écriture.
 */

export const SYNC_STEP = Object.freeze({
  CLAIM: 'CLAIM',
  RESOLVE_CONFIG: 'RESOLVE_CONFIG',
  MAP: 'MAP',
  SEND: 'SEND',
  COMPLETE: 'COMPLETE'
});

export const MAX_LOG_MESSAGE_LENGTH = 500;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_RE =
  /(secret|token|authorization|password|passwd|api[-_]?key|apikey|cookie|card|cvv|cvc|iban|(^|[-_])pan($|[-_]))/i;

const STRING_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/gi, `Basic ${REDACTED}`],
  [/\b([A-Za-z_]*(?:token|secret|password))\s*[=:]\s*["']?[^\s"'&,}]+/gi, `$1=${REDACTED}`],
  // Numéros de carte (13 à 19 chiffres, séparateurs espace/tiret).
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[REDACTED_PAN]'],
  // JWT (header.payload.signature).
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED]
];

export function redactString(value, maxLength = MAX_LOG_MESSAGE_LENGTH) {
  let out = String(value);
  for (const [pattern, replacement] of STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

/** Copie profonde masquée (clés sensibles + motifs dans les chaînes). */
export function redact(value, depth = 0) {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Construit une ligne rushour_sync_events à partir d'une entrée outbox
 * et d'une éventuelle RushourError. Liste blanche de champs : rien
 * d'autre ne peut fuiter.
 */
export function buildSyncEvent({ entry, step, outcome, error = null, message = null }) {
  return {
    outbox_id: entry?.id ?? null,
    restaurant_id: entry?.restaurantId ?? null,
    order_id: entry?.orderId ?? null,
    step,
    outcome,
    attempt: entry?.attempts ?? null,
    error_category: error?.category ?? null,
    error_code: error?.code ?? null,
    http_status: error?.httpStatus ?? null,
    message: message !== null ? redactString(message) : error ? redactString(error.message) : null
  };
}
