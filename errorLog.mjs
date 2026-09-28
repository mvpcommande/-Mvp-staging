/**
 * Journalisation centralisée des erreurs côté client dans
 * client_error_logs.
 *
 * Objectif (consigne « aucune erreur silencieuse non répertoriée ») :
 * tout échec — exception non gérée, promesse rejetée non gérée, ou
 * simple console.error/console.warn — doit laisser une trace côté
 * serveur, consultable par le staff du restaurant et par une DSI en
 * cas de partenariat, pour diagnostiquer sans accès au navigateur du
 * client.
 *
 * Deux niveaux :
 *   1. logClientError()             -> log explicite et contextualisé.
 *   2. installGlobalErrorLogging()  -> filet global : window.onerror,
 *      unhandledrejection, et interception de console.error/warn.
 *
 * Le logging ne doit JAMAIS devenir lui-même une source d'erreur
 * visible ni entrer en récursion.
 */

export async function logClientError(
  client,
  { restaurantId, context, message, details, page }
) {
  if (!client) {
    return;
  }

  try {
    await client.from('client_error_logs').insert({
      restaurant_id: restaurantId ?? null,
      context,
      message: String(message ?? '').slice(0, 2000),
      details: details ?? null,
      page: page ?? null,
      user_agent:
        typeof navigator !== 'undefined'
          ? navigator.userAgent
          : null
    });
  } catch {
    // Volontairement silencieux : le logging ne doit jamais
    // devenir lui-même une source d'erreur visible.
  }
}

// ---- Filet global -----------------------------------------------------

let installed = false;
// Capture console active. Coupée pendant l'écriture d'un log pour
// éviter toute récursion (une erreur réseau du client Supabase pendant
// qu'on journalise ne doit pas se rejournaliser à l'infini).
let capturing = true;
// Anti-flood : on ne réécrit pas deux fois le même message dans une
// courte fenêtre (protège aussi le quota/coût Supabase).
const recent = new Map();
const DEDUPE_MS = 10000;

function isNew(key) {
  const now = Date.now();
  for (const [k, t] of recent) {
    if (now - t > DEDUPE_MS) recent.delete(k);
  }
  if (recent.has(key)) return false;
  recent.set(key, now);
  return true;
}

export function serializeArg(a) {
  if (a instanceof Error) return a.message || a.name || 'Error';
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Installe le filet global. Idempotent. Sans effet hors navigateur
 * (tests Node) ou sans client Supabase (mode local).
 *
 * @param client            client Supabase
 * @param page              identifiant de page ('client','admin',...)
 * @param getRestaurantId   () => string|null, lu au moment de l'erreur
 */
export function installGlobalErrorLogging(
  client,
  { page, getRestaurantId } = {}
) {
  if (installed || !client || typeof window === 'undefined') {
    return;
  }
  installed = true;

  const rid = () => {
    try {
      return getRestaurantId ? getRestaurantId() ?? null : null;
    } catch {
      return null;
    }
  };

  const emit = (context, message, details) => {
    if (!isNew(context + '|' + message)) return;
    capturing = false;
    Promise.resolve(
      logClientError(client, {
        restaurantId: rid(),
        context,
        message,
        details,
        page:
          page ??
          (typeof location !== 'undefined' ? location.pathname : null)
      })
    ).finally(() => {
      capturing = true;
    });
  };

  window.addEventListener('error', (event) => {
    const err = event.error;
    emit(
      'window.onerror',
      err?.message || event.message || 'Erreur non gérée',
      {
        stack: err?.stack ?? null,
        filename: event.filename ?? null,
        lineno: event.lineno ?? null,
        colno: event.colno ?? null
      }
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    emit(
      'unhandledrejection',
      reason?.message || serializeArg(reason),
      { stack: reason?.stack ?? null }
    );
  });

  // Interception console.error / console.warn : chaque appel est
  // recopié tel quel dans la console PUIS catalogué. Les erreurs déjà
  // « gérées » (catch + console.error) deviennent ainsi répertoriées
  // sans toucher aux ~30 sites d'appel existants.
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (!capturing) return;
      const errArg = args.find((a) => a instanceof Error);
      emit(
        `console.${level}`,
        args.map(serializeArg).join(' ').slice(0, 2000),
        { stack: errArg?.stack ?? null }
      );
    };
  }
}
