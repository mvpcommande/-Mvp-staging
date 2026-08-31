import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketModel, getNextStatusLabel } from './uiModel.mjs';

test('buildTicketModel creates a compact pickup ticket', () => {
  const model = buildTicketModel({
    number: 'CF-0284',
    total: 16.8,
    customer: { name: 'Kevin', pickupTime: '20:15' },
    items: [{ name: 'Menu tacos double', quantity: 1, price: 16.8, options: { meat: 'Poulet · Kebab' } }]
  });
  assert.equal(model.number, 'CF-0284');
  assert.equal(model.pickup, '20:15');
  assert.equal(model.totalLabel, '16,80 €');
  assert.deepEqual(model.items[0], { quantity: 1, name: 'Menu tacos double', options: 'Poulet · Kebab' });
});

test('getNextStatusLabel maps the kitchen workflow', () => {
  assert.equal(getNextStatusLabel('NEW'), 'Accepter');
  assert.equal(getNextStatusLabel('ACCEPTED'), 'Mettre en préparation');
  assert.equal(getNextStatusLabel('PREPARING'), 'Marquer prête');
  assert.equal(getNextStatusLabel('READY'), null);
});
