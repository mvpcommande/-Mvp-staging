/**
 * Politique de retry DÉTERMINISTE et BORNÉE de l'export RusHour.
 *
 *   échec tentative 1 -> retry dans 5 s
 *   échec tentative 2 -> retry dans 30 s
 *   échec tentative 3 -> retry dans 2 min
 *   échec tentative 4 -> retry dans 10 min
 *   échec tentative 5 -> FAILED (revue humaine, requeue explicite)
 *
 * - Retry-After (429, et 5xx s'il est fourni) est respecté : on attend
 *   max(délai de la politique, Retry-After), plafonné à 1 h ;
 * - AUTH_ERROR : pas de martèlement - attente d'au moins 10 min pour
 *   laisser le temps de corriger les credentials, toujours bornée ;
 * - VALIDATION / MAPPING / NON_RETRYABLE / UNKNOWN : aucun retry
 *   aveugle (UNKNOWN couvre notamment une réponse 2xx illisible : la
 *   commande a PEUT-ÊTRE été créée, la rejouer risquerait un doublon en
 *   cuisine -> revue humaine).
 *
 * Pas de jitter : le délai ne dépend que de (catégorie, tentative,
 * Retry-After). La base plafonne de toute façon attempts <= max_attempts
 * (rushour_mark_failed), donc aucune boucle infinie n'est possible même
 * si cette fonction était mal appelée.
 */

import { ErrorCategory } from './errors.mjs';

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 5,
  delaysSeconds: Object.freeze([5, 30, 120, 600]),
  maxRetryAfterSeconds: 3600,
  authErrorMinDelaySeconds: 600
});

const RETRY_CATEGORIES = new Set([
  ErrorCategory.RETRYABLE,
  ErrorCategory.TIMEOUT,
  ErrorCategory.RATE_LIMIT,
  ErrorCategory.AUTH_ERROR
]);

export const isRetryableCategory = category => RETRY_CATEGORIES.has(category);

/**
 * @param {{ category: string, attempt: number, maxAttempts?: number, retryAfterMs?: number|null }} input
 *   attempt = numéro (1-based) de la tentative qui vient d'échouer.
 * @returns {{ action: 'RETRY', delaySeconds: number } | { action: 'FAIL' | 'UNCERTAIN', reason: string }}
 */
export function decideRetry({ category, attempt, maxAttempts, retryAfterMs = null }, policy = DEFAULT_RETRY_POLICY) {
  const max = maxAttempts ?? policy.maxAttempts;

  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt doit être un entier >= 1');
  }
  if (category === ErrorCategory.UNCERTAIN) {
    return { action: 'UNCERTAIN', reason: 'COMPLETION_UNCERTAIN' };
  }
  if (!isRetryableCategory(category)) {
    return { action: 'FAIL', reason: 'NOT_RETRYABLE' };
  }
  if (attempt >= max) {
    return { action: 'FAIL', reason: 'MAX_ATTEMPTS_REACHED' };
  }

  const steps = policy.delaysSeconds;
  let delaySeconds = steps[Math.min(attempt - 1, steps.length - 1)];

  if (category === ErrorCategory.AUTH_ERROR) {
    delaySeconds = Math.max(delaySeconds, policy.authErrorMinDelaySeconds);
  }

  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    delaySeconds = Math.max(delaySeconds, Math.ceil(retryAfterMs / 1000));
  }

  return { action: 'RETRY', delaySeconds: Math.min(delaySeconds, policy.maxRetryAfterSeconds) };
}
