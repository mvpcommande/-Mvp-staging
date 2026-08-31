import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail, slugify } from './restaurantOwner.mjs';

test('isValidEmail accepts a plausible email and rejects garbage', () => {
  assert.equal(isValidEmail('kevin@cazfood.fr'), true);
  assert.equal(isValidEmail('pas-un-email'), false);
  assert.equal(isValidEmail(''), false);
});

test('slugify turns a restaurant name into a URL-safe slug', () => {
  assert.equal(slugify('Le Bon Kebab'), 'le-bon-kebab');
  assert.equal(slugify('Chez André & Fils'), 'chez-andre-fils');
  assert.equal(slugify('  Pizzé Truck!  '), 'pizze-truck');
  assert.equal(slugify(''), '');
});
