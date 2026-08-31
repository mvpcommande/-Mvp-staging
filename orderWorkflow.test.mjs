import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionOrder } from './orderWorkflow.mjs';

test('une commande passe de nouvelle à acceptée puis prête', () => {
  assert.equal(transitionOrder('NEW', 'ACCEPTED'), 'ACCEPTED');
  assert.equal(transitionOrder('ACCEPTED', 'PREPARING'), 'PREPARING');
  assert.equal(transitionOrder('PREPARING', 'READY'), 'READY');
});

test('une commande ne peut pas revenir à un état précédent', () => {
  assert.throws(() => transitionOrder('READY', 'PREPARING'), /Transition invalide/);
});
