/**
 * Mapper PUR : commande Foodatoi normalisée -> payload de commande RusHour.
 *
 * Garanties :
 * - aucun fetch, aucune variable globale, aucune horloge, aucun aléa :
 *   mêmes entrées => même sortie (testé) ;
 * - FAIL CLOSED : un produit sans mapping RusHour valide, un mapping
 *   d'un autre restaurant, une destination d'un autre restaurant...
 *   => MAPPING_ERROR, rien n'est envoyé. On n'invente jamais un produit.
 *
 * PROVENANCE DU SCHÉMA (lire avant le Bloc 2) :
 * La forme du payload suit l'EXEMPLE officiel du dépôt
 * github.com/rushour-io/developers-api-demo
 * (cookbooks/send-an-order/sendAnOrder.js, 2022). Le portail
 * developers.rushour.io (référence de schéma) n'a pas pu être consulté
 * depuis cet environnement. Donc :
 * - CONFIRMED_BY_EXAMPLE : champ présent dans l'exemple officiel, avec une
 *   valeur du même type. Sa sémantique exacte reste à reconfirmer.
 * - UNVERIFIED : aucun support documentaire ; placeholder explicite.
 * Le client HTTP réel refuse de démarrer tant que
 * RUSHOUR_PAYLOAD_SCHEMA.verified === false (voir client.mjs).
 */

import { RushourError, ErrorCategory, mappingError, validationError } from './errors.mjs';
import { isValidExternalId } from './config.mjs';
import { EXPORT_KEY_RE } from './idempotency.mjs';

export const RUSHOUR_PAYLOAD_SCHEMA = Object.freeze({
  verified: false,
  source: 'github.com/rushour-io/developers-api-demo cookbooks/send-an-order (exemple, 2022)',
  confirmedByExample: Object.freeze([
    'id', 'externalId', 'displayId', 'status', 'orderedAt', 'prepareBy',
    'type', 'total', 'discount', 'isPaid', 'instructions',
    'customer.name', 'customer.phone', 'customer.address.address', 'items (tableau)'
  ]),
  unverified: Object.freeze([
    'unité de total (centimes supposés : exemple total=1190)',
    'type pour le click-and-collect (valeur "pickup" supposée)',
    'schéma complet de items[] (exemple fourni vide)',
    'représentation des options/modifiers',
    'paymentMethod (enum non documentée, volontairement omis)',
    'déduplication RusHour sur id/externalId'
  ])
});

// Seule "delivery" apparaît dans l'exemple officiel. "pickup" : UNVERIFIED.
export const RUSHOUR_ORDER_TYPE = Object.freeze({
  DELIVERY: 'delivery',
  PICKUP: 'pickup'
});

// Valeur de l'exemple officiel pour une commande entrante.
export const RUSHOUR_NEW_ORDER_STATUS = 'new';

// Statuts Foodatoi qui valent "déjà payé". Aujourd'hui aucun flux ne
// produit PAID (paiement en ligne non finalisé) : toutes les commandes
// partent isPaid=false (paiement au comptoir).
const PAID_STATUSES = new Set(['PAID']);

/**
 * Index des mappings produit, tenant-scoped, fail-closed.
 * @param {Array<{restaurant_id: string, product_id: string, rushour_product_id: string}>} rows
 */
function indexProductMappings(rows, restaurantId) {
  if (!Array.isArray(rows)) {
    throw validationError('INVALID_PRODUCT_MAPPINGS', 'Mappings produit illisibles');
  }
  const byProduct = new Map();
  for (const row of rows) {
    const productId = String(row?.product_id ?? '').toLowerCase();
    if (String(row?.restaurant_id ?? '').toLowerCase() !== restaurantId) {
      // Un mapping d'un autre restaurant ne doit JAMAIS être utilisé,
      // même s'il porte le bon product_id.
      throw mappingError('CROSS_TENANT_PRODUCT_MAPPING',
        'Mapping produit appartenant à un autre restaurant', { productId });
    }
    const previous = byProduct.get(productId);
    if (previous !== undefined && previous !== row.rushour_product_id) {
      throw mappingError('AMBIGUOUS_PRODUCT_MAPPING', 'Plusieurs mappings RusHour pour un même produit',
        { productId });
    }
    byProduct.set(productId, row.rushour_product_id);
  }
  return byProduct;
}

function mapItem(item, mappings) {
  const rushourProductId = mappings.get(item.productId);
  if (rushourProductId === undefined) {
    throw mappingError('PRODUCT_NOT_MAPPED', `Produit sans mapping RusHour : ${item.name}`,
      { productId: item.productId });
  }
  if (!isValidExternalId(rushourProductId)) {
    throw mappingError('INVALID_RUSHOUR_PRODUCT_ID', `Mapping RusHour invalide : ${item.name}`,
      { productId: item.productId });
  }
  // UNVERIFIED : forme d'item non documentée (l'exemple officiel est vide).
  return {
    productId: rushourProductId,
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPriceCents,
    total: item.lineTotalCents,
    options: item.options.map(o => ({ name: o.label, value: o.choice }))
  };
}

/**
 * @param {{
 *   order: import('./types.mjs').NormalizedOrder,
 *   destination: import('./types.mjs').RushourDestination,
 *   productMappings: Array<object>,
 *   exportKey: string
 * }} input
 */
export function foodatoiOrderToRushour({ order, destination, productMappings, exportKey }) {
  if (!order || !destination) {
    throw validationError('INVALID_MAPPER_INPUT', 'Commande ou destination manquante');
  }
  if (destination.restaurantId !== order.restaurantId) {
    throw mappingError('CROSS_TENANT_DESTINATION', "Destination RusHour d'un autre restaurant");
  }
  if (typeof exportKey !== 'string' || !EXPORT_KEY_RE.test(exportKey)) {
    throw validationError('INVALID_EXPORT_KEY', 'Clé d’export invalide');
  }
  if (order.status === 'CANCELLED') {
    throw new RushourError(ErrorCategory.NON_RETRYABLE, 'ORDER_CANCELLED', 'Commande annulée : non exportée');
  }
  if (order.paymentStatus === 'PENDING') {
    // Paiement en ligne non confirmé : on n'envoie pas en cuisine.
    throw new RushourError(ErrorCategory.RETRYABLE, 'PAYMENT_PENDING', 'Paiement en attente');
  }

  const mappings = indexProductMappings(productMappings, order.restaurantId);
  const items = order.items.map(item => mapItem(item, mappings));

  const customer = { name: order.customer.name, phone: order.customer.phone };
  if (order.deliveryAddress) {
    const a = order.deliveryAddress;
    customer.address = { address: `${a.street}, ${a.postalCode} ${a.city}` };
  }

  const payload = {
    id: exportKey,
    externalId: exportKey,
    displayId: order.orderNumber,
    status: RUSHOUR_NEW_ORDER_STATUS,
    type: order.fulfillmentType === 'DELIVERY' ? RUSHOUR_ORDER_TYPE.DELIVERY : RUSHOUR_ORDER_TYPE.PICKUP,
    orderedAt: order.createdAt,
    prepareBy: order.pickupTime,
    total: order.totalCents,
    discount: 0,
    isPaid: PAID_STATUSES.has(order.paymentStatus),
    instructions: order.notes ?? '',
    customer,
    items
  };

  return deepFreeze(payload);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
