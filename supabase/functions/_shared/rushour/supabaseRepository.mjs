/**
 * Port repository de l'outbox RusHour, adossé à supabase-js.
 *
 * DOIT être construit avec un client service_role, et UNIQUEMENT dans
 * l'Edge Function (serveur). Toutes les transitions d'état passent par
 * les fonctions SQL atomiques de la migration 20260928090000 - aucun
 * UPDATE direct de statut depuis JS.
 *
 * Les erreurs base de données sont RETRYABLE (panne transitoire), pour
 * ne jamais faire passer une commande en FAILED à cause d'un hoquet
 * réseau entre la fonction et Postgres.
 */

import { RushourError, ErrorCategory } from './errors.mjs';

const ORDER_COLUMNS = [
  'id', 'restaurant_id', 'order_number', 'status', 'payment_status', 'fulfillment_type',
  'pickup_time', 'created_at', 'customer_name', 'customer_phone', 'notes', 'total_cents',
  'delivery_address'
].join(',');

const ITEM_COLUMNS = 'order_id,product_id,product_name,quantity,unit_price_cents,line_total_cents,options';

function dbError(operation) {
  // Le détail Postgres n'est pas propagé (il peut contenir des valeurs).
  return new RushourError(ErrorCategory.RETRYABLE, 'DB_ERROR', `Erreur base de données (${operation})`);
}

export function toOutboxEntry(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    restaurantId: row.restaurant_id,
    exportKey: row.export_key,
    destinationIntegrationId: row.destination_integration_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts
  };
}

export function createSupabaseOutboxRepository(db) {
  if (!db || typeof db.rpc !== 'function' || typeof db.from !== 'function') {
    throw new TypeError('Client supabase-js requis');
  }

  return {
    async claim({ workerId, limit, reclaimStale = true }) {
      const { data, error } = await db.rpc('rushour_claim_outbox', {
        p_worker_id: workerId, p_limit: limit, p_reclaim_stale: reclaimStale === true
      });
      if (error) throw dbError('claim');
      return (data ?? []).map(toOutboxEntry);
    },

    async loadExportContext(entry) {
      const [orderRes, itemsRes, connectionRes] = await Promise.all([
        db.from('orders').select(ORDER_COLUMNS).eq('id', entry.orderId).maybeSingle(),
        db.from('order_items').select(ITEM_COLUMNS).eq('order_id', entry.orderId),
        db.from('restaurant_rushour_connections')
          .select('restaurant_id,rushour_integration_id,rushour_store_id,enabled,payment_required,target_environment')
          .eq('restaurant_id', entry.restaurantId)
          .maybeSingle()
      ]);
      if (orderRes.error || itemsRes.error || connectionRes.error) throw dbError('load_context');

      const productIds = [...new Set((itemsRes.data ?? []).map(i => i.product_id))];
      let productMappings = [];
      if (productIds.length > 0) {
        const { data, error } = await db
          .from('rushour_product_mappings')
          .select('restaurant_id,product_id,rushour_product_id')
          .eq('restaurant_id', entry.restaurantId)
          .in('product_id', productIds);
        if (error) throw dbError('load_mappings');
        productMappings = data ?? [];
      }

      return {
        order: orderRes.data ?? null,
        items: itemsRes.data ?? [],
        connection: connectionRes.data ?? null,
        productMappings
      };
    },

    async markSent({ id, workerId, externalOrderId }) {
      const { data, error } = await db.rpc('rushour_mark_sent', {
        p_outbox_id: id, p_worker_id: workerId, p_external_order_id: externalOrderId
      });
      if (error) throw dbError('mark_sent');
      return data === true;
    },

    async markFailed({ id, workerId, errorCode, errorCategory, errorMessage, retryInSeconds }) {
      const { data, error } = await db.rpc('rushour_mark_failed', {
        p_outbox_id: id,
        p_worker_id: workerId,
        p_error_code: errorCode,
        p_error_category: errorCategory,
        p_error_message: errorMessage,
        p_retry_in_seconds: retryInSeconds
      });
      if (error) throw dbError('mark_failed');
      return data;
    },

    async markUncertain({ id, workerId, errorCode, errorMessage }) {
      const { data, error } = await db.rpc('rushour_mark_uncertain', {
        p_outbox_id: id, p_worker_id: workerId, p_error_code: errorCode, p_error_message: errorMessage
      });
      if (error) throw dbError('mark_uncertain');
      return data;
    },

    async logEvent(event) {
      const { error } = await db.from('rushour_sync_events').insert(event);
      if (error) throw dbError('log_event');
    }
  };
}
