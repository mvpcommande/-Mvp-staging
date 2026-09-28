/**
 * Dispatcher de l'outbox RusHour : orchestre, pour une entrée RÉCLAMÉE
 * atomiquement en base (rushour_claim_outbox), la chaîne
 *
 *   config -> clé d'export -> normalisation -> mapping -> client -> statut
 *
 * Il ne dépend que de deux ports injectés :
 * - repo   : accès outbox/commande (supabaseRepository.mjs en prod,
 *            inMemoryOutbox.mjs en test) ;
 * - client : contrat client.mjs (mock aujourd'hui, HTTP en Bloc 2).
 *
 * La concurrence N'EST PAS gérée ici par une variable JS : l'exclusion
 * mutuelle vient de la base (FOR UPDATE SKIP LOCKED + statut SENDING +
 * locked_by). mark_sent / mark_failed sont conditionnés à
 * (status = SENDING AND locked_by = workerId) : un worker dont le bail a
 * expiré et été repris ne peut plus rien écrire (LEASE_LOST).
 *
 * @typedef {{
 *   id: string, orderId: string, restaurantId: string, exportKey: string,
 *   destinationIntegrationId: string, attempts: number, maxAttempts: number
 * }} OutboxEntry
 */

import { RushourError, ErrorCategory, toRushourError, validationError, mappingError } from './errors.mjs';
import { normalizeFoodatoiOrder } from './types.mjs';
import { resolveRushourDestination } from './config.mjs';
import { computeExportKey } from './idempotency.mjs';
import { foodatoiOrderToRushour } from './mapper.mjs';
import { assertRushourClient } from './client.mjs';
import { decideRetry, DEFAULT_RETRY_POLICY } from './retryPolicy.mjs';
import { SYNC_STEP, buildSyncEvent, redactString } from './logging.mjs';

export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export const DISPATCH_OUTCOME = Object.freeze({
  SENT: 'SENT',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  FAILED: 'FAILED',
  LEASE_LOST: 'LEASE_LOST',
  COMPLETION_UNCERTAIN: 'COMPLETION_UNCERTAIN'
});

async function safeLog(repo, event) {
  try {
    await repo.logEvent(event);
  } catch {
    // La journalisation ne doit jamais faire échouer ni rejouer un export.
  }
}

/**
 * Appel client borné dans le temps, même si l'implémentation ignore le
 * signal d'annulation (course avec un minuteur).
 */
