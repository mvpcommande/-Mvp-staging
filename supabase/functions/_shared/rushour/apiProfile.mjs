/**
 * Profil de l'API RusHour utilisé par RushourHttpClient.
 *
 * Toutes les valeurs dépendant de RusHour (URL, chemins, authentification,
 * forme des réponses, déduplication) sont ICI et nulle part ailleurs. Le
 * client HTTP ne contient aucune hypothèse sur l'API : il applique ce
 * profil.
 *
 * ÉTAT (Bloc 2) : NON VÉRIFIÉ.
 * Les valeurs ci-dessous proviennent UNIQUEMENT de sources secondaires
 * officielles mais anciennes (github.com/rushour-io/developers-api-demo,
 * 2022). La documentation actuelle (developers.rushour.io) n'a pas pu être
 * consultée : voir docs/RUSHOUR_API_VERIFIED.md. Tant que `verified` vaut
 * false, RushourHttpClient refuse de s'instancier : aucun appel live n'est
 * possible.
 *
 * Passage à verified: true = décision revue, dans un commit dédié, après
 * vérification de CHAQUE champ contre la documentation actuelle, avec
 * mise à jour de docs/RUSHOUR_API_VERIFIED.md et des tests.
 */

export const RUSHOUR_API_PROFILE = Object.freeze({
  id: 'developers-api-demo-2022',
  verified: false,
  sources: Object.freeze([
    'github.com/rushour-io/developers-api-demo modules/rushour-client/rushourClient.js (2022, secondaire)',
    'github.com/rushour-io/types index.d.ts v2.1.0 (2021, secondaire)'
  ]),

  // UNKNOWN (actuel) — hôte vu dans les cookbooks de 2022.
  baseUrl: 'https://api.rushour.io',

  // UNKNOWN (actuel) — POST, HTTP Basic appId:appSecret, corps { scopes }.
  token: Object.freeze({
    path: '/apps/{appId}/integrations/{integrationId}/token',
    auth: 'basic',
    body: Object.freeze({ scopes: Object.freeze(['public/oauth']) }),
    accessTokenField: 'access_token',
    expiresInField: 'expires_in',
    tokenTypeField: 'token_type',
    expectedTokenType: 'Bearer'
  }),

  // UNKNOWN (actuel) — POST, Authorization: Bearer <token d'intégration>.
  order: Object.freeze({
    path: '/apps/{appId}/integrations/{integrationId}/orders',
    // L'exemple de 2022 renvoie un corps vide {} : aucun identifiant externe
    // n'est lu tant que la réponse réelle n'est pas documentée.
    externalIdField: null
  }),

  // UNKNOWN : RusHour déduplique-t-il sur externalId ? Tant que false, tout
  // envoi ambigu (timeout après POST, coupure, 2xx illisible, bail expiré)
  // devient UNCERTAIN et n'est JAMAIS rejoué automatiquement.
  dedupOnExternalId: false,

  // UNKNOWN : un 401 sur la commande signifie-t-il "token expiré, rien créé" ?
  // Tant que false, pas de renouvellement + nouvelle tentative immédiate.
  refreshTokenOn401: false,

  // Marge avant expiration du token (renouvellement anticipé).
  tokenSafetyMarginSeconds: 60
});

const PLACEHOLDER_RE = /\{(appId|integrationId)\}/g;

export function buildUrl(baseUrl, pathTemplate, { appId, integrationId }) {
  const path = pathTemplate.replace(PLACEHOLDER_RE, (_, key) =>
    encodeURIComponent(key === 'appId' ? appId : integrationId));
  return new URL(path, baseUrl).toString();
}

/** Vérifie la cohérence structurelle d'un profil (pas sa véracité). */
export function assertProfileShape(profile) {
  const ok = profile
    && typeof profile.baseUrl === 'string'
    && profile.token && typeof profile.token.path === 'string'
    && profile.order && typeof profile.order.path === 'string'
    && typeof profile.dedupOnExternalId === 'boolean'
    && typeof profile.refreshTokenOn401 === 'boolean'
    && Number.isFinite(profile.tokenSafetyMarginSeconds);
  if (!ok) throw new TypeError('Profil API RusHour invalide');
  const url = new URL(profile.baseUrl);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) {
    throw new TypeError('Profil API RusHour : HTTPS obligatoire');
  }
  return profile;
}
