import test from 'node:test';
import assert from 'node:assert/strict';
import { appendOrder, updateOrderStatus } from './orderStore.mjs';

test('ajoute une commande et lui attribue un numéro', () => {
  const state = appendOrder([], { total: 19.5, customer: { name: 'Test' } });
  assert.equal(state.length, 1);
  assert.match(state[0].number, /^CF-/);
  assert.equal(state[0].status, 'NEW');
});

test('met à jour le statut sans casser la commande', () => {
  const state = appendOrder([], { total: 19.5, customer: { name: 'Test' } });
  const updated = updateOrderStatus(state, state[0].id, 'ACCEPTED');
  assert.equal(updated[0].status, 'ACCEPTED');
  assert.equal(updated[0].total, 19.5);
});
