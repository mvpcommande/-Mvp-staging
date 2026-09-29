// Mesure d'audience anonyme (sans cookie, sans IP, sans identifiant).
// Envoie une "vue de page" vers le RPC log_page_visit. Best-effort : ne
// casse jamais la page et ne pollue pas les logs d'erreurs (beacon non
// critique). Fonctionne sans supabase-js (simple fetch), pour être
// utilisable aussi sur la vitrine pro.html.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function detectSource(refHost, params) {
  const explicit = (
    params.get('src') ||
    params.get('utm_source') ||
    ''
  ).toLowerCase();
  if (explicit) return explicit;
  if (!refHost) return 'direct';
  if (refHost.includes('linkedin') || refHost.includes('lnkd')) return 'linkedin';
  if (refHost.includes('facebook') || refHost.includes('l.facebook') || refHost === 'fb.com') return 'facebook';
  if (refHost.includes('instagram')) return 'instagram';
  if (refHost.includes('tiktok')) return 'tiktok';
  if (refHost.includes('t.co') || refHost.includes('twitter') || refHost === 'x.com') return 'twitter';
  if (refHost.includes('google')) return 'google';
  return 'other';
}

export function trackPageview() {
  try {
    if (typeof window === 'undefined' || !SUPABASE_URL || !ANON_KEY) {
      return;
    }

    let refHost = '';
    try {
      refHost = document.referrer ? new URL(document.referrer).host : '';
    } catch (_e) {
      refHost = '';
    }

    // Ignore la navigation interne (même hôte) pour ne pas gonfler les compteurs
    if (refHost && refHost === window.location.host) {
      return;
    }

    const params = new URLSearchParams(window.location.search);

    fetch(`${SUPABASE_URL}/rest/v1/rpc/log_page_visit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`
      },
      body: JSON.stringify({
        p_page: window.location.pathname.slice(0, 120),
        p_source: detectSource(refHost, params).slice(0, 40),
        p_referrer_host: refHost.slice(0, 120),
        p_restaurant_slug: (params.get('resto') || '').slice(0, 80) || null
      }),
      keepalive: true
    }).catch(() => {});
  } catch (_e) {
    // best-effort : silencieux volontairement (beacon non critique)
  }
}
