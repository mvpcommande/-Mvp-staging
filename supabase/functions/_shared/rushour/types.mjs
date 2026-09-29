/**
 * Modèle interne normalisé d'une commande FOODATOI à exporter.
 *
 * Ce N'EST PAS le payload RusHour : c'est la représentation stable, côté
 * Foodatoi, indépendante du canal d'entrée (web aujourd'hui, WhatsApp
 * demain - tous passent par create_order()) et de la destination. Le
 * passage vers RusHour est fait séparément par mapper.mjs.
 *
 * Toute incohérence dans les lignes lues en base fait échouer la
 * normalisation (VALIDATION_ERROR) : on n'exporte jamais une commande
 * "à peu près juste".
 *
 * @typedef {{ label: string, choice: string }} NormalizedOption
 *
 * @typedef {{
 *   productId: string,
 *   name: string,
 *   quantity: number,
 *   options: NormalizedOption[],
 *   unitPriceCents: number,
 *   lineTotalCents: number
 * }} NormalizedItem
 *
 * @typedef {{
 *   orderId: string,
 *   restaurantId: string,
 *   orderNumber: string,
 *   status: string,
 *   paymentStatus: string,
 *   fulfillmentType: 'PICKUP'|'DELIVERY',
 *   pickupTime: string,
 *   createdAt: string,
 *   customer: { name: string, phone: string },
 *   deliveryAddress: { street: string, postalCode: string, city: string } | null,
 *   items: NormalizedItem[],
 *   totalCents: number,
 *   notes: string|null
 * }} NormalizedOrder
 *
 * @typedef {{
 *   restaurantId: string,
 *   integrationId: string,
 *   storeId: string|null
 * }} RushourDestination
 */

import { validationError } from './errors.mjs';

export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN'
});

// Bornes identiques à create_order() (quantité 1..99).
export const MAX_ITEM_QUANTITY = 99;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = value => typeof value === 'string' && UUID_RE.test(value);

const isNonNegativeInt = v => Number.isSafeInteger(v) && v >= 0;

function toIsoTimestamp(value, field) {
  const ms = typeof value === 'string' || value instanceof Date ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    throw validationError('INVALID_TIMESTAMP', `Horodatage invalide : ${field}`);
  }
  return new Date(ms).toISOString();
}

const cleanText = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Aplatit le JSON libre `order_items.options` (tel qu'écrit par le
 * front : { meat, meat2, sauce, drink, groups: [{label, choice}] ...})
 * en une liste déterministe de { label, choice }.
 *
 * Règles (documentées, déterministes) :
 * - `groups` : chaque {label, choice} dans l'ordre fourni ;
 * - autres clés à valeur texte/nombre : { label: clé, choice: valeur },
 *   triées par clé ;
 * - tableaux (ex. `meats`, doublon de meat/meat2/meat3), booléens et
 *   objets : ignorés (ce sont des doublons ou des drapeaux d'affichage).
 * Un `groups` mal formé est une incohérence -> VALIDATION_ERROR.
 */
export function normalizeOptions(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError('INVALID_OPTIONS', 'Options de ligne invalides (objet attendu)');
  }

  const out = [];

  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups)) {
      throw validationError('INVALID_OPTIONS', 'options.groups doit être une liste');
    }
    for (const group of raw.groups) {
      const label = cleanText(group?.label);
      const choice = cleanText(group?.choice);
      if (!label || !choice) {
        throw validationError('INVALID_OPTIONS', 'options.groups : label/choice manquant');
      }
      out.push({ label, choice });
    }
  }

  for (const key of Object.keys(raw).filter(k => k !== 'groups').sort()) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') {
      out.push({ label: key, choice: value.trim() });
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ label: key, choice: String(value) });
    }
  }

  return out;
}

