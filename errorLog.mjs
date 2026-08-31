/**
 * Journalise une erreur côté client dans client_error_logs, pour
 * les échecs qui, sinon, ne vivent que dans la console du navigateur
 * de qui que ce soit ait été en train de regarder au mauvais moment
 * (résolution restaurant, canal realtime, création de commande...).
 *
 * Ne doit jamais faire planter l'appelant : un souci réseau pendant
 * qu'on journalise un souci réseau ne doit pas devenir une deuxième
 * erreur visible pour le client.
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
