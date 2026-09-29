// rushour-dispatch-order : worker de l'outbox RusHour (Bloc RusHour 1 / 1.1).
//
// MODE MOCK UNIQUEMENT. Aucun appel à l'API RusHour réelle n'est possible
// depuis cette version : resolveRuntime() n'accepte que RUSHOUR_MODE=mock,
// renvoie toujours le RushourMockClient et ne lit jamais RUSHOUR_APP_ID /
// RUSHOUR_APP_SECRET, même s'ils sont définis par erreur.
//
// Appel : POST, uniquement par un ordonnanceur serveur (pg_cron + pg_net)
// portant l'en-tête x-rushour-dispatch-secret. Jamais par le navigateur :
// pas de CORS, pas d'auth utilisateur acceptée.
//
// Secrets (Supabase Dashboard -> Edge Functions -> Secrets, jamais dans le
// repo, jamais préfixés VITE_) :
//   RUSHOUR_DISPATCH_SECRET   secret partagé avec l'ordonnanceur (requis, >= 32 car.)
//   RUSHOUR_MODE              "mock" (seule valeur acceptée)
//   RUSHOUR_MOCK_SCENARIO     scénario(s) mock, ex. "success" ou "timeout,success"
//   RUSHOUR_SEND_TIMEOUT_MS   délai d'envoi (500..15000, défaut 10000)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont injectés par Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2.57.0";
import { runDispatchBatch } from "../_shared/rushour/dispatcher.mjs";
import { createSupabaseOutboxRepository } from "../_shared/rushour/supabaseRepository.mjs";
import { checkDispatchAuth, resolveRuntime, RuntimeConfigError } from "../_shared/rushour/runtime.mjs";

const MAX_BATCH = 25;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const getEnv = (name: string) => Deno.env.get(name);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const denied = checkDispatchAuth(getEnv, req.headers.get("x-rushour-dispatch-secret"));
  if (denied) return json({ error: denied.error }, denied.status);

  let runtime;
  try {
    runtime = resolveRuntime(getEnv);
  } catch (e) {
    if (e instanceof RuntimeConfigError) return json({ error: e.code }, e.status);
    return json({ error: "runtime_error" }, 500);
  }

  let limit = 10;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.limit)) limit = Math.min(Math.max(body.limit, 1), MAX_BATCH);
  } catch (_e) { /* corps optionnel */ }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const workerId = `edge:${crypto.randomUUID()}`;
  try {
    const summary = await runDispatchBatch({
      repo: createSupabaseOutboxRepository(db),
      client: runtime.client,
      workerId,
      limit,
      timeoutMs: runtime.timeoutMs,
    });
    return json({ mode: runtime.mode, workerId, ...summary });
  } catch (_e) {
    // Aucun détail interne renvoyé à l'appelant.
    return json({ error: "dispatch_failed", workerId }, 500);
  }
});
