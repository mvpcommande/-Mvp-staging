// rushour-dispatch-order : worker de l'outbox RusHour (Bloc RusHour 1).
//
// MODE MOCK UNIQUEMENT. Aucun appel à l'API RusHour réelle n'est possible
// depuis cette version : RUSHOUR_MODE != "mock" => refus 503, et
// RushourHttpClient refuse de s'instancier tant que le schéma n'est pas
// vérifié (voir _shared/rushour/client.mjs).
//
// Appel : POST, uniquement par un ordonnanceur serveur (pg_cron + pg_net,
// ou un cron externe) portant l'en-tête x-rushour-dispatch-secret. Jamais
// par le navigateur : pas de CORS, pas d'auth utilisateur acceptée.
//
// Secrets (Supabase Dashboard -> Edge Functions -> Secrets, jamais dans le
// repo, jamais préfixés VITE_) :
//   RUSHOUR_DISPATCH_SECRET   secret partagé avec l'ordonnanceur (requis)
//   RUSHOUR_MODE              "mock" (seule valeur acceptée dans ce bloc)
//   RUSHOUR_MOCK_SCENARIO     scénario mock (défaut "success")
// Bloc 2 seulement : RUSHOUR_APP_ID, RUSHOUR_APP_SECRET.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont injectés par Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2.57.0";
import { runDispatchBatch } from "../_shared/rushour/dispatcher.mjs";
import { RushourMockClient, MOCK_SCENARIOS } from "../_shared/rushour/mockClient.mjs";
import { createSupabaseOutboxRepository } from "../_shared/rushour/supabaseRepository.mjs";

const MAX_BATCH = 25;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Comparaison à temps constant (pas de fuite par timing du secret).
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const expected = Deno.env.get("RUSHOUR_DISPATCH_SECRET") ?? "";
  if (expected.length < 32) {
    // Fail closed : sans secret correctement configuré, personne n'entre.
    return json({ error: "dispatcher_not_configured" }, 503);
  }
  const provided = req.headers.get("x-rushour-dispatch-secret") ?? "";
  if (!safeEqual(provided, expected)) return json({ error: "unauthorized" }, 401);

  const mode = Deno.env.get("RUSHOUR_MODE") ?? "mock";
  if (mode !== "mock") {
    return json({ error: "real_mode_not_available", detail: "Bloc RusHour 2 requis" }, 503);
  }

  const scenario = Deno.env.get("RUSHOUR_MOCK_SCENARIO") ?? "success";
  if (!MOCK_SCENARIOS.includes(scenario)) return json({ error: "invalid_mock_scenario" }, 500);

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
      client: new RushourMockClient({ scenarios: [scenario], nowMs: () => Date.now() }),
      workerId,
      limit,
    });
    return json({ mode, workerId, ...summary });
  } catch (_e) {
    // Aucun détail interne renvoyé à l'appelant.
    return json({ error: "dispatch_failed", workerId }, 500);
  }
});
