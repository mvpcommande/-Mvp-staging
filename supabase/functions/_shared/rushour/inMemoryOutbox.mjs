/**
 * Double de test du repository outbox : reproduit EN MÉMOIRE la
 * sémantique des fonctions SQL de la migration 20260928090000
 * (rushour_enqueue via trigger, rushour_claim_outbox,
 * rushour_mark_sent, rushour_mark_failed). Utilisé par les tests node et
 * jamais par l'Edge Function.
 *
 * Chaque méthode fait sa lecture-modification-écriture de façon
 * synchrone (aucun await au milieu) : dans le modèle mono-thread de JS,
 * c'est l'équivalent du verrou de ligne. La preuve sous VRAIE
 * concurrence (plusieurs connexions Postgres) est dans
 * supabase/tests/rushour/ (FOR UPDATE SKIP LOCKED).
 */

import { OUTBOX_STATUS } from './types.mjs';
import { computeExportKey } from './idempotency.mjs';
import { DEFAULT_RETRY_POLICY } from './retryPolicy.mjs';

export const DEFAULT_LEASE_SECONDS = 600;

export class InMemoryOutbox {
  constructor({ nowMs = () => Date.now(), leaseSeconds = DEFAULT_LEASE_SECONDS, maxAttempts = DEFAULT_RETRY_POLICY.maxAttempts } = {}) {
    this._now = nowMs;
    this._leaseMs = leaseSeconds * 1000;
    this._maxAttempts = maxAttempts;
    this.orders = new Map();
    this.orderItems = new Map();
    this.connections = new Map();
    this.productMappings = [];
    this.rows = new Map();
    this.events = [];
    this._seq = 0;
  }

  // --- données de test -------------------------------------------------

  addConnection(row) {
    this.connections.set(row.restaurant_id, { enabled: false, rushour_store_id: null, ...row });
  }

  addProductMapping(row) {
    this.productMappings.push(row);
  }

  /** Équivalent de create_order() + trigger AFTER INSERT ON orders. */
  async insertOrder(order, items) {
    this.orders.set(order.id, order);
    this.orderItems.set(order.id, items);
    return this.enqueue(order.id);
  }

  /** Miroir de public.rushour_enqueue_order() : idempotent (ON CONFLICT DO NOTHING). */
  async enqueue(orderId) {
    const order = this.orders.get(orderId);
    const connection = order && this.connections.get(order.restaurant_id);
    if (!connection || connection.enabled !== true) return null;

    const exportKey = await computeExportKey({ orderId, integrationId: connection.rushour_integration_id });
    const existing = [...this.rows.values()].find(r => r.orderId === orderId);
    if (existing) return existing;

    this._seq += 1;
    const row = {
      id: `outbox-${this._seq}`,
      orderId,
      restaurantId: order.restaurant_id,
      exportKey,
      destinationIntegrationId: connection.rushour_integration_id,
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      maxAttempts: this._maxAttempts,
      nextAttemptAt: this._now(),
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastErrorCategory: null,
      lastError: null,
      externalOrderId: null,
      sentAt: null
    };
    this.rows.set(row.id, row);
    return row;
  }

  // --- port repository (même contrat que supabaseRepository) ------------

  async claim({ workerId, limit, reclaimStale = true }) {
    const now = this._now();
    const claimed = [];
    if (!reclaimStale) {
      for (const row of this.rows.values()) {
        if (row.status === OUTBOX_STATUS.SENDING && row.lockedAt <= now - this._leaseMs) {
          Object.assign(row, { status: 'UNCERTAIN', lockedAt: null, lockedBy: null,
            lastErrorCode: 'LEASE_EXPIRED_UNCERTAIN', lastErrorCategory: 'UNCERTAIN' });
        }
      }
    }
    const candidates = [...this.rows.values()].sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

    for (const row of candidates) {
      if (claimed.length >= limit) break;
      const connection = this.connections.get(row.restaurantId);
      const order = this.orders.get(row.orderId);
      const paid = order?.payment_status === 'PAID'
        || (order?.payment_status === 'PAY_AT_STORE' && connection?.payment_required !== true);
      if (!connection?.enabled || !paid) continue;

      const due = row.status === OUTBOX_STATUS.PENDING && row.nextAttemptAt <= now;
      const staleLease = reclaimStale && row.status === OUTBOX_STATUS.SENDING && row.lockedAt <= now - this._leaseMs;
      if (!(due || staleLease) || row.attempts >= row.maxAttempts) continue;

      row.status = OUTBOX_STATUS.SENDING;
      row.lockedAt = now;
      row.lockedBy = workerId;
      row.attempts += 1;
      claimed.push({ ...row });
    }
    return claimed;
  }

  async loadExportContext(entry) {
    const order = this.orders.get(entry.orderId) ?? null;
    return {
      order,
      items: this.orderItems.get(entry.orderId) ?? [],
      connection: this.connections.get(entry.restaurantId) ?? null,
      productMappings: this.productMappings.filter(m => m.restaurant_id === entry.restaurantId)
    };
  }

  async markSent({ id, workerId, externalOrderId }) {
    const row = this.rows.get(id);
    if (!row || row.status !== OUTBOX_STATUS.SENDING || row.lockedBy !== workerId) return false;
    Object.assign(row, {
      status: OUTBOX_STATUS.SENT,
      externalOrderId,
      sentAt: this._now(),
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastErrorCategory: null,
      lastError: null
    });
    return true;
  }

  async markFailed({ id, workerId, errorCode, errorCategory, errorMessage, retryInSeconds }) {
    const row = this.rows.get(id);
    if (!row || row.status !== OUTBOX_STATUS.SENDING || row.lockedBy !== workerId) return 'LEASE_LOST';
    const retry = retryInSeconds !== null && row.attempts < row.maxAttempts;
    Object.assign(row, {
      status: retry ? OUTBOX_STATUS.PENDING : OUTBOX_STATUS.FAILED,
      nextAttemptAt: retry ? this._now() + retryInSeconds * 1000 : row.nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: errorCode,
      lastErrorCategory: errorCategory,
      lastError: errorMessage
    });
    return row.status;
  }

  async markUncertain({ id, workerId, errorCode, errorMessage }) {
    const row = this.rows.get(id);
    if (!row || row.status !== OUTBOX_STATUS.SENDING || row.lockedBy !== workerId) return 'LEASE_LOST';
    Object.assign(row, { status: 'UNCERTAIN', lockedAt: null, lockedBy: null,
      lastErrorCode: errorCode, lastErrorCategory: 'UNCERTAIN', lastError: errorMessage });
    return 'UNCERTAIN';
  }

  async logEvent(event) {
    this.events.push(event);
  }

  // --- helpers de test ---------------------------------------------------

  rowForOrder(orderId) {
    return [...this.rows.values()].find(r => r.orderId === orderId) ?? null;
  }
}
