export function addItem(cart, item) {
  return [...cart, { ...item, quantity: item.quantity ?? 1 }];
}

export function calculateTotal(items) {
  return Number(items.reduce((sum, item) => sum + item.price * item.quantity, 0).toFixed(2));
}

export function createOrder(items, customer, numberGenerator = () => Date.now()) {
  return {
    number: `#${numberGenerator()}`,
    type: customer?.fulfillmentType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
    status: 'NEW',
    items,
    customer,
    total: calculateTotal(items),
    createdAt: new Date().toISOString()
  };
}
