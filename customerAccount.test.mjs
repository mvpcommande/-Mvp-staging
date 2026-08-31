import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail } from './customerAccount.mjs';

test('isValidEmail accepts a plausible email and rejects garbage', () => {
  assert.equal(isValidEmail('kevin@cazfood.fr'), true);
  assert.equal(isValidEmail('kevin@cazfood'), false);
  assert.equal(isValidEmail('kevin'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
});
