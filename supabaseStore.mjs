import {
  parisTimeToIsoDate
} from './timeFormat.mjs';

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

/**
 * Crée un store Supabase isolé sur un restaurant.
 *
 * IMPORTANT :
 * restaurantId doit venir du contexte du tenant
 * résolu par l'application FOODATOI.
 */
export function createSupabaseOrderStore(
  client,
  restaurantId
) {
  if (!client) {
    throw new Error(
      'Supabase client manquant.'
    );
  }

  if (!isUuid(restaurantId)) {
    throw new Error(
      'restaurantId FOODATOI invalide.'
    );
  }

  return {
    /**
     * Identifiant du restaurant courant.
     */
    restaurantId,

    /**
     * Crée une commande pour le restaurant courant.
     *
     * IMPORTANT :
     * les prix ne sont jamais envoyés au serveur. Seuls
     * product_id / quantity / options le sont ; le prix réel
     * est relu depuis products par la fonction create_order
     * (SECURITY DEFINER), qui calcule aussi le total. Un
     * client qui bidouille order.items[].price n'a donc
     * aucun effet sur ce qui est réellement facturé.
     */
    async createOrder(order) {
      const pickupTime =
        parisTimeToIsoDate(
          order.customer?.pickupTime
        );

      const items =
        Array.isArray(
          order.items
        )
          ? order.items
          : [];

      const rpcItems =
        items.map(item => {
          if (!isUuid(item.id)) {
            throw new Error(
              `Article sans référence produit valide FOODATOI : ${item.name ?? 'inconnu'}`
            );
          }

          return {
            product_id:
              item.id,

            quantity:
              Math.max(
                1,
                Number(
                  item.quantity ?? 1
                )
              ),

            options:
              item.options &&
              typeof item.options ===
                'object'
                ? item.options
                : {}
          };
        });

      const {
        data: createdOrder,
        error: orderError
      } = await client
        .rpc(
          'create_order',
          {
            p_restaurant_id:
              restaurantId,

            p_customer_name:
              order.customer?.name ??
              '',

            p_customer_phone:
              order.customer?.phone ??
              '',

            p_pickup_time:
              pickupTime,

            p_notes:
              order.notes ?? null,

            p_items:
              rpcItems,

            p_idempotency_key:
              order.idempotencyKey ??
              null
          }
        )
        .single();

      if (orderError) {
        console.error(
          'Erreur création commande FOODATOI:',
          orderError
        );

        throw orderError;
      }

      return {
        ...order,

        id:
          createdOrder.id,

        number:
          createdOrder.order_number,

        orderNumber:
          createdOrder.order_number,

        restaurantId,

        status:
          createdOrder.status,

        total:
          Number(
            createdOrder.total_cents ?? 0
          ) / 100
      };
    },

    /**
     * Récupère les commandes du restaurant courant uniquement.
     */
    async listOrders() {
      const {
        data,
        error
      } = await client
        .from('orders')
        .select(`
          id,
          restaurant_id,
          order_number,
          customer_name,
          customer_phone,
          pickup_time,
          status,
          payment_status,
          fulfillment_type,
          total_cents,
          notes,
          created_at,
          updated_at,
          order_items (
            id,
            order_id,
            product_id,
            product_name,
            quantity,
            unit_price_cents,
            options,
            line_total_cents,
            created_at
          )
        `)
        .eq(
          'restaurant_id',
          restaurantId
        )
        .order(
          'created_at',
          {
            ascending: false
          }
        );

      if (error) {
        console.error(
          'Erreur récupération commandes FOODATOI:',
          error
        );

        throw error;
      }

      return (
        data ?? []
      ).map(order => ({
        ...order,

        restaurantId:
          order.restaurant_id,

        number:
          order.order_number,

        total:
          Number(
            order.total_cents ?? 0
          ) / 100,

        customer: {
          name:
            order.customer_name,

          phone:
            order.customer_phone,

          pickupTime:
            formatPickupTime(
              order.pickup_time
            )
        },

        items:
          (
            order.order_items ??
            []
          ).map(item => ({
            id:
              item.product_id ??
              item.id,

            orderItemId:
              item.id,

            productId:
              item.product_id,

            name:
              item.product_name,

            quantity:
              Number(
                item.quantity ?? 1
              ),

            price:
              Number(
                item.unit_price_cents ??
                  0
              ) / 100,

            options:
              item.options ?? {},

            lineTotal:
              Number(
                item.line_total_cents ??
                  0
              ) / 100
          }))
      }));
    },

    /**
     * Change le statut d'une commande.
     *
     * Le restaurant_id est toujours utilisé
     * dans le filtre afin d'éviter de modifier
     * une commande appartenant à un autre tenant.
     */
    async updateStatus(
      orderId,
      status
    ) {
      if (!isUuid(orderId)) {
        throw new Error(
          'orderId invalide.'
        );
      }

      if (
        typeof status !==
        'string' ||
        !status.trim()
      ) {
        throw new Error(
          'Statut de commande invalide.'
        );
      }

      const {
        data,
        error
      } = await client
        .from('orders')
        .update({
          status:
            status.trim(),

          updated_at:
            new Date().toISOString()
        })
        .eq(
          'id',
          orderId
        )
        .eq(
          'restaurant_id',
          restaurantId
        )
        .select()
        .single();

      if (error) {
        console.error(
          'Erreur changement statut FOODATOI:',
          error
        );

        throw error;
      }

      return data;
    },

    /**
     * Historique des changements de statut d'une commande,
     * du plus ancien au plus récent, pour l'affichage détail.
     *
     * Le join sur orders (via la policy RLS de order_events)
     * garantit qu'on ne peut lire que l'historique d'une
     * commande appartenant à ce restaurant.
     */
    async getOrderEvents(orderId) {
      if (!isUuid(orderId)) {
        throw new Error(
          'orderId invalide.'
        );
      }

      const {
        data,
        error
      } = await client
        .from('order_events')
        .select('*')
        .eq(
          'order_id',
          orderId
        )
        .order(
          'created_at',
          { ascending: true }
        );

      if (error) {
        console.error(
          'Erreur historique commande FOODATOI:',
          error
        );

        throw error;
      }

      return data ?? [];
    },

    /**
     * Erreurs client récentes (résolution restaurant, realtime,
     * création commande, changement de statut) pour ce restaurant,
     * les plus récentes en premier.
     */
    async getRecentErrors(limit = 50) {
      const {
        data,
        error
      } = await client
        .from('client_error_logs')
        .select('*')
        .or(
          `restaurant_id.eq.${restaurantId},restaurant_id.is.null`
        )
        .order(
          'created_at',
          { ascending: false }
        )
        .limit(limit);

      if (error) {
        console.error(
          'Erreur lecture logs FOODATOI:',
          error
        );

        throw error;
      }

      return data ?? [];
    }
  };
}
