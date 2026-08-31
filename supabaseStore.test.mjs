import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseOrderStore } from './supabaseStore.mjs';

const RESTAURANT_ID = 'a1b2c3d4-e5f6-4a1b-8c2d-1234567890ab';
const PRODUCT_ID = 'b2c3d4e5-f6a7-4b2c-9d3e-234567890abc';

function makeClient(rpcResult) {
  const calls = [];
  const client = {
    rpc(fn, args) {
      calls.push([fn, args]);
      return { single: async () => rpcResult };
    }
  };
  return { client, calls };
}

test('createSupabaseOrderStore requires a valid restaurant UUID', () => {
  assert.throws(() => createSupabaseOrderStore({}), /restaurantId/);
  assert.throws(() => createSupabaseOrderStore({}, 'not-a-uuid'), /restaurantId/);
});

test('createOrder calls create_order with product ids/quantities only, never a client price', async () => {
  const { client, calls } = makeClient({
    data: { id: 'order-1', order_number: 'FA-260824-ab12cd', status: 'NEW', total_cents: 3360 },
    error: null
  });

  const store = createSupabaseOrderStore(client, RESTAURANT_ID);

  const result = await store.createOrder({
    customer: { name: 'Kevin', phone: '0600000000', pickupTime: '20:15' },
    // price/name here are what a tampered client might send; the RPC must not receive them.
    items: [{ id: PRODUCT_ID, name: 'FAKE FREE ITEM', price: 0, quantity: 2, options: { meat: 'Kebab' } }],
    total: 0
  });

  assert.equal(calls[0][0], 'create_order');
  const args = calls[0][1];
  assert.equal(args.p_restaurant_id, RESTAURANT_ID);
  assert.deepEqual(args.p_items, [
    { product_id: PRODUCT_ID, quantity: 2, options: { meat: 'Kebab' } }
  ]);
  assert.equal('price' in args.p_items[0], false);
  assert.equal('name' in args.p_items[0], false);

  assert.equal(result.orderNumber, 'FA-260824-ab12cd');
  assert.equal(result.total, 33.6);
});

test('createOrder rejects an item without a real product id instead of sending it through', async () => {
  const { client } = makeClient({ data: null, error: null });
  const store = createSupabaseOrderStore(client, RESTAURANT_ID);

  await assert.rejects(
    () =>
      store.createOrder({
        customer: { name: 'Kevin', phone: '0600000000' },
        items: [{ id: 'not-a-product-uuid', name: 'Mystery item', price: 1, quantity: 1 }],
        total: 1
      }),
    /référence produit valide/
  );
});

test('createOrder surfaces errors from create_order (e.g. inactive product)', async () => {
  const { client } = makeClient({
    data: null,
    error: { message: 'PRODUCT_NOT_FOUND' }
  });
  const store = createSupabaseOrderStore(client, RESTAURANT_ID);

  await assert.rejects(() =>
    store.createOrder({
      customer: { name: 'Kevin' },
      items: [{ id: PRODUCT_ID, quantity: 1 }],
      total: 1
    })
  );
});
