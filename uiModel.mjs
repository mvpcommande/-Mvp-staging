export function buildTicketModel(order) {
  return {
    number: order.number ?? order.order_number,
    pickup: order.customer?.pickupTime ?? order.pickup_time ?? '—',
    totalLabel: `${Number(order.total ?? (order.total_cents ?? 0) / 100).toFixed(2).replace('.', ',')} €`,
    items: (order.items ?? order.order_items ?? []).map(item => ({
      quantity: item.quantity,
      name: item.name ?? item.product_name,
      options: item.options?.meat ?? ''
    }))
  };
}

export function getNextStatusLabel(status) {
  return ({ NEW: 'Accepter', ACCEPTED: 'Mettre en préparation', PREPARING: 'Marquer prête' })[status] ?? null;
}
