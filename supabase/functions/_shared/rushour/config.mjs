/**
 * Résolution de la destination RusHour d'un établissement FOODATOI.
 *
 * Source : table `restaurant_rushour_connections` (une ligne par
 * restaurant, aucun secret). Rien n'est codé en dur : 1, 7 ou 50
 * établissements = autant de lignes.
 *
 * Identifiant de routage : d'après le dépôt officiel
 * rushour-io/developers-api-demo, une commande est poussée sur
 * POST /apps/{appId}/integrations/{integrationId}/orders : c'est
 * l'integrationId (fourni par l'équipe RusHour, un par établissement)
 * qui désigne la destination. Un éventuel "store id" distinct n'est pas
 * confirmé (UNKNOWN) : il est conservé en option, jamais requis.
 */

import { RushourError, ErrorCategory } from './errors.mjs';
import { isUuid } from './types.mjs';

// Format volontairement strict : l'identifiant finit dans une URL.
const EXTERNAL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const isValidExternalId = value => typeof value === 'string' && EXTERNAL_ID_RE.test(value);

/**
 * @param {object|null} connection ligne restaurant_rushour_connections
 * @param {string} restaurantId    restaurant de la commande
 * @returns {import('./types.mjs').RushourDestination}
 */
export function resolveRushourDestination(connection, restaurantId) {
  if (!isUuid(restaurantId)) {
    throw new RushourError(ErrorCategory.VALIDATION_ERROR, 'INVALID_RESTAURANT_ID',
      'Restaurant de la commande invalide');
  }
  if (!connection) {
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'RUSHOUR_NOT_CONFIGURED',
      'Aucune intégration RusHour configurée pour ce restaurant');
  }
  if (String(connection.restaurant_id).toLowerCase() !== restaurantId.toLowerCase()) {
    throw new RushourError(ErrorCategory.MAPPING_ERROR, 'CROSS_TENANT_CONNECTION',
      "Configuration RusHour d'un autre restaurant");
  }
  if (connection.enabled !== true) {
    // Désactivation volontaire : on retentera plus tard (borné), sans
    // jamais envoyer tant qu'elle n'est pas réactivée.
    throw new RushourError(ErrorCategory.RETRYABLE, 'RUSHOUR_INTEGRATION_DISABLED',
      'Intégration RusHour désactivée pour ce restaurant');
  }
  if (!isValidExternalId(connection.rushour_integration_id)) {
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'INVALID_INTEGRATION_ID',
      'Identifiant d’intégration RusHour invalide');
  }
  const storeId = connection.rushour_store_id ?? null;
  if (storeId !== null && !isValidExternalId(storeId)) {
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'INVALID_STORE_ID',
      'Identifiant de store RusHour invalide');
  }

  const targetEnvironment = connection.target_environment ?? 'test';
  if (targetEnvironment !== 'test' && targetEnvironment !== 'production') {
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'INVALID_TARGET_ENVIRONMENT',
      'Environnement RusHour de destination invalide');
  }

  return Object.freeze({
    restaurantId: restaurantId.toLowerCase(),
    integrationId: connection.rushour_integration_id,
    storeId,
    // Payment gate (Bloc 2) : true => seules les commandes PAID partent.
    paymentRequired: connection.payment_required === true,
    targetEnvironment
  });
}
