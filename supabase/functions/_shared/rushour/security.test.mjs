// W. Aucune fuite de secret : logs, payload, erreurs, frontend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact, redactString, buildSyncEvent } from './logging.mjs';
import { runDispatchBatch } from './dispatcher.mjs';
import { InMemoryOutbox } from './inMemoryOutbox.mjs';
import { RushourError, ErrorCategory } from './errors.mjs';
import { RushourMockClient } from './mockClient.mjs';
import { CONNECTIONS, PRODUCT_MAPPINGS, simpleOrderA, FAKE_SECRETS } from './fixtures.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('W. redact : clés sensibles et motifs masqués, profondeur bornée', () => {
  const input = {
    appSecret: FAKE_SECRETS.appSecret,
    access_token: FAKE_SECRETS.accessToken,
    refresh_token: 'r', Authorization: 'Bearer x', client_secret: 's', cardNumber: '4111111111111111',
    nested: { note: `Authorization: Bearer ${FAKE_SECRETS.accessToken}`, fine: 'ok', company: 'Caz Food' }
  };
  const out = JSON.stringify(redact(input));
  assert.doesNotMatch(out, /DO-NOT-LEAK|4111111111111111/);
  assert.match(out, /"fine":"ok"/);
  assert.match(out, /"company":"Caz Food"/, 'pas de faux positif sur "company"');

  assert.doesNotMatch(redactString(`app_secret=${FAKE_SECRETS.appSecret}&x=1`), /DO-NOT-LEAK/);
  assert.doesNotMatch(redactString('Basic YXBwSWQ6YXBwU2VjcmV0'), /YXBwSWQ6YXBwU2VjcmV0/);
  assert.doesNotMatch(redactString('card 4111 1111 1111 1111 declined'), /4111 1111/);
  assert.doesNotMatch(redactString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123'), /eyJhbGci/);
  assert.equal(redactString('x'.repeat(2000)).length, 500);
});

test('W. événement de log : liste blanche de champs, jamais de payload', () => {
  const event = buildSyncEvent({
    entry: { id: 'o1', restaurantId: 'r', orderId: 'ord', attempts: 2, payload: { secret: 1 } },
    step: 'SEND', outcome: 'RETRY_SCHEDULED',
    error: new RushourError(ErrorCategory.AUTH_ERROR, 'HTTP_401', `refused token=${FAKE_SECRETS.accessToken}`, { httpStatus: 401 })
  });
  assert.deepEqual(Object.keys(event).sort(), [
    'attempt', 'duration_ms', 'endpoint', 'error_category', 'error_code', 'http_status', 'message', 'order_id', 'outbox_id',
    'restaurant_id', 'outcome', 'step'
  ].sort());
  assert.doesNotMatch(JSON.stringify(event), /DO-NOT-LEAK/);
});

test('W. une erreur transport contenant des secrets n’atteint ni l’outbox ni le journal', async () => {
  const outbox = new InMemoryOutbox({ nowMs: () => 0 });
  outbox.addConnection(CONNECTIONS.A);
  PRODUCT_MAPPINGS.forEach(m => outbox.addProductMapping(m));
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);

  const leakyClient = {
    async sendOrder() {
      throw new RushourError(ErrorCategory.RETRYABLE, 'HTTP_502',
        `upstream echo: Authorization: Bearer ${FAKE_SECRETS.accessToken} app_secret=${FAKE_SECRETS.appSecret}`);
    }
  };
  await runDispatchBatch({ repo: outbox, client: leakyClient, workerId: 'w', limit: 1, timeoutMs: 50 });

  const everything = JSON.stringify({ rows: [...outbox.rows.values()], events: outbox.events });
  assert.doesNotMatch(everything, /DO-NOT-LEAK/);
  assert.match(everything, /REDACTED/);
});

test('W. le payload RusHour ne transporte aucun secret ni credential', async () => {
  const outbox = new InMemoryOutbox({ nowMs: () => 0 });
  outbox.addConnection(CONNECTIONS.A);
  PRODUCT_MAPPINGS.forEach(m => outbox.addProductMapping(m));
  const { order, items } = simpleOrderA();
  await outbox.insertOrder(order, items);
  const client = new RushourMockClient();
  await runDispatchBatch({ repo: outbox, client, workerId: 'w', limit: 1, timeoutMs: 50 });

  const payload = JSON.stringify(client.calls[0].payload);
  assert.doesNotMatch(payload, /secret|token|authorization|password/i);
  assert.ok(!('appSecret' in client.calls[0]) && !('token' in client.calls[0]));
});

function listFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'playwright-report', 'test-results'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

test('W. frontend (bundle Vite) : aucune référence RusHour, aucun VITE_RUSHOUR*', () => {
  const frontend = listFiles(REPO_ROOT).filter(f => {
    const rel = relative(REPO_ROOT, f);
    return !rel.startsWith('supabase') && !rel.startsWith('docs') && !rel.startsWith('e2e')
      && /\.(m?js|html|css)$/.test(rel) && !rel.endsWith('.test.mjs') && !rel.endsWith('.config.mjs');
  });
  assert.ok(frontend.length > 10, 'fichiers frontend trouvés');
  for (const file of frontend) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /rushour/i, `${relative(REPO_ROOT, file)} ne doit pas référencer RusHour`);
  }
});

test('W. bundle construit (dist/, si présent) : aucune trace RusHour', t => {
  const dist = join(REPO_ROOT, 'dist');
  let files;
  try {
    files = listFilesIncludingDist(dist);
  } catch {
    t.skip('dist/ absent : lancer npm run build pour ce contrôle');
    return;
  }
  for (const file of files.filter(f => /\.(js|html|css)$/.test(f))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /rushour/i, relative(REPO_ROOT, file));
  }
});

function listFilesIncludingDist(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFilesIncludingDist(full, acc);
    else acc.push(full);
  }
  return acc;
}

test('W. repo : aucun secret RusHour committé, aucun VITE_ pour RusHour', () => {
  const files = listFiles(REPO_ROOT).filter(f => !/\.(png|jpe?g|webp|gif|ico|pdf|woff2?)$/i.test(f));
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (rel.endsWith('security.test.mjs')) continue; // ce fichier contient les motifs recherchés
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /VITE_RUSHOUR/i, `${rel} : un secret RusHour ne doit jamais être préfixé VITE_`);
    // Affectation d'une valeur littérale à un secret RusHour (hors placeholders documentés).
    assert.doesNotMatch(content, /RUSHOUR_APP_SECRET\s*[:=]\s*['"][A-Za-z0-9]{16,}/, `${rel} : secret RusHour en dur`);
    if (!rel.endsWith('fixtures.mjs')) {
      assert.doesNotMatch(content, /DO-NOT-LEAK/, `${rel} : valeur factice sortie des tests`);
    }
  }
  assert.ok(!files.some(f => /(^|\/)\.env(\.|$)/.test(relative(REPO_ROOT, f)) && !f.endsWith('.example')),
    'aucun fichier .env dans le repo');
});
