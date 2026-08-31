/**
 * Échappement HTML partagé entre main.js et admin.js. Existait
 * seulement dans main.js jusqu'ici - admin.js l'utilisait nulle
 * part, jusqu'à ce que les notes de commande (texte libre saisi
 * par le client) aient besoin d'être affichées côté comptoir.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
