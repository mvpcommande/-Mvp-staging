import { transitionOrder } from './orderWorkflow.mjs';

export function appendOrder(orders, order) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const number = `CF-${String((orders.length + 1)).padStart(3, '0')}`;
  return [...orders, { ...order, id, number, status: 'NEW', createdAt: new Date().toISOString() }];
}

export function updateOrderStatus(orders, id, next) {
  return orders.map(order => {
    if (order.id !== id) return order;
    return { ...order, status: transitionOrder(order.status, next), updatedAt: new Date().toISOString() };
  });
}