async function sendWithTimeout(client, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RushourError(ErrorCategory.TIMEOUT, 'TIMEOUT', `Pas de réponse RusHour en ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([client.sendOrder({ ...request, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Traite UNE entrée déjà réclamée (status SENDING, locked_by = workerId,
 * attempts déjà incrémenté par la réclamation).
 *
 * @param {OutboxEntry} entry
 */
export async function dispatchOutboxEntry(entry, deps) {
  const { repo, client, workerId, timeoutMs = DEFAULT_SEND_TIMEOUT_MS, policy = DEFAULT_RETRY_POLICY } = deps;
  assertRushourClient(client);
  if (!workerId) throw new TypeError('workerId requis');

  let step = SYNC_STEP.RESOLVE_CONFIG;
  let result;

  try {
    const ctx = await repo.loadExportContext(entry);
    if (!ctx?.order) {
      throw validationError('ORDER_NOT_FOUND', 'Commande introuvable pour cette entrée outbox');
    }
    if (String(ctx.order.restaurant_id).toLowerCase() !== entry.restaurantId.toLowerCase()) {
      throw mappingError('CROSS_TENANT_OUTBOX', "Entrée outbox rattachée au mauvais restaurant");
    }

    const destination = resolveRushourDestination(ctx.connection, entry.restaurantId);
    if (destination.integrationId !== entry.destinationIntegrationId) {
      // La destination a changé depuis l'enqueue : on n'envoie PAS vers
      // la nouvelle sans décision humaine (requeue explicite).
      throw new RushourError(ErrorCategory.NON_RETRYABLE, 'DESTINATION_CHANGED',
        'Intégration RusHour modifiée depuis la mise en file');
    }

    const exportKey = await computeExportKey({ orderId: entry.orderId, integrationId: destination.integrationId });
    if (exportKey !== entry.exportKey) {
      throw validationError('EXPORT_KEY_MISMATCH', 'Clé d’export incohérente avec la commande');
    }

    step = SYNC_STEP.MAP;
    const order = normalizeFoodatoiOrder(ctx.order, ctx.items);
    const payload = foodatoiOrderToRushour({
      order, destination, productMappings: ctx.productMappings ?? [], exportKey
    });

    step = SYNC_STEP.SEND;
    result = await sendWithTimeout(client, { destination, payload, exportKey }, timeoutMs);
  } catch (raw) {
    const error = toRushourError(raw);
    const decision = decideRetry({
      category: error.category,
      attempt: entry.attempts,
      maxAttempts: entry.maxAttempts,
      retryAfterMs: error.retryAfterMs
    }, policy);

    const status = await repo.markFailed({
      id: entry.id,
      workerId,
      errorCode: error.code,
      errorCategory: error.category,
      errorMessage: redactString(error.message),
      retryInSeconds: decision.action === 'RETRY' ? decision.delaySeconds : null
    });

    const outcome = status === 'PENDING'
      ? DISPATCH_OUTCOME.RETRY_SCHEDULED
      : status === 'FAILED' ? DISPATCH_OUTCOME.FAILED : DISPATCH_OUTCOME.LEASE_LOST;

    await safeLog(repo, buildSyncEvent({ entry, step, outcome, error }));
    return { outcome, error, decision };
  }

  // Envoi réussi. Si l'écriture du statut échoue maintenant, on NE
  // marque PAS l'entrée en échec (ce qui la rejouerait tout de suite) :
  // elle reste SENDING, et ne sera reprise qu'à l'expiration du bail,
  // avec la même clé d'export.
  step = SYNC_STEP.COMPLETE;
  try {
    const marked = await repo.markSent({ id: entry.id, workerId, externalOrderId: result.externalOrderId });
    const outcome = marked ? DISPATCH_OUTCOME.SENT : DISPATCH_OUTCOME.LEASE_LOST;
    await safeLog(repo, buildSyncEvent({
      entry, step, outcome, message: result.duplicate ? 'RusHour signale un doublon : export déjà présent' : null
    }));
    return { outcome, externalOrderId: result.externalOrderId, duplicate: result.duplicate };
  } catch (raw) {
    const error = toRushourError(raw);
    await safeLog(repo, buildSyncEvent({ entry, step, outcome: DISPATCH_OUTCOME.COMPLETION_UNCERTAIN, error }));
    return { outcome: DISPATCH_OUTCOME.COMPLETION_UNCERTAIN, error };
  }
}

/**
 * Réclame puis traite un lot. Séquentiel : un établissement lent ne
 * multiplie pas les appels simultanés vers RusHour.
 */
export async function runDispatchBatch({
  repo, client, workerId, limit = 10, timeoutMs = DEFAULT_SEND_TIMEOUT_MS, policy = DEFAULT_RETRY_POLICY
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit doit être compris entre 1 et 100');
  }
  const entries = await repo.claim({ workerId, limit });
  const summary = { claimed: entries.length, sent: 0, retryScheduled: 0, failed: 0, leaseLost: 0, uncertain: 0 };

  for (const entry of entries) {
    const { outcome } = await dispatchOutboxEntry(entry, { repo, client, workerId, timeoutMs, policy });
    if (outcome === DISPATCH_OUTCOME.SENT) summary.sent += 1;
    else if (outcome === DISPATCH_OUTCOME.RETRY_SCHEDULED) summary.retryScheduled += 1;
    else if (outcome === DISPATCH_OUTCOME.FAILED) summary.failed += 1;
    else if (outcome === DISPATCH_OUTCOME.LEASE_LOST) summary.leaseLost += 1;
    else summary.uncertain += 1;
  }
  return summary;
}
