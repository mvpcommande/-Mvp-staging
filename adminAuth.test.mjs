import test from 'node:test';
import assert from 'node:assert/strict';
import { signInAdmin, signOutAdmin, getAdminSession } from './adminAuth.mjs';

test('admin login uses Supabase password auth', async () => {
  const calls = [];
  const client = { auth: { signInWithPassword: async (payload) => { calls.push(payload); return { data: { session: { user: { id: 'u1' } } }, error: null }; } } };
  const result = await signInAdmin(client, 'owner@cazfood.fr', 'secret');
  assert.equal(result.user.id, 'u1');
  assert.deepEqual(calls, [{ email: 'owner@cazfood.fr', password: 'secret' }]);
});

test('admin login surfaces Supabase auth errors', async () => {
  const client = { auth: { signInWithPassword: async () => ({ data: { session: null }, error: new Error('Invalid login') }) } };
  await assert.rejects(() => signInAdmin(client, 'x@y.fr', 'bad'), /Invalid login/);
});

test('admin session and logout delegate to Supabase', async () => {
  let signedOut = false;
  const session = { user: { id: 'u1' } };
  const client = { auth: {
    getSession: async () => ({ data: { session } }),
    signOut: async () => { signedOut = true; return { error: null }; }
  } };
  assert.deepEqual(await getAdminSession(client), session);
  await signOutAdmin(client);
  assert.equal(signedOut, true);
});
