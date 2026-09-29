/**
 * Parcours d'intégration RusHour de bout en bout sur une pile LOCALE qui
 * reproduit le staging Supabase :
 *
 *   module frontend supabaseStore.mjs (supabase-js, clé anon)
 *     -> PostgREST (même moteur REST que Supabase) -> vraie create_order()
 *     -> trigger -> rushour_order_outbox (Postgres réel)
 *     -> VRAIE Edge Function rushour-dispatch-order (Deno, clé service_role)
 *     -> RushourMockClient -> SENT
 *
 * Deno tourne avec --allow-net limité à la pile locale et --cached-only :
 * tout appel réseau externe (api.rushour.io compris) est IMPOSSIBLE.
 *
 * Les seules manipulations SQL directes (via psql superuser) sont
 * explicitement marquées [TEST-ONLY] : lectures d'assertion, avance du
 * temps (next_attempt_at / locked_at), panne d'enqueue simulée, worker mort
 * simulé. Aucune commande n'est jamais insérée directement dans orders.
 *
 * Variables : E2E_DB_URL, E2E_PGRST_URL, E2E_JWT_SECRET, DENO_BIN.
 */

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseOrderStore } from '../../../../supabaseStore.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DB_URL = process.env.E2E_DB_URL;
const PGRST_URL = process.env.E2E_PGRST_URL;
const JWT_SECRET = process.env.E2E_JWT_SECRET;
const DENO = process.env.DENO_BIN ?? 'deno';
const GATEWAY_PORT = 54321;
const FUNCTION_PORT = 8000;
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`;
const DISPATCH_SECRET = randomBytes(32).toString('hex'); // jamais affiché

const RESTO_A = 'e2e00000-0000-4000-8000-00000000000a';
const RESTO_B = 'e2e00000-0000-4000-8000-00000000000b';
const P1 = 'e2e10000-0000-4000-8000-000000000001';
const P2 = 'e2e10000-0000-4000-8000-000000000002';
const P3 = 'e2e10000-0000-4000-8000-000000000003';
const PB = 'e2e10000-0000-4000-8000-0000000000b1';

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`ok - ${label}`);
  else { failures += 1; console.log(`FAIL - ${label}`); }
}

// --- JWT HS256 (comme les clés anon / service_role Supabase) -------------
const b64url = buf => Buffer.from(buf).toString('base64url');
function jwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }));
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const ANON_KEY = jwt({ role: 'anon' });
const SERVICE_KEY = jwt({ role: 'service_role' });

// --- [TEST-ONLY] psql superuser -------------------------------------------
function sql(query) {
  return execFileSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', DB_URL, '-c', query], { encoding: 'utf8' }).trim();
}
const one = query => sql(query).split('\n')[0];

// --- Passerelle locale : /rest/v1 -> PostgREST, /functions/v1 -> Deno -----
function startGateway() {
  const server = http.createServer((req, res) => {
    let target;
    if (req.url.startsWith('/rest/v1/')) target = new URL(req.url.slice('/rest/v1'.length), PGRST_URL);
    else if (req.url.startsWith('/functions/v1/rushour-dispatch-order')) target = new URL('/', `http://127.0.0.1:${FUNCTION_PORT}`);
    else { res.writeHead(404).end(); return; }
    const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502).end(); });
    req.pipe(upstream);
  });
  return new Promise(resolve => server.listen(GATEWAY_PORT, '127.0.0.1', () => resolve(server)));
}

// --- Edge Function réelle sous Deno ----------------------------------------
const fnDir = mkdtempSync(join(tmpdir(), 'rushour-fn-'));
cpSync(join(ROOT, 'supabase/functions/rushour-dispatch-order'), join(fnDir, 'rushour-dispatch-order'), { recursive: true });
cpSync(join(ROOT, 'supabase/functions/_shared'), join(fnDir, '_shared'), { recursive: true });
let fnProc = null;

