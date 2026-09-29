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

test('updateRestaurantColor calls the plan-gated RPC with the right parameters', async () => {
  const { updateRestaurantColor } = await import('./restaurantOwner.mjs');
  let captured = null;

  const fakeClient = {
    rpc: async (name, args) => {
      captured = { name, args };
      return { error: null };
    }
  };

  await updateRestaurantColor(fakeClient, 'resto-1', '#e84d27');

  assert.equal(captured.name, 'update_restaurant_branding');
  assert.deepEqual(captured.args, {
    p_restaurant_id: 'resto-1',
    p_primary_color: '#e84d27'
  });
});

test('updateRestaurantColor throws when the RPC returns an error (e.g. plan too low)', async () => {
  const { updateRestaurantColor } = await import('./restaurantOwner.mjs');

  const fakeClient = {
    rpc: async () => ({ error: new Error('PLAN_TOO_LOW') })
  };

  await assert.rejects(
    () => updateRestaurantColor(fakeClient, 'resto-1', '#000000'),
    /PLAN_TOO_LOW/
  );
});

test('uploadRestaurantLogo uploads to storage then calls the branding RPC with the resulting public URL', async () => {
  const { uploadRestaurantLogo } = await import('./restaurantOwner.mjs');
  let rpcCall = null;

  const fakeClient = {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://x/logo.jpg' } })
      })
    },
    rpc: async (name, args) => {
      rpcCall = { name, args };
      return { error: null };
    }
  };

  const url = await uploadRestaurantLogo(fakeClient, 'resto-1', { name: 'logo.jpg' });

  assert.equal(url, 'https://x/logo.jpg');
  assert.equal(rpcCall.name, 'update_restaurant_branding');
  assert.equal(rpcCall.args.p_restaurant_id, 'resto-1');
  assert.equal(rpcCall.args.p_logo_url, 'https://x/logo.jpg');
});
