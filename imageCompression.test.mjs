import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompressionOptions } from './imageCompression.mjs';

test('resolveCompressionOptions: logos get a smaller max dimension than product photos', () => {
  const logo = resolveCompressionOptions('logo');
  const product = resolveCompressionOptions('product');

  assert.equal(logo.maxDimension, 600);
  assert.equal(product.maxDimension, 1600);
  assert.ok(logo.quality > 0 && logo.quality <= 1);
  assert.ok(product.quality > 0 && product.quality <= 1);
});

test('resolveCompressionOptions defaults to product settings for an unknown kind', () => {
  assert.deepEqual(resolveCompressionOptions('other'), resolveCompressionOptions('product'));
});