function normalizeItem(row, orderId) {
  if (!row || typeof row !== 'object') {
    throw validationError('INVALID_ITEM', 'Ligne de commande illisible');
  }
  if (row.order_id !== undefined && row.order_id !== orderId) {
    throw validationError('ITEM_ORDER_MISMATCH', 'Ligne rattachée à une autre commande');
  }
  if (!isUuid(row.product_id)) {
    throw validationError('INVALID_PRODUCT_ID', 'Ligne sans product_id valide');
  }
  const name = cleanText(row.product_name);
  if (!name) {
    throw validationError('INVALID_ITEM', 'Ligne sans nom de produit');
  }
  const quantity = row.quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
    throw validationError('INVALID_QUANTITY', `Quantité hors bornes (1..${MAX_ITEM_QUANTITY})`);
  }
  const unitPriceCents = row.unit_price_cents;
  const lineTotalCents = row.line_total_cents;
  if (!isNonNegativeInt(unitPriceCents) || !isNonNegativeInt(lineTotalCents)) {
    throw validationError('INVALID_AMOUNT', 'Montant de ligne invalide (centimes entiers attendus)');
  }
  // create_order() calcule line_total = prix unitaire x quantité (les
  // options n'ont pas de prix). Toute divergence = donnée corrompue.
  if (unitPriceCents * quantity !== lineTotalCents) {
    throw validationError('LINE_TOTAL_MISMATCH', 'Total de ligne incohérent avec prix x quantité');
  }

  return {
    productId: row.product_id.toLowerCase(),
    name,
    quantity,
    options: normalizeOptions(row.options),
    unitPriceCents,
    lineTotalCents
  };
}

// Ordre stable quel que soit l'ordre de lecture en base.
function compareItems(a, b) {
  const ka = `${a.productId}|${JSON.stringify(a.options)}|${a.quantity}`;
  const kb = `${b.productId}|${JSON.stringify(b.options)}|${b.quantity}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Construit le modèle normalisé à partir des lignes `orders` et
 * `order_items` telles que lues en base (snake_case).
 *
 * @returns {NormalizedOrder}
 */
export function normalizeFoodatoiOrder(orderRow, itemRows) {
  if (!orderRow || typeof orderRow !== 'object') {
    throw validationError('INVALID_ORDER', 'Commande illisible');
  }
  if (!isUuid(orderRow.id) || !isUuid(orderRow.restaurant_id)) {
    throw validationError('INVALID_ORDER', 'Commande sans identifiants valides');
  }
  const orderId = orderRow.id.toLowerCase();
  const orderNumber = cleanText(orderRow.order_number);
  if (!orderNumber) {
    throw validationError('INVALID_ORDER', 'Commande sans numéro');
  }

  const fulfillmentType = orderRow.fulfillment_type ?? 'PICKUP';
  if (fulfillmentType !== 'PICKUP' && fulfillmentType !== 'DELIVERY') {
    throw validationError('INVALID_FULFILLMENT_TYPE', 'Mode de retrait inconnu');
  }

  let deliveryAddress = null;
  if (fulfillmentType === 'DELIVERY') {
    const addr = orderRow.delivery_address ?? {};
    deliveryAddress = {
      street: cleanText(addr.street),
      postalCode: cleanText(addr.postal_code),
      city: cleanText(addr.city)
    };
    if (!deliveryAddress.street || !deliveryAddress.postalCode || !deliveryAddress.city) {
      throw validationError('MISSING_DELIVERY_ADDRESS', 'Livraison sans adresse complète');
    }
  }

  if (!Array.isArray(itemRows) || itemRows.length === 0) {
    throw validationError('EMPTY_ORDER', 'Commande sans ligne');
  }
  const items = itemRows.map(row => normalizeItem(row, orderRow.id)).sort(compareItems);

  const totalCents = orderRow.total_cents;
  if (!isNonNegativeInt(totalCents)) {
    throw validationError('INVALID_AMOUNT', 'Total de commande invalide');
  }
  const sum = items.reduce((acc, item) => acc + item.lineTotalCents, 0);
  if (sum !== totalCents) {
    throw validationError('ORDER_TOTAL_MISMATCH', 'Total commande différent de la somme des lignes');
  }

  const notes = cleanText(orderRow.notes);

  return Object.freeze({
    orderId,
    restaurantId: orderRow.restaurant_id.toLowerCase(),
    orderNumber,
    status: String(orderRow.status ?? ''),
    paymentStatus: String(orderRow.payment_status ?? ''),
    fulfillmentType,
    pickupTime: toIsoTimestamp(orderRow.pickup_time, 'pickup_time'),
    createdAt: toIsoTimestamp(orderRow.created_at, 'created_at'),
    customer: {
      name: cleanText(orderRow.customer_name),
      phone: cleanText(orderRow.customer_phone)
    },
    deliveryAddress,
    items,
    totalCents,
    notes: notes || null
  });
}
