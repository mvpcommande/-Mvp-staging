/**
 * Clé d'export RusHour : identité logique STABLE de
 *   "commande Foodatoi X -> destination RusHour Y".
 *
 * Distincte de l'idempotency_key du checkout (qui protège la création
 * de la commande Foodatoi elle-même). Celle-ci protège l'EXPORT.
 *
 * Propriétés :
 * - ne dépend ni de l'heure, ni d'un aléa, ni du numéro de tentative :
 *   le retry n°1 et le retry n°4 portent exactement la même clé ;
 * - calculée à l'identique en SQL (trigger d'enqueue, migration
 *   20260928090000) et ici (vérification d'intégrité par le worker) :
 *     'fdt1_' || left(encode(sha256(convert_to(
 *        'foodatoi-rushour-export:v1:' || order_id || ':' || integration_id,
 *        'UTF8')), 'hex'), 32)
 *   Le test SQL (supabase/tests/rushour) vérifie l'égalité des deux.
 * - 37 caractères [a-z0-9_] : aucun identifiant interne ni donnée client
 *   n'y est lisible.
 *
 * Elle est envoyée à RusHour dans les champs `id`/`externalId` du
 * payload. Que RusHour déduplique sur ce champ est UNKNOWN (à confirmer
 * en Bloc 2) ; côté Foodatoi, l'unicité est de toute façon garantie en
 * base (UNIQUE(order_id) + UNIQUE(export_key) sur l'outbox).
 */

import { validationError } from './errors.mjs';
import { isUuid } from './types.mjs';
import { isValidExternalId } from './config.mjs';

export const EXPORT_KEY_VERSION = 'v1';
export const EXPORT_KEY_PREFIX = 'fdt1_';
const NAMESPACE = 'foodatoi-rushour-export';

export const EXPORT_KEY_RE = /^fdt1_[0-9a-f]{32}$/;

export function exportKeyMaterial({ orderId, integrationId }) {
  if (!isUuid(orderId)) {
    throw validationError('INVALID_ORDER_ID', 'orderId invalide pour la clé d’export');
  }
  if (!isValidExternalId(integrationId)) {
    throw validationError('INVALID_INTEGRATION_ID', 'integrationId invalide pour la clé d’export');
  }
  return `${NAMESPACE}:${EXPORT_KEY_VERSION}:${orderId.toLowerCase()}:${integrationId}`;
}

/**
 * Web Crypto : disponible à l'identique dans Node >= 20 et Deno (Edge
 * Functions), aucune dépendance.
 */
export async function computeExportKey({ orderId, integrationId }) {
  const material = exportKeyMaterial({ orderId, integrationId });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return EXPORT_KEY_PREFIX + hex.slice(0, 32);
}
