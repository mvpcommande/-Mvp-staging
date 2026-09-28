// parse-menu : extrait les produits d'un menu (PDF/photo) via l'API Anthropic
// -> menu_imports.extracted_payload (statut REVIEW). Toute panne est
// enregistrée dans menu_imports.error_message (observabilité).
//
// Déploiement : verify_jwt = false (on gère le CORS pour l'appel navigateur
// depuis foodatoi.fr, ET on valide le JWT nous-mêmes via auth.getUser).
// Secret requis : ANTHROPIC_API_KEY.
import { createClient } from "jsr:@supabase/supabase-js@2.57.0";

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const BUCKET = "restaurant-media";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT = `Tu es un extracteur de menus de restaurant. Lis ce menu et renvoie UNIQUEMENT un tableau JSON valide, sans aucun texte autour, sans backticks.
Chaque élément: {"category": string, "name": string, "price_cents": integer, "description": string|null}.
Règles:
- price_cents = prix en CENTIMES d'euro (12,50€ => 1250).
- Si un plat a plusieurs prix/tailles (petite/grande, pidé/pizza), crée UNE entrée par variante en précisant la variante dans le nom.
- category = la section du menu (Pizzas, Salades, Desserts, Boissons...).
- description = ingrédients si listés, sinon null. Concis.
- Ignore titres décoratifs, mentions légales, allergènes génériques.
Renvoie le tableau JSON complet, rien d'autre.`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method" }, 405);

  let importId: string | null = null;
  try {
    const body = await req.json();
    importId = body?.import_id ?? null;
  } catch (_e) { /* ignore */ }
  if (!importId) return jsonResponse({ error: "missing_import_id" }, 400);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: userData, error: userErr } = await service.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return jsonResponse({ error: "unauthorized" }, 401);
  const jwtResto = (user.app_metadata as Record<string, unknown> | undefined)?.restaurant_id ?? null;

  const { data: imp } = await service
    .from("menu_imports")
    .select("id, restaurant_id, storage_path, source_type")
    .eq("id", importId)
    .maybeSingle();
  if (!imp || !imp.storage_path) return jsonResponse({ error: "not_found" }, 404);

  const fail = async (msg: string, status = 500) => {
    await service.from("menu_imports")
      .update({ status: "FAILED", error_message: msg, updated_at: new Date().toISOString() })
      .eq("id", importId);
    return jsonResponse({ error: msg }, status);
  };

  if (!jwtResto || jwtResto !== imp.restaurant_id) {
    return await fail("forbidden: jwt_resto=" + jwtResto + " import_resto=" + imp.restaurant_id, 403);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return await fail("missing_api_key: secret ANTHROPIC_API_KEY absent", 500);

  try {
    await service.from("menu_imports")
      .update({ status: "PROCESSING", updated_at: new Date().toISOString() })
      .eq("id", importId);

    const { data: blob, error: dlErr } = await service.storage.from(BUCKET).download(imp.storage_path);
    if (dlErr || !blob) return await fail("download_failed: " + (dlErr?.message ?? "blob vide"));

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);

    const path = imp.storage_path.toLowerCase();
    const isPdf = path.endsWith(".pdf") || imp.source_type === "pdf";
    const isPng = path.endsWith(".png");
    const mediaBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: isPng ? "image/png" : "image/jpeg", data: b64 } };

    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 8192,
        messages: [{ role: "user", content: [mediaBlock, { type: "text", text: PROMPT }] }],
      }),
    });
    if (!aiRes.ok) {
      const detail = await aiRes.text();
      return await fail("anthropic_error_" + aiRes.status + ": " + detail.slice(0, 300));
    }
    const ai = await aiRes.json();
    const text = (ai.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text).join("").trim();

    let cleaned = text.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);

    let products: unknown;
    try { products = JSON.parse(cleaned); }
    catch (_e) { return await fail("parse_json_failed: " + cleaned.slice(0, 200)); }
    if (!Array.isArray(products)) return await fail("not_an_array");

    await service.from("menu_imports").update({
      status: "REVIEW", extracted_payload: { products },
      error_message: null, updated_at: new Date().toISOString(),
    }).eq("id", importId);

    return jsonResponse({ status: "REVIEW", count: (products as unknown[]).length, products });
  } catch (e) {
    return await fail("exception: " + (e instanceof Error ? e.message : "unknown"));
  }
});