async function startFunction(extraEnv = {}) {
  await stopFunction();
  fnProc = spawn(DENO, [
    'run', '--no-lock', '--cached-only',
    `--allow-net=0.0.0.0:${FUNCTION_PORT},127.0.0.1:${GATEWAY_PORT}`,
    '--allow-env',
    'rushour-dispatch-order/index.ts'
  ], {
    cwd: fnDir,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SUPABASE_URL: GATEWAY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      RUSHOUR_DISPATCH_SECRET: DISPATCH_SECRET,
      RUSHOUR_MODE: 'mock',
      RUSHOUR_SEND_TIMEOUT_MS: '1500',
      ...extraEnv
    }
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${FUNCTION_PORT}/`); return; } catch { await sleep(100); }
  }
  throw new Error('Edge Function locale non démarrée');
}
async function stopFunction() {
  if (!fnProc) return;
  const p = fnProc; fnProc = null;
  p.kill('SIGTERM');
  await new Promise(r => p.once('exit', r));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function invoke({ limit = 10, secret = DISPATCH_SECRET } = {}) {
  const res = await fetch(`${GATEWAY}/functions/v1/rushour-dispatch-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rushour-dispatch-secret': secret },
    body: JSON.stringify({ limit })
  });
  return { status: res.status, body: await res.json() };
}

// --- Chemin client réel : module frontend + clé anon ------------------------
const anon = createClient(GATEWAY, ANON_KEY, { auth: { persistSession: false } });
const service = createClient(GATEWAY, SERVICE_KEY, { auth: { persistSession: false } });
const storeA = createSupabaseOrderStore(anon, RESTO_A);

function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
}
let phoneSeq = 0;
async function placeOrder(items, { idempotencyKey = randomUUID(), store = storeA } = {}) {
  phoneSeq += 1;
  return store.createOrder({
    customer: { name: 'Client Test E2E', phone: `07${String(10_000_000 + phoneSeq * 7919).slice(-8)}`, pickupTime: '12:30', pickupDate: tomorrow() },
    items,
    notes: 'Test E2E RusHour',
    idempotencyKey
  });
}
const item = (id, quantity, options = {}) => ({ id, name: 'x', quantity, options });

const outbox = orderId => {
  const row = one(`select status || '|' || attempts || '|' || coalesce(external_order_id, '') || '|' || export_key || '|'
    || coalesce(last_error_category, '') || '|' || coalesce(last_error_code, '') || '|'
    || extract(epoch from (next_attempt_at - now()))::int
    from public.rushour_order_outbox where order_id = '${orderId}'`);
  if (!row) return null;
  const [status, attempts, external, exportKey, category, code, dueIn] = row.split('|');
  return { status, attempts: Number(attempts), external, exportKey, category, code, dueIn: Number(dueIn) };
};
const outboxCount = orderId => Number(one(`select count(*) from public.rushour_order_outbox where order_id = '${orderId}'`));
const forceDue = orderId => sql(`update public.rushour_order_outbox set next_attempt_at = now() where order_id = '${orderId}'`); // [TEST-ONLY]

