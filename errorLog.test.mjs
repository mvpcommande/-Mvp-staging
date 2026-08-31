import test from 'node:test';
import assert from 'node:assert/strict';
import { logClientError } from './errorLog.mjs';

function makeClient() {
  const inserted = [];
  const client = {
    from: (table) => ({
      insert: async (row) => {
        inserted.push([table, row]);
        return { error: null };
      }
    })
  };
  return { client, inserted };
}

test('logClientError writes to client_error_logs with the given fields', async () => {
  const { client, inserted } = makeClient();

  await logClientError(client, {
    restaurantId: 'r1',
    context: 'createOrder',
    message: 'boom',
    details: { code: 'RESTAURANT_CLOSED' },
    page: 'main'
  });

  assert.equal(inserted.length, 1);
  const [table, row] = inserted[0];
  assert.equal(table, 'client_error_logs');
  assert.equal(row.restaurant_id, 'r1');
  assert.equal(row.context, 'createOrder');
  assert.equal(row.message, 'boom');
  assert.deepEqual(row.details, { code: 'RESTAURANT_CLOSED' });
  assert.equal(row.page, 'main');
});

test('logClientError defaults restaurant_id to null when not resolved yet', async () => {
  const { client, inserted } = makeClient();

  await logClientError(client, {
    context: 'resolveRestaurant',
    message: 'Aucun restaurant FOODATOI configuré'
  });

  assert.equal(inserted[0][1].restaurant_id, null);
});

test('logClientError never throws, even if the client itself fails', async () => {
  const client = {
    from: () => ({
      insert: async () => {
        throw new Error('network down');
      }
    })
  };

  await assert.doesNotReject(() =>
    logClientError(client, { context: 'x', message: 'y' })
  );
});

test('logClientError is a no-op without a client (local/demo mode)', async () => {
  await assert.doesNotReject(() =>
    logClientError(null, { context: 'x', message: 'y' })
  );
});
