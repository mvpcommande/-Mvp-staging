/**
 * Résolution du restaurant FOODATOI courant à partir de l'URL.
 * Partagée entre le frontend client (main.js) et l'admin (admin.js) :
 * les deux doivent résoudre exactement le même restaurant pour la
 * même URL, donc cette logique ne doit exister qu'à un seul endroit.
 *
 * https://www.foodatoi.fr/caz-food
 *              ↓
 *        slug = "caz-food"
 *              ↓
 *      Supabase RPC
 * resolve_restaurant("caz-food.foodatoi.fr")
 *              ↓
 *          restaurant
 *
 * Si aucun slug n'est présent dans le chemin (ex: cazfood31.netlify.app/
 * ou cazfood31.netlify.app/admin, tant que chaque restaurant a son propre
 * site Netlify), on résout directement sur le hostname réel : c'est ce
 * hostname qui doit être enregistré côté Supabase pour Caz Food.
 */

export function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

export function getHostname(location = window.location) {
  return location.hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Segments de chemin qui ne doivent jamais être interprétés comme
 * un slug restaurant. "admin" est essentiel : sans lui,
 * cazfood31.netlify.app/admin résoudrait "admin" comme slug et
 * chercherait admin.foodatoi.fr au lieu de cazfood31.netlify.app.
 */
const RESERVED_ROUTES = [
  'admin',
  'index',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'assets'
];

/**
 * Le slug en chemin (/mon-resto) suppose qu'un vrai fichier existe
 * à ce chemin - faux sur de l'hébergement statique (GitHub Pages)
 * pour un restaurant qui vient d'être créé en libre-service, sans
 * fichier dédié. Le paramètre de requête (?resto=mon-resto) marche
 * toujours, sur n'importe quel chemin existant (/ ou /admin.html),
 * sans setup DNS ni fichier par restaurant. Vérifié en priorité.
 */
export function getRestaurantSlugFromQuery(location = window.location) {
  const params = new URLSearchParams(location.search || '');
  const slug = (params.get('resto') || '')
    .trim()
    .toLowerCase();

  return slug || null;
}

export function getRestaurantSlugFromPath(location = window.location) {
  const pathname = location.pathname
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (!pathname) {
    return null;
  }

  const segments = pathname.split('/').filter(Boolean);

  if (!segments.length) {
    return null;
  }

  /*
   * Un déploiement statique sert admin.html/index.html tels
   * quels : le premier segment de chemin est alors "admin.html",
   * pas "admin", et RESERVED_ROUTES ne le reconnaît plus. C'est
   * exactement ce qui a cassé /admin.html sur le domaine
   * personnalisé (racine, donc plus de "/Mvp-/" pour masquer
   * le problème comme sur l'ancienne URL GitHub Pages).
   */
  const slug = decodeURIComponent(segments[0])
    .trim()
    .toLowerCase()
    .replace(/\.html$/, '');

  if (!slug || RESERVED_ROUTES.includes(slug)) {
    return null;
  }

  return slug;
}

export function getRestaurantResolverHost(location = window.location) {
  const slug =
    getRestaurantSlugFromQuery(location) ||
    getRestaurantSlugFromPath(location);

  if (slug) {
    return `${slug}.foodatoi.fr`;
  }

  return getHostname(location);
}

/**
 * Résout le restaurant FOODATOI courant via Supabase.
 *
 * Ne fait volontairement aucun effet de bord (branding, création de
 * store...) : ça reste à la charge de l'appelant, main.js et admin.js
 * n'ayant pas les mêmes effets à déclencher une fois le restaurant connu.
 */
export async function resolveRestaurant(client, location = window.location) {
  if (!client) {
    throw new Error('Supabase n’est pas configuré.');
  }

  const realHostname = getHostname(location);
  const resolverHost = getRestaurantResolverHost(location);
  const slug =
    getRestaurantSlugFromQuery(location) ||
    getRestaurantSlugFromPath(location);

  const { data, error } = await client.rpc('resolve_restaurant', {
    hostname: resolverHost
  });

  if (error) {
    throw error;
  }

  const resolved = Array.isArray(data) ? data[0] : data;

  if (!resolved?.id) {
    throw new Error(
      `Aucun restaurant FOODATOI configuré pour "${slug || realHostname}".`
    );
  }

  if (!isUuid(resolved.id)) {
    throw new Error('Identifiant restaurant invalide.');
  }

  return { ...resolved };
}