async function main() {
  const gateway = await startGateway();
  try {
    await scenarios();
  } finally {
    await stopFunction();
    gateway.close();
    rmSync(fnDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '# ALL RUSHOUR E2E (LOCAL STACK) PASSED' : `# ${failures} E2E FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenarios() {
  // ---------------------------------------------------------------- accès
  await startFunction();
  check((await invoke({ secret: 'wrong' })).status === 401, 'Edge Function : mauvais secret -> 401');
  const noHeader = await fetch(`${GATEWAY}/functions/v1/rushour-dispatch-order`, { method: 'POST', headers: { Authorization: `Bearer ${ANON_KEY}` } });
  check(noHeader.status === 401, 'Edge Function : JWT anon sans secret -> 401');

  // ---------------------------------------------------------- happy path
  const order = await placeOrder([
    item(P1, 2, { meat: 'Poulet', sauce: 'Blanche', groups: [{ label: 'Pain', choice: 'Galette' }] }),
    item(P2, 1),
    item(P3, 3)
  ], { idempotencyKey: 'e2e-happy-key' });
  check(order.total === 2 * 8.5 + 9 + 3 * 2, 'happy : create_order() via le module frontend, total calculé serveur');
  check(one(`select count(*) from public.orders where id = '${order.id}'`) === '1', 'happy : A. orders = 1 commande');
  check(one(`select count(*) || '/' || sum(quantity) || '/' || sum(line_total_cents) from public.order_items where order_id = '${order.id}'`) === '3/6/3200',
    'happy : B. order_items corrects (3 lignes, 6 articles, 3200 cts)');
  check(outbox(order.id)?.status === 'PENDING', 'happy : C. outbox PENDING initialement');
  const again = await placeOrder([item(P1, 2)], { idempotencyKey: 'e2e-happy-key' });
  check(again.id === order.id && outboxCount(order.id) === 1, 'happy : idempotence checkout préservée, une seule outbox');

  const r1 = await invoke();
  check(r1.status === 200 && r1.body.mode === 'mock' && r1.body.sent === 1, 'happy : D. dispatcher (Edge Function) exécuté, mode mock');
  const sent = outbox(order.id);
  check(sent.status === 'SENT' && sent.attempts === 1, 'happy : E. outbox SENT');
  check(/^mock_[0-9a-f]{16}$/.test(sent.external), 'happy : F. external_order_id = mock_…');
  check(one(`select string_agg(step || ':' || outcome, ',' order by id) from public.rushour_sync_events where order_id = '${order.id}'`) === 'COMPLETE:SENT',
    'happy : G. rushour_sync_events cohérents');
  check(one(`select count(*) from public.orders where idempotency_key = 'e2e-happy-key'`) === '1' && outboxCount(order.id) === 1,
    'happy : H/I. aucune 2e commande, aucune 2e outbox');

  // ------------------------------------------------------- double dispatch
  const claimedAgain = [await invoke(), await invoke(), await invoke()].reduce((a, r) => a + r.body.claimed, 0);
  const after = outbox(order.id);
  check(claimedAgain === 0 && after.status === 'SENT' && after.attempts === 1 && after.exportKey === sent.exportKey
    && after.external === sent.external && outboxCount(order.id) === 1, 'double dispatch x3 : un seul export logique, clé et external_order_id stables');

  // ------------------------------------------------------------- timeout
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'timeout' });
  const tOrder = await placeOrder([item(P1, 1), item(P2, 1)]);
  const t1 = await invoke();
  const tRow = outbox(tOrder.id);
  check(t1.body.retryScheduled === 1 && tRow.status === 'PENDING' && tRow.category === 'TIMEOUT' && tRow.dueIn >= 3 && tRow.dueIn <= 6,
    'timeout : PENDING -> SENDING -> retry programmé à ~5 s');
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'success' });
  check((await invoke()).body.claimed === 0, 'timeout : pas de reprise avant l’échéance (pas de martèlement)');
  await sleep(5500);
  await invoke();
  const tDone = outbox(tOrder.id);
  check(tDone.status === 'SENT' && tDone.attempts === 2 && tDone.exportKey === tRow.exportKey && outboxCount(tOrder.id) === 1,
    'timeout -> retry (vraie attente 5 s) -> SENT, même clé, sans nouvelle commande ni outbox');

  // ------------------------------------------------- timeout_after_accept
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'timeout_after_accept,success' });
  const aOrder = await placeOrder([item(P3, 1)]);
  await invoke();
  const aRow = outbox(aOrder.id);
  check(aRow.status === 'PENDING' && aRow.category === 'TIMEOUT', 'timeout_after_accept : le mock a reçu la commande, Foodatoi voit un timeout');
  await sleep(5500);
  await invoke();
  const aDone = outbox(aOrder.id);
  check(aDone.status === 'SENT' && aDone.exportKey === aRow.exportKey && outboxCount(aOrder.id) === 1,
    'timeout_after_accept : retry avec la MÊME clé -> SENT');
  check(one(`select count(*) from public.rushour_sync_events where order_id = '${aOrder.id}' and message like '%doublon%'`) === '1',
    'timeout_after_accept : le mock (dédup par clé) signale un doublon -> 1 seul export logique côté mock');

  // ------------------------------------------------------------- HTTP 500
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'http_500,success' });
  const eOrder = await placeOrder([item(P2, 2)]);
  await invoke();
  const eRow = outbox(eOrder.id);
  check(eRow.status === 'PENDING' && eRow.code === 'HTTP_500' && eRow.category === 'RETRYABLE', 'HTTP 500 : retry programmé');
  await sleep(5500);
  await invoke();
  check(outbox(eOrder.id).status === 'SENT', 'HTTP 500 -> retry -> SENT');

  // ------------------------------------------------------------- HTTP 429
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'http_429,success', RUSHOUR_MOCK_RETRY_AFTER_SECONDS: '90' });
  const rOrder = await placeOrder([item(P1, 1)]);
  await invoke();
  const rRow = outbox(rOrder.id);
  check(rRow.status === 'PENDING' && rRow.category === 'RATE_LIMIT' && rRow.dueIn >= 85 && rRow.dueIn <= 91,
    `HTTP 429 + Retry-After 90 s : next_attempt_at respecte le délai (≈${rRow.dueIn} s, pas 5 s)`);
  check((await invoke()).body.claimed === 0, 'HTTP 429 : aucune nouvelle tentative avant Retry-After');
  forceDue(rOrder.id); // [TEST-ONLY] avance du temps
  await invoke();
  check(outbox(rOrder.id).status === 'SENT', 'HTTP 429 -> échéance atteinte -> SENT');

  // ------------------------------------------------------------- HTTP 400
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'http_400' });
  const bOrder = await placeOrder([item(P1, 1)]);
  await invoke();
  forceDue(bOrder.id); // [TEST-ONLY] même "échu", une FAILED n'est jamais reprise
  const b2 = await invoke();
  const bRow = outbox(bOrder.id);
  check(bRow.status === 'FAILED' && bRow.attempts === 1 && bRow.code === 'HTTP_400' && b2.body.claimed === 0,
    'HTTP 400 : FAILED, 1 seule tentative, aucun retry automatique');

  // ------------------------------------------------------------- HTTP 401
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'http_401,success' });
  const uOrder = await placeOrder([item(P2, 1)]);
  await invoke();
  const uRow = outbox(uOrder.id);
  check(uRow.status === 'PENDING' && uRow.category === 'AUTH_ERROR' && uRow.dueIn >= 595 && uRow.dueIn <= 601,
    'HTTP 401 : AUTH_ERROR, retry espacé de 10 min');
  forceDue(uOrder.id); // [TEST-ONLY]
  await invoke();
  const uDone = outbox(uOrder.id);
  check(uDone.status === 'SENT' && uDone.attempts === 2 && uDone.attempts <= 5, 'HTTP 401 -> retry -> SENT dans la limite maxAttempts');

  // ------------------------------------------------------ mapping manquant
  await startFunction({ RUSHOUR_MOCK_SCENARIO: 'success' });
  sql(`delete from public.rushour_product_mappings where product_id = '${P3}'`);
  const mOrder = await placeOrder([item(P1, 1), item(P3, 1)]);
  await invoke();
  const mRow = outbox(mOrder.id);
  check(one(`select count(*) from public.orders where id = '${mOrder.id}'`) === '1' && mRow.status === 'FAILED'
    && mRow.category === 'MAPPING_ERROR' && mRow.code === 'PRODUCT_NOT_MAPPED',
    'mapping manquant : FAIL CLOSED (commande conservée, outbox FAILED, rien envoyé)');
  const { error: mapErr } = await service.from('rushour_product_mappings')
    .insert({ restaurant_id: RESTO_A, product_id: P3, rushour_product_id: 'mock-rh-product-3' });
  const { data: requeued, error: rqErr } = await service.rpc('rushour_requeue', { p_order_id: mOrder.id });
  check(!mapErr && !rqErr && requeued === true, 'mapping ajouté (service_role) + rushour_requeue');
  await invoke();
  const mDone = outbox(mOrder.id);
  check(mDone.status === 'SENT' && outboxCount(mOrder.id) === 1, 'mapping manquant -> mapping -> requeue -> SENT');

  // ------------------------------------------------ intégration désactivée
  await service.from('restaurant_rushour_connections').update({ enabled: false }).eq('restaurant_id', RESTO_A);
  const dOrder = await placeOrder([item(P1, 1)]);
  check(one(`select count(*) from public.orders where id = '${dOrder.id}'`) === '1' && outboxCount(dOrder.id) === 0,
    'intégration désactivée : commande créée, aucune outbox (aucun export actif)');
  await service.from('restaurant_rushour_connections').update({ enabled: true }).eq('restaurant_id', RESTO_A);
  const { data: rec1 } = await service.rpc('rushour_reconcile', {});
  const { data: rec2 } = await service.rpc('rushour_reconcile', {});
  check(rec1 === 1 && rec2 === 0 && outboxCount(dOrder.id) === 1, 'réactivée + réconciliation : récupérée exactement une fois (2e passage = 0)');
  await invoke();
  check(outbox(dOrder.id).status === 'SENT', 'commande de la coupure -> SENT');

  // ------------------------------------------ panne d'enqueue + réconciliation
  sql(`create or replace function public.e2e_boom() returns trigger language plpgsql as $$ begin raise exception 'outage'; end $$;
       create trigger e2e_boom before insert on public.rushour_order_outbox for each row execute function public.e2e_boom();`); // [TEST-ONLY]
  let fOrder;
  try {
    fOrder = await placeOrder([item(P1, 1), item(P2, 1)]);
  } finally {
    sql(`drop trigger if exists e2e_boom on public.rushour_order_outbox; drop function if exists public.e2e_boom();`);
  }
  check(one(`select count(*) from public.orders where id = '${fOrder.id}'`) === '1' && outboxCount(fOrder.id) === 0,
    'panne d’enqueue : order EXISTS, outbox DOES NOT EXIST (client non pénalisé)');
  check(one(`select count(*) from public.rushour_sync_events where order_id = '${fOrder.id}' and outcome = 'ENQUEUE_FAILED'`) === '1',
    'panne d’enqueue : ENQUEUE_FAILED journalisé');
  const { data: fr1 } = await service.rpc('rushour_reconcile', {});
  check(fr1 === 1 && outboxCount(fOrder.id) === 1, 'réconciliation n°1 : EXACTLY ONCE');
  const { data: fr2 } = await service.rpc('rushour_reconcile', {});
  check(fr2 === 0 && outboxCount(fOrder.id) === 1, 'réconciliation n°2 : toujours EXACTLY ONE');
  await invoke();
  check(outbox(fOrder.id).status === 'SENT', 'degraded path -> réconciliation -> SENT');

  // ----------------------------------------------------------- concurrence
  const burst = [];
  for (let i = 0; i < 12; i++) burst.push(await placeOrder([item(P1, 1)]));
  const results = await Promise.all([invoke({ limit: 5 }), invoke({ limit: 5 }), invoke({ limit: 5 })]);
  let claimed = results.reduce((a, r) => a + r.body.claimed, 0);
  claimed += (await invoke({ limit: 25 })).body.claimed;
  const ids = burst.map(o => `'${o.id}'`).join(',');
  check(claimed === 12, `concurrence : 3 invocations simultanées + 1 -> 12 réclamations pour 12 commandes`);
  check(one(`select count(*) filter (where status = 'SENT' and attempts = 1) from public.rushour_order_outbox where order_id in (${ids})`) === '12',
    'concurrence : 12 SENT, attempts = 1 (aucune entrée traitée deux fois)');
  check(one(`select count(*) from public.rushour_sync_events where order_id in (${ids}) and step = 'COMPLETE'`) === '12',
    'concurrence : exactement 1 envoi journalisé par commande');

  // ------------------------------------------------------------ lease
  const lOrder = await placeOrder([item(P2, 1)]);
  const { data: claimedRows } = await service.rpc('rushour_claim_outbox', { p_worker_id: 'e2e-dead-worker', p_limit: 1 });
  check(claimedRows?.length === 1 && claimedRows[0].order_id === lOrder.id, 'lease : worker A réclame la commande puis "disparaît"');
  check((await invoke()).body.claimed === 0 && outbox(lOrder.id).status === 'SENDING', 'lease : entrée reste SENDING, non reprise tant que le bail court');
  sql(`update public.rushour_order_outbox set locked_at = now() - interval '11 minutes' where order_id = '${lOrder.id}'`); // [TEST-ONLY]
  await invoke();
  const lDone = outbox(lOrder.id);
  check(lDone.status === 'SENT' && lDone.attempts === 2 && lDone.exportKey === claimedRows[0].export_key,
    'lease : bail expiré -> nouveau worker reprend -> SENT, même clé');
  const { data: lateMark } = await service.rpc('rushour_mark_sent', { p_outbox_id: claimedRows[0].id, p_worker_id: 'e2e-dead-worker', p_external_order_id: null });
  check(lateMark === false, 'lease : l’ancien worker ne peut plus marquer SENT');

  // ------------------------------------------------------ RLS via PostgREST
  const bOrderNeighbour = await placeOrder([{ id: PB, name: 'x', quantity: 1, options: {} }], { store: createSupabaseOrderStore(anon, RESTO_B) });
  check(outboxCount(bOrderNeighbour.id) === 1, 'restaurant B : sa propre outbox (multi-tenant)');
  const anonRead = await anon.from('rushour_order_outbox').select('id');
  check(!!anonRead.error, 'RLS : anon SELECT outbox refusé');
  const anonInsert = await anon.from('restaurant_rushour_connections').insert({ restaurant_id: RESTO_B, rushour_integration_id: 'evil', enabled: true });
  check(!!anonInsert.error, 'RLS : anon INSERT connection refusé');
  const anonUpdate = await anon.from('rushour_order_outbox').update({ status: 'SENT' }).eq('order_id', bOrderNeighbour.id);
  check(!!anonUpdate.error && outbox(bOrderNeighbour.id).status === 'PENDING', 'RLS : anon UPDATE outbox refusé');
  const anonRpc = await anon.rpc('rushour_reconcile', {});
  check(!!anonRpc.error, 'RLS : anon ne peut pas appeler rushour_reconcile');

  const adminA = createClient(GATEWAY, jwt({ role: 'authenticated', sub: randomUUID(),
    app_metadata: { role: 'restaurant_admin', restaurant_id: RESTO_A } }), { auth: { persistSession: false } });
  const adminRows = await adminA.from('rushour_order_outbox').select('restaurant_id');
  check(!adminRows.error && adminRows.data.length > 0 && adminRows.data.every(r => r.restaurant_id === RESTO_A),
    'RLS : admin A voit uniquement l’outbox de A (pas B)');
  const adminWrite = await adminA.from('restaurant_rushour_connections').update({ enabled: false }).eq('restaurant_id', RESTO_A);
  check(!!adminWrite.error, 'RLS : admin restaurant ne peut pas modifier la config RusHour');

  const customer = createClient(GATEWAY, jwt({ role: 'authenticated', sub: randomUUID(), app_metadata: { role: 'customer' } }),
    { auth: { persistSession: false } });
  const custRows = await customer.from('rushour_order_outbox').select('id');
  const custRpc = await customer.rpc('rushour_requeue', { p_order_id: bOrderNeighbour.id });
  check(!custRows.error && custRows.data.length === 0 && !!custRpc.error, 'RLS : authenticated non-admin ne voit rien et n’administre rien');

  // --------------------------------------------------------------- bilan
  check(one(`select count(*) from public.rushour_order_outbox group by order_id having count(*) > 1`) === '',
    'global : aucune commande avec deux outbox');
}

main().catch(async err => {
  console.error('E2E driver error:', err?.message ?? err);
  await stopFunction();
  process.exit(1);
});
