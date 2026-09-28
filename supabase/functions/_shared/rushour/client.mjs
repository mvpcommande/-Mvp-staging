/**
 * Contrat du client RusHour + garde-fou du client HTTP réel.
 *
 * Toute implémentation (RushourMockClient aujourd'hui, RushourHttpClient
 * en Bloc 2) expose UNE méthode :
 *
 *   sendOrder({ destination, payload, exportKey, signal })
 *     -> Promise<{ externalOrderId: string|null, duplicate: boolean }>
 *     -> ou rejette une RushourError catégorisée (errors.mjs)
 *
 * Le dispatcher ne connaît QUE ce contrat : remplacer le mock par le
 * client HTTP ne touche ni au mapper, ni à l'outbox, ni au retry.
 *
 * Secrets : appSecret / tokens ne transitent JAMAIS par ce contrat ni
 * par le payload. Le client HTTP les lira lui-même côté serveur
 * (Supabase Secrets de l'Edge Function), jamais depuis le navigateur.
 */

import { RushourError, ErrorCategory } from './errors.mjs';
import { RUSHOUR_PAYLOAD_SCHEMA } from './mapper.mjs';
import { isValidExternalId } from './config.mjs';

/**
 * Valide la forme d'un résultat de sendOrder(). Une réponse illisible
 * est classée UNKNOWN (non rejouée automatiquement : la commande a
 * peut-être été créée côté RusHour).
 */
export function validateSendResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RushourError(ErrorCategory.UNKNOWN, 'INVALID_RESPONSE', 'Réponse RusHour illisible');
  }
  const { externalOrderId = null, duplicate = false } = raw;
  if (externalOrderId !== null && !isValidExternalId(externalOrderId)) {
    throw new RushourError(ErrorCategory.UNKNOWN, 'INVALID_RESPONSE', 'Identifiant de commande RusHour invalide');
  }
  if (typeof duplicate !== 'boolean') {
    throw new RushourError(ErrorCategory.UNKNOWN, 'INVALID_RESPONSE', 'Indicateur de doublon invalide');
  }
  return { externalOrderId, duplicate };
}

export function assertRushourClient(client) {
  if (!client || typeof client.sendOrder !== 'function') {
    throw new TypeError('Client RusHour invalide : sendOrder() manquant');
  }
  return client;
}

/**
 * Client HTTP réel - VOLONTAIREMENT NON IMPLÉMENTÉ dans ce bloc.
 *
 * Il refuse de s'instancier tant que le schéma de payload n'a pas été
 * vérifié contre la documentation officielle (RUSHOUR_PAYLOAD_SCHEMA).
 * Procédure de mise en service : docs/RUSHOUR_CONNECTOR.md § "Passage
 * mock -> RusHour réel".
 */
export class RushourHttpClient {
  constructor() {
    if (!RUSHOUR_PAYLOAD_SCHEMA.verified) {
      throw new RushourError(ErrorCategory.NON_RETRYABLE, 'REAL_CLIENT_DISABLED',
        'Client RusHour réel désactivé : schéma non vérifié (Bloc 2)');
    }
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'REAL_CLIENT_NOT_IMPLEMENTED',
      'Client RusHour réel non implémenté (Bloc 2)');
  }

  // eslint-disable-next-line class-methods-use-this
  async sendOrder() {
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'REAL_CLIENT_NOT_IMPLEMENTED',
      'Client RusHour réel non implémenté (Bloc 2)');
  }
}
