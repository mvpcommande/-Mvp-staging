import {
  addItem,
  calculateTotal,
  createOrder
} from './orderLogic.mjs';

import {
  appendOrder
} from './orderStore.mjs';

import {
  createSupabaseOrderStore
} from './supabaseStore.mjs';

import {
  supabase
} from './supabaseClient.js';

import {
  buildTicketModel
} from './uiModel.mjs';

import {
  resolveRestaurant as resolveRestaurantTenant,
  getRestaurantSlugFromQuery,
  getRestaurantSlugFromPath
} from './restaurantResolver.mjs';

import {
  isRestaurantOpen,
  formatOpeningHours
} from './timeFormat.mjs';

import {
  logClientError
} from './errorLog.mjs';

import {
  escapeHtml
} from './htmlEscape.mjs';

import {
  isValidEmail,
  signUpCustomer,
  signInCustomer,
  signOutCustomer,
  getCustomerProfile,
  getCustomerOrders,
  getCustomerConsents,
  setCustomerConsent,
  deleteCustomerAccount
} from './customerAccount.mjs';

import './styles.css';

/**
 * FOODATOI
 * Frontend multi-restaurant.
 *
 * Architecture :
 *
 * https://www.foodatoi.fr/caz-food
 *              ↓
 *        slug = "caz-food"
 *              ↓
 *      Supabase RPC
 * resolve_restaurant("caz-food.foodatoi.fr")
 *              ↓
 *          restaurant
 *              ↓
 * products.restaurant_id
 *              ↓
 *            menu
 *
 * Aucun domaine du restaurant n'est nécessaire.
 *
 * Le domaine principal FOODATOI reste :
 *
 * https://www.foodatoi.fr
 *
 * Chaque restaurant est accessible par :
 *
 * https://www.foodatoi.fr/<slug>
 */

let restaurant = null;
let menu = [];
let cart = [];
let activeCategory = 'Tous';
let categoryObserver = null;

let remoteStore = null;
let checkoutIdempotencyKey = null;

/**
 * Mode de commande affiché en tête de page (À emporter / Sur
 * place). Il n'existe aucune colonne dédiée côté données (le
 * système reste un click-and-collect classique) : ce choix est
 * simplement reporté dans les notes de la commande, sans toucher
 * au modèle ni à create_order.
 */
let orderMode = 'takeaway';

/**
 * Étape affichée dans le tiroir panier : "review" (ticket +
 * total) puis "details" (coordonnées + créneau + envoi). Un
 * simple état d'écran, aucune commande n'est créée avant l'étape
 * "details".
 */
let cartStep = 'review';

let accountView = 'login';
let accountError = '';
let accountLoading = false;
let accountCustomer = null;
let accountOrders = [];
let accountConsents = [];
let accountDeleteConfirming = false;

const MEATS = [
  'Kebab',
  'Poulet Paprika',
  'Tenders',
  'Kefta',
  'Merguez',
  'Nuggets',
  'Steak Haché',
  'Cordon Bleu',
  'Veggy'
];

const SAUCES = [
  'Ketchup',
  'Biggy',
  'Marocaine',
  'Mayo',
  'Blanche',
  'Curry',
  'Algérienne',
  'Harissa',
  'Andalouse',
  'Brésilienne',
  'Moutarde',
  'Fromagère'
];

const DRINKS = [
  'Canette',
  'Bouteille',
  'Eau',
  'Redbull',
  'Compote',
  'Capri-Sun'
];

const app = document.querySelector('#root');

/* -------------------------------------------------------------------------- */
/* Icônes (SVG inline, monochromes — pas d'emoji décoratif)                   */
/* -------------------------------------------------------------------------- */

const ICONS = {
  info: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none"/></svg>`,
  account: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>`,
  cart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>`,
  chevronLeft: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="15 6 9 12 15 18"/></svg>`
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const euro = value =>
  `${Number(value ?? 0)
    .toFixed(2)
    .replace('.', ',')} €`;

const itemCount = () =>
  cart.reduce(
    (sum, item) =>
      sum + Number(item.quantity ?? 0),
    0
  );

function restaurantOpenNow() {
  return isRestaurantOpen(
    restaurant?.settings?.opening_hours,
    new Date()
  );
}

/**
 * Configuration ETA du restaurant (settings, aucune colonne
 * dédiée) : soit une fourchette (pickup_eta_min / pickup_eta_max),
 * soit une valeur unique (pickup_eta_minutes). Retourne null si
 * rien n'est configuré — c'est la seule source de vérité, jamais
 * de délai inventé côté client. Factorisé ici car réutilisé par le
 * header (getPickupEtaLabel) et par l'estimation du panier
 * (getCartEtaLabel), qui n'en affichent pas le même format.
 */
function getPickupEtaConfig() {
  const settings = restaurant?.settings || {};

  const min = Number(settings.pickup_eta_min);
  const max = Number(settings.pickup_eta_max);

  if (
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min > 0 &&
    max >= min
  ) {
    return { type: 'range', min, max };
  }

  const minutes = Number(settings.pickup_eta_minutes);

  if (Number.isFinite(minutes) && minutes > 0) {
    return { type: 'single', minutes };
  }

  return null;
}

/**
 * Délai de retrait affiché dans le header. Sans configuration, on
 * n'affiche rien plutôt que d'inventer un délai identique pour
 * tous les restaurants.
 */
function getPickupEtaLabel() {
  const config = getPickupEtaConfig();

  if (!config) {
    return null;
  }

  return config.type === 'range'
    ? `Retrait ${config.min}–${config.max} min`
    : `Retrait ~${config.minutes} min`;
}

/**
 * Estimation affichée dans l'écran "ticket" du panier
 * (renderCartReview), purement informative : ne détermine jamais
 * l'heure de retrait envoyée en base — ça reste pickupTime, choisi
 * à l'étape suivante. Null si aucune ETA n'est configurée pour ce
 * restaurant, auquel cas la ligne est masquée.
 */
function getCartEtaLabel() {
  const config = getPickupEtaConfig();

  if (!config) {
    return null;
  }

  if (config.type === 'range') {
    return `Retrait estimé : ${config.min}–${config.max} min`;
  }

  const estimate = new Date(Date.now() + config.minutes * 60 * 1000);

  const timeLabel = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(estimate);

  return `Retrait estimé vers ${timeLabel}`;
}

/**
 * Un produit est "populaire" seulement si le restaurant l'a
 * explicitement marqué comme tel dans ses options (aucune
 * statistique de vente n'est inventée côté client).
 */
function isPopular(item) {
  const options = item.options || {};

  return Boolean(
    options.popular ||
    options.is_popular ||
    options.bestseller ||
    options.is_bestseller ||
    options.badge === 'populaire' ||
    options.badge === 'popular'
  );
}

/**
 * "Nouveau" s'appuie uniquement sur une intention explicite du
 * restaurant (option produit), jamais sur products.created_at : la
 * date de création en base ne reflète pas la nouveauté commerciale
 * (import de menu, resynchronisation, etc. peuvent la modifier sans
 * rapport avec un vrai lancement produit).
 */
function isNewProduct(item) {
  const options = item.options || {};

  return Boolean(
    options.new ||
    options.is_new ||
    options.badge === 'nouveau' ||
    options.badge === 'new'
  );
}

/**
 * Un produit nécessite le configurateur (bottom sheet) dès qu'il a
 * au moins un choix à faire ; sinon le bouton [+] ajoute directement.
 */
function productNeedsOptions(item) {
  return Boolean(item.meat || item.sauce || item.drink);
}

/**
 * Max 4 produits marqués populaires par le restaurant. Tableau
 * vide si aucun produit n'est marqué => la section reste masquée
 * (voir render()), plutôt que d'inventer un classement.
 */
function getBestSellers() {
  return menu.filter(isPopular).slice(0, 4);
}

function getRestaurantDisplayName() {
  return (
    restaurant?.name ||
    'FOODATOI'
  );
}

/**
 * Mots vides à ignorer pour le monogramme (articles/liaisons
 * français les plus courants), pour éviter des initiales comme
 * "LA" au lieu de "MM" sur "La Maison Métisse".
 */
const BRAND_INITIALS_STOPWORDS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'et'
]);

/**
 * Monogramme de repli quand logo_url est absent : initiales des
 * mots significatifs du nom (jamais les 2 premières lettres brutes,
 * qui donnent des résultats absurdes comme "Caz Food" -> "CA").
 * Retourne '' si aucune initiale exploitable (le monogramme est
 * alors masqué plutôt que d'afficher un rendu cassé).
 */
function getBrandInitials(name) {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) {
    return '';
  }

  const significant = words.filter(
    word => !BRAND_INITIALS_STOPWORDS.has(
      word.toLowerCase().replace(/['’]/g, '')
    )
  );

  const source = significant.length ? significant : words;

  return source
    .slice(0, 2)
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase();
}

function getRestaurantPhone() {
  return restaurant?.phone || '';
}

function getRestaurantAddress() {
  const address =
    restaurant?.address;

  if (!address) {
    return '';
  }

  if (typeof address === 'string') {
    return address;
  }

  if (typeof address === 'object') {
    return [
      address.street,
      address.postal_code ||
        address.postalCode,
      address.city
    ]
      .filter(Boolean)
      .join(' · ');
  }

  return '';
}

function getRestaurantColor() {
  return (
    restaurant?.primary_color ||
    '#111111'
  );
}

/* -------------------------------------------------------------------------- */
/* Restaurant resolution                                                      */
/* -------------------------------------------------------------------------- */

async function resolveRestaurant() {
  /*
   * La résolution elle-même (slug/hostname → restaurant) vit dans
   * restaurantResolver.mjs, partagée avec admin.js. Ici on ne garde
   * que ce qui est spécifique au frontend client : le branding et
   * la création du store une fois le tenant connu.
   */
  restaurant = await resolveRestaurantTenant(supabase);

  console.info(
    '[FOODATOI] Restaurant résolu:',
    restaurant
  );

  applyRestaurantBranding();

  /**
   * Maintenant seulement que le tenant
   * est connu, on crée le store Supabase.
   *
   * Le restaurant_id sera transmis
   * dans chaque commande.
   */
  remoteStore =
    createSupabaseOrderStore(
      supabase,
      restaurant.id
    );

  return restaurant;
}

/* -------------------------------------------------------------------------- */
/* Branding                                                                   */
/* -------------------------------------------------------------------------- */

function applyRestaurantBranding() {
  if (!restaurant) {
    return;
  }

  document.documentElement.style.setProperty(
    '--restaurant-primary',
    getRestaurantColor()
  );

  document.title =
    `${getRestaurantDisplayName()} · FOODATOI`;
}

/* -------------------------------------------------------------------------- */
/* Product normalization                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Choisit l'image principale d'un produit (is_primary,
 * puis sort_order) et la résout en URL absolue selon le
 * déploiement courant : import.meta.env.BASE_URL vaut '/'
 * sur Netlify et '/Mvp-/' sur GitHub Pages (défini au
 * build), donc pas besoin de donnée différente par cible.
 *
 * public_url en base est stocké relatif (ex:
 * "product-images/menu-burger.jpg"), pas comme chemin
 * absolu, précisément pour rester portable entre les deux.
 */
function resolveProductImageUrl(images) {
  if (!Array.isArray(images) || !images.length) {
    return null;
  }

  const sorted = [...images].sort((a, b) => {
    if (a.is_primary !== b.is_primary) {
      return a.is_primary ? -1 : 1;
    }
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });

  const path = sorted[0]?.public_url;

  if (!path) {
    return null;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}

function normalizeProduct(product) {
  const options =
    product.options &&
    typeof product.options === 'object'
      ? product.options
      : {};

  const price =
    Number(product.price_cents ?? 0) /
    100;

  return {
    id:
      product.id,

    category:
      product.category ||
      'Autres',

    name:
      product.name ||
      'Produit',

    description:
      product.description ||
      '',

    price,

    emoji:
      options.emoji ||
      options.icon ||
      '🍽️',

    imageUrl:
      resolveProductImageUrl(
        product.product_images
      ),

    options,

    meat:
      Boolean(
        options.meat ||
        options.meats ||
        options.viande ||
        options.viandes
      ),

    sauce:
      Boolean(
        options.sauce ||
        options.sauces
      ),

    drink:
      Boolean(
        options.drink ||
        options.drinks ||
        options.boisson ||
        options.boissons
      ),

    multipleMeat:
      Boolean(
        options.multipleMeat ||
        options.multiple_meat
      ),

    tripleMeat:
      Boolean(
        options.tripleMeat ||
        options.triple_meat
      ),

    createdAt:
      product.created_at ||
      null
  };
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

async function loadMenu() {
  if (!supabase) {
    throw new Error(
      'Supabase n’est pas configuré.'
    );
  }

  if (!restaurant?.id) {
    throw new Error(
      'Restaurant non résolu.'
    );
  }

  const {
    data,
    error
  } = await supabase
    .from('products')
    .select(`
      id,
      name,
      category,
      description,
      price_cents,
      options,
      is_active,
      sort_order,
      restaurant_id,
      created_at,
      product_images (
        public_url,
        is_primary,
        sort_order
      )
    `)
    .eq(
      'restaurant_id',
      restaurant.id
    )
    .eq(
      'is_active',
      true
    )
    .order(
      'sort_order',
      {
        ascending: true,
        nullsFirst: false
      }
    )
    .order(
      'created_at',
      {
        ascending: true
      }
    );

  if (error) {
    console.error(
      '[FOODATOI] Erreur chargement catalogue:',
      error
    );

    throw error;
  }

  menu =
    (data ?? [])
      .filter(
        product =>
          product.restaurant_id ===
          restaurant.id
      )
      .map(
        normalizeProduct
      );

  activeCategory =
    'Tous';

  console.info(
    `[FOODATOI] ${menu.length} produit(s) chargé(s) pour ${getRestaurantDisplayName()}.`
  );

  return menu;
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

function getCategories() {
  return [
    'Tous',
    ...new Set(
      menu
        .map(
          item => item.category
        )
        .filter(Boolean)
    )
  ];
}

/**
 * Découpe le pseudo-libre "Tous" en tranches par
 * catégorie, dans l'ordre où elles apparaissent dans
 * le menu (déjà trié par sort_order). Chaque tranche
 * garde un id d'ancre stable pour le défilement au
 * clic sur une pastille.
 */
function slugifyCategory(category) {
  return String(category)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function groupByCategory(items) {
  const order = [];
  const groups = new Map();

  items.forEach(item => {
    const category = item.category || 'Autres';
    if (!groups.has(category)) {
      groups.set(category, []);
      order.push(category);
    }
    groups.get(category).push(item);
  });

  return order.map(category => ({
    category,
    slug: slugifyCategory(category),
    items: groups.get(category)
  }));
}

/* -------------------------------------------------------------------------- */
/* Loading / error UI                                                         */
/* -------------------------------------------------------------------------- */

function renderLoading() {
  app.innerHTML = `
    <div class="app-frame client-app">

      <main>

        <section class="oi-state-screen">
          <div class="oi-state-spinner" aria-hidden="true"></div>
          <p class="eyebrow">FOODATOI</p>
          <h1>Chargement du restaurant…</h1>
          <p class="oi-state-lede">Nous préparons la carte.</p>
        </section>

      </main>

    </div>
  `;
}

function renderError(error) {
  console.error(
    '[FOODATOI] Erreur application:',
    error
  );

  logClientError(supabase, {
    context: 'main.init',
    message: error?.message ?? String(error),
    page: 'main'
  });

  app.innerHTML = `
    <div class="app-frame client-app">

      <main>

        <section class="oi-state-screen">
          <p class="eyebrow">FOODATOI</p>
          <h1>Restaurant indisponible</h1>
          <p class="oi-state-lede">La configuration de ce restaurant n'est pas encore disponible.</p>
          <p class="oi-state-hint">Vérifie l'URL ou réessaie plus tard.</p>
        </section>

      </main>

    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Main render                                                                */
/* -------------------------------------------------------------------------- */

function render() {
  const categories = getCategories();
  const displayName = getRestaurantDisplayName();
  const address = getRestaurantAddress();
  const phone = getRestaurantPhone();
  const openNow = restaurantOpenNow();
  const bestSellers = getBestSellers();
  const count = itemCount();
  const cartTotal = calculateTotal(cart);
  const brandInitials = getBrandInitials(displayName);
  const pickupEtaLabel = getPickupEtaLabel();

  app.innerHTML = `
    <div class="app-frame client-app">

      <header class="oi-header">

        <div class="oi-header-row">

          <div class="brand-lockup">

            ${
              restaurant?.logo_url
                ? `<img class="brand-mark-image" src="${escapeHtml(restaurant.logo_url)}" alt="${escapeHtml(displayName)}">`
                : brandInitials
                  ? `<span class="brand-mark">${escapeHtml(brandInitials)}</span>`
                  : ''
            }

            <div class="oi-brand-meta">
              <strong>${escapeHtml(displayName)}</strong>
              <div class="oi-status-line">
                <span class="oi-status-badge ${openNow ? 'is-open' : 'is-closed'}">
                  <span class="oi-status-dot"></span>
                  ${openNow ? 'Ouvert' : 'Fermé'}
                </span>
                ${pickupEtaLabel ? `<span class="oi-eta">${escapeHtml(pickupEtaLabel)}</span>` : ''}
              </div>
            </div>

          </div>

          <div class="masthead-actions">

            <button class="icon-btn" id="open-info" type="button" aria-label="Informations du restaurant">
              ${ICONS.info}
            </button>

            <button class="icon-btn" id="open-account" type="button" aria-label="Mon compte">
              ${ICONS.account}
            </button>

            <button class="icon-btn oi-cart-btn" id="open-cart" type="button" aria-label="Panier, ${count} article${count > 1 ? 's' : ''}">
              ${ICONS.cart}
              <b class="oi-cart-badge${count ? '' : ' hidden'}" id="cart-badge">${count}</b>
            </button>

          </div>

        </div>

        <h2 class="oi-tagline">Choisis. <em>On prépare.</em></h2>

      </header>

      <main>

        <section class="oi-mode-section" aria-label="Mode de commande">
          <p class="oi-mode-label">Comment souhaitez-vous commander ?</p>
          <div class="oi-segmented" role="group" aria-label="Mode de commande">
            <button type="button" class="oi-segmented-btn${orderMode === 'takeaway' ? ' is-active' : ''}" data-order-mode="takeaway" aria-pressed="${orderMode === 'takeaway'}">
              À emporter
            </button>
            <button type="button" class="oi-segmented-btn${orderMode === 'onsite' ? ' is-active' : ''}" data-order-mode="onsite" aria-pressed="${orderMode === 'onsite'}">
              Sur place
            </button>
          </div>
        </section>

        ${
          !openNow
            ? `
              <div class="closed-banner oi-closed-banner">
                <p class="eyebrow">Fermé actuellement</p>
                <p>
                  ${escapeHtml(displayName)} n'accepte pas de commande immédiate en ce moment.
                  Tu peux composer ton panier et repasser plus tard pour valider.
                </p>
              </div>
            `
            : ''
        }

        ${
          restaurant?.settings?.delivery_redirect_url
            ? `
              <section class="delivery-banner oi-delivery-banner">
                <div>
                  <p class="eyebrow">Livraison à domicile</p>
                  <p>${escapeHtml(displayName)} livre aussi à domicile via Uber Eats.</p>
                </div>
                <a
                  class="secondary"
                  href="${escapeHtml(restaurant.settings.delivery_redirect_url)}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Commander sur Uber Eats →
                </a>
              </section>
            `
            : ''
        }

        ${
          categories.length > 1
            ? `
              <nav class="category-rail oi-cat-rail" aria-label="Catégories">
                ${categories
                  .map(
                    category => `
                      <button
                        class="category oi-chip"
                        data-category="${escapeHtml(category)}"
                        data-target="${category === 'Tous' ? 'top' : escapeHtml(slugifyCategory(category))}"
                        type="button"
                      >
                        ${escapeHtml(category)}
                      </button>
                    `
                  )
                  .join('')}
              </nav>
            `
            : ''
        }

        <section class="oi-menu">

          ${
            bestSellers.length
              ? `
                <section class="oi-section" id="oi-bestsellers">
                  <div class="oi-section-head">
                    <h2>Les plus commandés</h2>
                  </div>
                  <div class="oi-card-list">
                    ${bestSellers.map(card).join('')}
                  </div>
                </section>
              `
              : ''
          }

          ${
            menu.length
              ? groupByCategory(menu)
                  .map(
                    group => `
                      <section class="menu-category-section oi-section" id="menu-cat-${group.slug}">
                        <div class="oi-section-head">
                          <h2>${escapeHtml(group.category)}</h2>
                        </div>
                        <div class="oi-card-list">
                          ${group.items.map(card).join('')}
                        </div>
                      </section>
                    `
                  )
                  .join('')
              : `
                <div class="empty-ticket">
                  <div class="empty-ticket-mark">+</div>
                  <h3>Carte en préparation.</h3>
                  <p>Ce restaurant n'a pas encore publié de produits.</p>
                </div>
              `
          }

        </section>

      </main>

      <footer class="site-footer">

        <div>
          <strong>${escapeHtml(displayName)}</strong>
          ${address ? `<span>${escapeHtml(address)}</span>` : ''}
        </div>

        ${
          formatOpeningHours(restaurant?.settings?.opening_hours).length
            ? `
              <div class="footer-hours">
                ${formatOpeningHours(restaurant?.settings?.opening_hours)
                  .map(
                    line => `
                      <span>
                        ${escapeHtml(line.label)}
                        <b>${escapeHtml(line.hours)}</b>
                      </span>
                    `
                  )
                  .join('')}
              </div>
            `
            : ''
        }

        <div>
          ${phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : ''}
          ${
            restaurant?.settings?.facebook_url
              ? `
                <a href="${escapeHtml(restaurant.settings.facebook_url)}" target="_blank" rel="noopener noreferrer">
                  Facebook
                </a>
              `
              : ''
          }
          <a href="/legal.html">Mentions légales</a>
        </div>

      </footer>

    </div>

    <div class="oi-sticky-cart${cart.length ? '' : ' hidden'}" id="sticky-cart-bar">
      <button type="button" id="sticky-cart-btn" class="oi-sticky-cart-btn">
        <span class="oi-sticky-cart-info">
          <span class="oi-sticky-cart-count">${count} article${count > 1 ? 's' : ''}</span>
          <span class="oi-sticky-cart-total">${euro(cartTotal)}</span>
        </span>
        <span class="oi-sticky-cart-cta">Voir le panier ${ICONS.arrow}</span>
      </button>
    </div>

    <div class="drawer-backdrop hidden" id="backdrop"></div>

    <aside class="drawer" id="drawer" aria-label="Panier">

      <div class="drawer-head">
        <div>
          <p class="eyebrow">${escapeHtml(displayName)}</p>
          <h2 id="drawer-title">Votre commande</h2>
        </div>
        <button id="close-cart" class="icon-btn" type="button" aria-label="Fermer">×</button>
      </div>

      <div id="cart-content"></div>

    </aside>

    <div class="modal hidden" id="product-modal">
      <div class="modal-card" id="modal-content"></div>
    </div>
  `;

  bind();
  renderCart();
}

/* -------------------------------------------------------------------------- */
/* Product card                                                               */
/* -------------------------------------------------------------------------- */

function card(item) {
  const badges = [];

  if (isPopular(item)) {
    badges.push('<span class="oi-badge oi-badge--acid">Populaire</span>');
  }

  if (isNewProduct(item)) {
    badges.push('<span class="oi-badge oi-badge--ink">Nouveau</span>');
  }

  return `
    <article class="oi-card${item.imageUrl ? '' : ' oi-card--no-photo'}">

      <button
        type="button"
        class="oi-card-main"
        data-open="${escapeHtml(item.id)}"
        aria-label="Voir ${escapeHtml(item.name)}"
      >

        <span class="oi-card-text">

          ${badges.length ? `<span class="oi-card-badges">${badges.join('')}</span>` : ''}

          <span class="oi-card-name">${escapeHtml(item.name)}</span>

          ${item.description ? `<span class="oi-card-desc">${escapeHtml(item.description)}</span>` : ''}

          <span class="oi-card-price">${euro(item.price)}</span>

        </span>

        ${
          item.imageUrl
            ? `
              <span class="oi-card-media">
                <img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" width="84" height="84">
              </span>
            `
            : ''
        }

      </button>

      <button
        class="oi-add-btn"
        data-add="${escapeHtml(item.id)}"
        type="button"
        aria-label="Ajouter ${escapeHtml(item.name)}"
      >
        <span aria-hidden="true">+</span>
      </button>

    </article>
  `;
}

/**
 * Filet de sécurité : si une product_images.public_url pointe vers
 * une image cassée/introuvable (404, hébergement retiré...), on
 * retire la vignette plutôt que de laisser l'icône d'image cassée
 * du navigateur — jamais de placeholder visible, cassé ou non.
 * Attaché en JS (pas d'attribut onerror inline, bloqué par la CSP
 * script-src 'self').
 */
function hideBrokenProductImages() {
  document
    .querySelectorAll('.oi-card-media img, .product-photo')
    .forEach(img => {
      img.onerror = () => {
        const media = img.closest('.oi-card-media');
        const card = img.closest('.oi-card');

        if (media) {
          media.remove();
          card?.classList.add('oi-card--no-photo');
          return;
        }

        img.remove();
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function setupCategorySpy() {
  if (categoryObserver) {
    categoryObserver.disconnect();
  }

  const sections =
    document.querySelectorAll(
      '.menu-category-section'
    );

  if (!sections.length) {
    return;
  }

  const railHeight =
    document
      .querySelector(
        '.category-rail'
      )
      ?.offsetHeight || 0;

  categoryObserver =
    new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (
            entry.isIntersecting
          ) {
            const slug =
              entry.target.id.replace(
                'menu-cat-',
                ''
              );

            document
              .querySelectorAll(
                '[data-category]'
              )
              .forEach(button => {
                button.classList.toggle(
                  'is-active',
                  button.dataset
                    .target ===
                    slug
                );
              });
          }
        });
      },
      {
        rootMargin: `-${
          railHeight + 20
        }px 0px -70% 0px`,
        threshold: 0
      }
    );

  sections.forEach(section =>
    categoryObserver.observe(
      section
    )
  );
}

function bind() {
  document
    .querySelectorAll(
      '[data-category]'
    )
    .forEach(button => {
      button.onclick = () => {
        const target =
          button.dataset.target;

        if (target === 'top') {
          window.scrollTo({
            top: 0,
            behavior: 'smooth'
          });
          return;
        }

        const section =
          document.getElementById(
            `menu-cat-${target}`
          );

        if (section) {
          const railHeight =
            document
              .querySelector(
                '.category-rail'
              )
              ?.offsetHeight || 0;

          const top =
            section.getBoundingClientRect()
              .top +
            window.scrollY -
            railHeight -
            12;

          window.scrollTo({
            top,
            behavior: 'smooth'
          });
        }
      };
    });

  setupCategorySpy();

  document
    .querySelectorAll(
      '[data-add]'
    )
    .forEach(button => {
      button.onclick = () =>
        handleAddClick(
          button.dataset.add
        );
    });

  document
    .querySelectorAll(
      '[data-open]'
    )
    .forEach(card => {
      card.onclick = () =>
        openProduct(
          card.dataset.open
        );
    });

  document
    .querySelectorAll(
      '[data-order-mode]'
    )
    .forEach(button => {
      button.onclick = () => {
        orderMode = button.dataset.orderMode;

        document
          .querySelectorAll('[data-order-mode]')
          .forEach(candidate => {
            const isActive = candidate.dataset.orderMode === orderMode;
            candidate.classList.toggle('is-active', isActive);
            candidate.setAttribute('aria-pressed', String(isActive));
          });
      };
    });

  hideBrokenProductImages();

  const openCartButton =
    document.querySelector(
      '#open-cart'
    );

  if (openCartButton) {
    openCartButton.onclick =
      openCart;
  }

  const stickyCartButton =
    document.querySelector(
      '#sticky-cart-btn'
    );

  if (stickyCartButton) {
    stickyCartButton.onclick =
      openCart;
  }

  const openAccountButton =
    document.querySelector(
      '#open-account'
    );

  if (openAccountButton) {
    openAccountButton.onclick =
      openAccountModal;
  }

  const openInfoButton =
    document.querySelector(
      '#open-info'
    );

  if (openInfoButton) {
    openInfoButton.onclick =
      openInfoModal;
  }

  const closeCartButton =
    document.querySelector(
      '#close-cart'
    );

  if (closeCartButton) {
    closeCartButton.onclick =
      closeCart;
  }

  const backdrop =
    document.querySelector(
      '#backdrop'
    );

  if (backdrop) {
    backdrop.onclick =
      closeCart;
  }
}

/**
 * Ajout depuis la carte : direct si le produit n'a aucun choix à
 * faire, sinon ouvre le configurateur (bottom sheet). N'ouvre pas
 * le panier automatiquement (pour enchaîner plusieurs ajouts
 * rapides) — seul l'ajout confirmé depuis le configurateur le fait,
 * comportement déjà couvert par le test e2e existant.
 */
function handleAddClick(id) {
  const item = menu.find(product => product.id === id);

  if (!item) {
    return;
  }

  if (!productNeedsOptions(item)) {
    cart = addItem(cart, { ...item, quantity: 1, options: {} });
    render();
    return;
  }

  openProduct(id);
}

/**
 * Met à jour le badge panier (header) et la barre sticky sans
 * reconstruire toute la page — utilisé après une suppression /
 * modification faite depuis le tiroir panier déjà ouvert, pour ne
 * pas le refermer ni perdre le défilement de la carte en arrière-plan.
 */
function updateCartIndicators() {
  const count = itemCount();

  const badge = document.querySelector('#cart-badge');

  if (badge) {
    badge.textContent = String(count);
    badge.classList.toggle('hidden', count === 0);
  }

  const openCartButtonEl = document.querySelector('#open-cart');

  if (openCartButtonEl) {
    openCartButtonEl.setAttribute(
      'aria-label',
      `Panier, ${count} article${count > 1 ? 's' : ''}`
    );
  }

  const stickyBar = document.querySelector('#sticky-cart-bar');

  if (stickyBar) {
    stickyBar.classList.toggle('hidden', cart.length === 0);

    const countEl = stickyBar.querySelector('.oi-sticky-cart-count');
    const totalEl = stickyBar.querySelector('.oi-sticky-cart-total');

    if (countEl) {
      countEl.textContent = `${count} article${count > 1 ? 's' : ''}`;
    }

    if (totalEl) {
      totalEl.textContent = euro(calculateTotal(cart));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Product modal                                                              */
/* -------------------------------------------------------------------------- */

function openProduct(id, editIndex = null) {
  const item =
    menu.find(
      product =>
        product.id === id
    );

  if (!item) {
    return;
  }

  const existing =
    editIndex !== null
      ? cart[editIndex]
      : null;

  const prefill = existing?.options || {};

  const meatField = buildMeatField(item, prefill);
  const sauceField = buildSauceField(item, prefill);
  const drinkField = buildDrinkField(item, prefill);

  let quantity = Math.max(1, Math.min(20, Number(existing?.quantity ?? 1)));

  const ctaLabel = () =>
    `${editIndex !== null ? 'Enregistrer' : 'Ajouter au panier'} · ${euro(item.price * quantity)}`;

  document.querySelector('#modal-content').innerHTML = `

    <button class="modal-close" id="modal-close" type="button" aria-label="Fermer">×</button>

    <div class="oi-sheet-scroll">

      ${
        item.imageUrl
          ? `<img class="product-photo" src="${escapeHtml(item.imageUrl)}" alt="">`
          : ''
      }

      <p class="eyebrow">${escapeHtml(item.category)}</p>

      <h2>${escapeHtml(item.name)}</h2>

      ${item.description ? `<p class="oi-sheet-desc">${escapeHtml(item.description)}</p>` : ''}

      <p class="oi-sheet-price">${euro(item.price)}</p>

      <div class="oi-sheet-fields">

        ${meatField}

        ${sauceField}

        ${drinkField}

        <div class="oi-field">
          <p class="oi-field-label">Quantité</p>
          <div class="oi-stepper">
            <button type="button" class="oi-stepper-btn" id="qty-minus" aria-label="Diminuer la quantité">−</button>
            <span class="oi-stepper-value" id="qty-value" aria-live="polite">${quantity}</span>
            <button type="button" class="oi-stepper-btn" id="qty-plus" aria-label="Augmenter la quantité">+</button>
          </div>
        </div>

      </div>

    </div>

    <div class="oi-sheet-cta">
      <button class="primary full" id="confirm-add" type="button">
        ${ctaLabel()}
      </button>
    </div>
  `;

  document.querySelector('#product-modal').classList.remove('hidden');
  document.querySelector('#product-modal').classList.add('oi-sheet');
  hideBrokenProductImages();

  const ctaButton = document.querySelector('#confirm-add');

  function refreshCta() {
    ctaButton.textContent = ctaLabel();
  }

  document.querySelector('#modal-close').onclick = () => {
    document.querySelector('#product-modal').classList.add('hidden');
    document.querySelector('#product-modal').classList.remove('oi-sheet');
  };

  const qtyValue = document.querySelector('#qty-value');
  const qtyMinus = document.querySelector('#qty-minus');
  const qtyPlus = document.querySelector('#qty-plus');

  function syncQtyButtons() {
    qtyMinus.disabled = quantity <= 1;
    qtyPlus.disabled = quantity >= 20;
  }

  qtyMinus.onclick = () => {
    quantity = Math.max(1, quantity - 1);
    qtyValue.textContent = String(quantity);
    syncQtyButtons();
    refreshCta();
  };

  qtyPlus.onclick = () => {
    quantity = Math.min(20, quantity + 1);
    qtyValue.textContent = String(quantity);
    syncQtyButtons();
    refreshCta();
  };

  syncQtyButtons();

  document
    .querySelectorAll('#product-modal input[type="radio"]')
    .forEach((input) => {
      input.onchange = refreshCta;
    });

  ctaButton.onclick = () => {
    const options = {};

    const meat1 = document.querySelector('input[name="meat-1"]:checked')?.value;
    const meat2 = document.querySelector('input[name="meat-2"]:checked')?.value;
    const meat3 = document.querySelector('input[name="meat-3"]:checked')?.value;
    const sauce = document.querySelector('input[name="sauce"]:checked')?.value;
    const drink = document.querySelector('input[name="drink"]:checked')?.value;

    if (meat1) {
      options.meat = meat1;
    }

    if (meat2) {
      options.meat2 = meat2;
    }

    if (meat3) {
      options.meat3 = meat3;
    }

    if (meat2 || meat3) {
      options.meats = [meat1, meat2, meat3].filter(Boolean);
    }

    if (sauce) {
      options.sauce = sauce;
    }

    if (drink) {
      options.drink = drink;
    }

    if (editIndex !== null) {
      cart = cart.map((line, index) =>
        index === editIndex ? { ...item, quantity, options } : line
      );

      document.querySelector('#product-modal').classList.add('hidden');
      document.querySelector('#product-modal').classList.remove('oi-sheet');

      renderCart();
      updateCartIndicators();

      return;
    }

    cart = addItem(cart, { ...item, quantity, options });

    document.querySelector('#product-modal').classList.add('hidden');
    document.querySelector('#product-modal').classList.remove('oi-sheet');

    render();
    openCart();
  };
}

/* -------------------------------------------------------------------------- */
/* Product options                                                            */
/* -------------------------------------------------------------------------- */

function getOptionArray(
  options,
  keys,
  fallback
) {
  for (const key of keys) {
    if (
      Array.isArray(
        options?.[key]
      ) &&
      options[key].length
    ) {
      return options[key];
    }
  }

  return fallback;
}

/**
 * Groupe de choix présenté comme une rangée de pastilles
 * sélectionnables (radio natif masqué, visuel en pastille) —
 * remplace les anciens <select>, plus pénibles à utiliser au
 * pouce. Sans `selected`, la première option est cochée par défaut
 * (comportement identique à l'ancien <select>, qui pré-sélectionnait
 * déjà sa première <option>).
 */
function pillGroup({ name, label, options, selected = null }) {
  if (!options.length) {
    return '';
  }

  return `
    <div class="oi-field">
      <p class="oi-field-label">${escapeHtml(label)}</p>
      <div class="oi-pill-group" role="radiogroup" aria-label="${escapeHtml(label)}">
        ${options
          .map((option, index) => {
            const value = String(option);
            const isChecked = selected != null ? value === selected : index === 0;

            return `
              <label class="oi-pill">
                <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${isChecked ? ' checked' : ''}>
                <span>${escapeHtml(value)}</span>
              </label>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function buildMeatField(item, prefill = {}) {
  if (!item.meat) {
    return '';
  }

  const options =
    getOptionArray(
      item.options,
      [
        'meats',
        'meat',
        'viandes',
        'viande'
      ],
      MEATS
    );

  if (item.tripleMeat) {
    return [
      pillGroup({ name: 'meat-1', label: 'Viande 1', options, selected: prefill.meat ?? null }),
      pillGroup({ name: 'meat-2', label: 'Viande 2', options, selected: prefill.meat2 ?? null }),
      pillGroup({ name: 'meat-3', label: 'Viande 3', options, selected: prefill.meat3 ?? null })
    ].join('');
  }

  if (item.multipleMeat) {
    return [
      pillGroup({ name: 'meat-1', label: 'Viande 1', options, selected: prefill.meat ?? null }),
      pillGroup({ name: 'meat-2', label: 'Viande 2', options, selected: prefill.meat2 ?? null })
    ].join('');
  }

  return pillGroup({ name: 'meat-1', label: 'Viande', options, selected: prefill.meat ?? null });
}

function buildSauceField(item, prefill = {}) {
  if (!item.sauce) {
    return '';
  }

  const options =
    getOptionArray(
      item.options,
      [
        'sauces',
        'sauce'
      ],
      SAUCES
    );

  return pillGroup({ name: 'sauce', label: 'Sauce', options, selected: prefill.sauce ?? null });
}

function buildDrinkField(item, prefill = {}) {
  if (!item.drink) {
    return '';
  }

  const options =
    getOptionArray(
      item.options,
      [
        'drinks',
        'drink',
        'boissons',
        'boisson'
      ],
      DRINKS
    );

  return pillGroup({ name: 'drink', label: 'Boisson', options, selected: prefill.drink ?? null });
}

/* -------------------------------------------------------------------------- */
/* Cart                                                                       */
/* -------------------------------------------------------------------------- */

function openCart() {
  cartStep = 'review';

  document
    .querySelector(
      '#drawer'
    )
    .classList.add(
      'open'
    );

  document
    .querySelector(
      '#backdrop'
    )
    .classList.remove(
      'hidden'
    );

  renderCart();
}

function closeCart() {
  document
    .querySelector(
      '#drawer'
    )
    .classList.remove(
      'open'
    );

  document
    .querySelector(
      '#backdrop'
    )
    .classList.add(
      'hidden'
    );
}

/* -------------------------------------------------------------------------- */
/* Informations restaurant                                                    */
/* -------------------------------------------------------------------------- */

function openInfoModal() {
  const displayName = getRestaurantDisplayName();
  const address = getRestaurantAddress();
  const phone = getRestaurantPhone();
  const hours = formatOpeningHours(restaurant?.settings?.opening_hours);
  const openNow = restaurantOpenNow();

  let overlay = document.querySelector('#info-overlay');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'info-overlay';
    overlay.className = 'modal';
    document.body.appendChild(overlay);

    overlay.onclick = event => {
      if (event.target === overlay) {
        overlay.remove();
      }
    };
  }

  overlay.innerHTML = `
    <div class="modal-card" id="info-content">

      <button class="modal-close" id="info-close" type="button" aria-label="Fermer">×</button>

      <p class="eyebrow">Informations</p>
      <h2>${escapeHtml(displayName)}</h2>

      <p class="oi-info-status">
        <span class="oi-status-badge ${openNow ? 'is-open' : 'is-closed'}">
          <span class="oi-status-dot"></span>
          ${openNow ? 'Ouvert actuellement' : 'Fermé actuellement'}
        </span>
      </p>

      ${address ? `<p class="oi-info-row">${escapeHtml(address)}</p>` : ''}

      ${phone ? `<p class="oi-info-row"><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></p>` : ''}

      ${
        hours.length
          ? `
            <div class="footer-hours oi-info-hours">
              ${hours
                .map(
                  line => `
                    <span>
                      ${escapeHtml(line.label)}
                      <b>${escapeHtml(line.hours)}</b>
                    </span>
                  `
                )
                .join('')}
            </div>
          `
          : ''
      }

      ${
        restaurant?.settings?.delivery_redirect_url
          ? `
            <a
              class="secondary full oi-info-delivery"
              href="${escapeHtml(restaurant.settings.delivery_redirect_url)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              Livraison via Uber Eats →
            </a>
          `
          : ''
      }

    </div>
  `;

  overlay.querySelector('#info-close').onclick = () => {
    overlay.remove();
  };
}

/* -------------------------------------------------------------------------- */
/* Compte client                                                             */
/* -------------------------------------------------------------------------- */

async function openAccountModal() {
  let overlay = document.querySelector(
    '#account-overlay'
  );

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'account-overlay';
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card order-detail-card" id="account-content"></div>
    `;
    document.body.appendChild(overlay);

    overlay.onclick = event => {
      if (event.target === overlay) {
        overlay.remove();
      }
    };
  }

  accountError = '';
  accountLoading = true;
  renderAccountContent();

  try {
    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (session) {
      await loadAccountDashboard();
    } else {
      accountView = 'login';
    }
  } catch (error) {
    console.error(
      '[FOODATOI] Erreur ouverture compte:',
      error
    );

    accountError =
      'Impossible de charger ton compte pour le moment.';
  }

  accountLoading = false;
  renderAccountContent();
}

async function loadAccountDashboard() {
  accountCustomer = await getCustomerProfile(
    supabase,
    restaurant.id
  );

  if (!accountCustomer) {
    accountView = 'login';
    return;
  }

  const [orders, consents] = await Promise.all([
    getCustomerOrders(supabase, accountCustomer.id),
    getCustomerConsents(supabase, accountCustomer.id)
  ]);

  accountOrders = orders;
  accountConsents = consents;
  accountView = 'dashboard';
}

function consentValue(channel) {
  return Boolean(
    accountConsents.find(c => c.channel === channel)
      ?.granted
  );
}

function renderAccountContent() {
  const element = document.querySelector(
    '#account-content'
  );

  if (!element) {
    return;
  }

  const errorBlock = accountError
    ? `<p class="account-error">${escapeHtml(accountError)}</p>`
    : '';

  if (accountLoading) {
    element.innerHTML = `
      <p class="eyebrow">Mon compte</p>
      <h2>Chargement…</h2>
    `;
    return;
  }

  if (accountView === 'dashboard' && accountCustomer) {
    element.innerHTML = `
      <button class="modal-close" id="account-close">×</button>

      <p class="eyebrow">Mon compte</p>
      <h2>${escapeHtml(accountCustomer.name || 'Bonjour')}</h2>
      <p>${escapeHtml(accountCustomer.email || '')}</p>

      ${errorBlock}

      <div class="account-section">
        <h3>Mes commandes</h3>
        ${
          accountOrders.length
            ? `<ul class="account-orders">
                ${accountOrders
                  .map(
                    order => `
                      <li>
                        <div>
                          <strong>${escapeHtml(order.order_number)}</strong>
                          <span>${new Date(order.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                        </div>
                        <div>
                          ${(order.order_items || [])
                            .map(
                              item =>
                                `${item.quantity}× ${escapeHtml(item.product_name)}`
                            )
                            .join(', ')}
                        </div>
                        <strong>${euro((order.total_cents || 0) / 100)}</strong>
                      </li>
                    `
                  )
                  .join('')}
              </ul>`
            : `<p class="muted">Aucune commande pour le moment.</p>`
        }
      </div>

      <div class="account-section">
        <h3>Communications</h3>
        <label class="account-toggle">
          <input type="checkbox" id="consent-email" ${consentValue('EMAIL') ? 'checked' : ''}>
          Recevoir des offres par email
        </label>
        <label class="account-toggle">
          <input type="checkbox" id="consent-sms" ${consentValue('SMS') ? 'checked' : ''}>
          Recevoir des offres par SMS
        </label>
      </div>

      <div class="account-section">
        <button class="secondary full" id="account-logout" type="button">
          Se déconnecter
        </button>

        ${
          accountDeleteConfirming
            ? `
              <p class="account-error">
                Cette action supprime définitivement ton compte, tes coordonnées et tes préférences. Elle ne peut pas être annulée.
              </p>
              <button class="danger full" id="account-delete-confirm" type="button">
                Confirmer la suppression définitive
              </button>
              <button class="secondary full" id="account-delete-cancel" type="button">
                Annuler
              </button>
            `
            : `
              <button class="danger full" id="account-delete" type="button">
                Supprimer mon compte et mes données
              </button>
            `
        }
      </div>
    `;

    bindAccountDashboardEvents();
    return;
  }

  const isSignup = accountView === 'signup';

  element.innerHTML = `
    <button class="modal-close" id="account-close">×</button>

    <p class="eyebrow">Mon compte</p>
    <h2>${isSignup ? 'Créer un compte' : 'Se connecter'}</h2>

    ${errorBlock}

    <form id="account-form" class="order-form">
      <label>
        EMAIL
        <input name="email" type="email" required autocomplete="email">
      </label>

      ${
        isSignup
          ? `
            <label>
              NOM
              <input name="name" required autocomplete="name">
            </label>
            <label>
              TÉLÉPHONE
              <input name="phone" inputmode="tel" autocomplete="tel">
            </label>
          `
          : ''
      }

      <label>
        MOT DE PASSE
        <input name="password" type="password" required autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="6">
      </label>

      ${
        isSignup
          ? `
            <label class="account-toggle">
              <input type="checkbox" name="marketingEmail">
              Je souhaite recevoir des offres par email
            </label>
            <label class="account-toggle">
              <input type="checkbox" name="marketingSms">
              Je souhaite recevoir des offres par SMS
            </label>
            <p class="account-legal">
              Tes données servent uniquement à gérer ton compte et tes commandes chez ${escapeHtml(getRestaurantDisplayName())}. Tu peux les supprimer à tout moment depuis cet espace.
            </p>
          `
          : ''
      }

      <button class="primary full" type="submit">
        ${isSignup ? 'Créer mon compte →' : 'Se connecter →'}
      </button>
    </form>

    <button class="secondary full" id="account-toggle-mode" type="button">
      ${isSignup ? 'J’ai déjà un compte' : 'Créer un compte'}
    </button>
  `;

  bindAccountAuthEvents();
}

function bindAccountAuthEvents() {
  const closeButton = document.querySelector('#account-close');
  if (closeButton) {
    closeButton.onclick = () =>
      document.querySelector('#account-overlay')?.remove();
  }

  const toggleButton = document.querySelector('#account-toggle-mode');
  if (toggleButton) {
    toggleButton.onclick = () => {
      accountView = accountView === 'signup' ? 'login' : 'signup';
      accountError = '';
      renderAccountContent();
    };
  }

  const form = document.querySelector('#account-form');
  if (form) {
    form.onsubmit = async event => {
      event.preventDefault();

      const formData = Object.fromEntries(
        new FormData(event.currentTarget)
      );

      if (!isValidEmail(formData.email)) {
        accountError = 'Adresse email invalide.';
        renderAccountContent();
        return;
      }

      accountLoading = true;
      accountError = '';
      renderAccountContent();

      try {
        if (accountView === 'signup') {
          const result = await signUpCustomer(
            supabase,
            restaurant.id,
            formData
          );

          if (result.pendingConfirmation) {
            accountLoading = false;
            accountError =
              'Compte créé ! Vérifie tes emails pour confirmer ton adresse avant de te connecter.';
            accountView = 'login';
            renderAccountContent();
            return;
          }

          await loadAccountDashboard();
        } else {
          await signInCustomer(supabase, formData);
          await loadAccountDashboard();
        }
      } catch (error) {
        console.error(
          '[FOODATOI] Erreur compte client:',
          error
        );

        logClientError(supabase, {
          restaurantId: restaurant?.id,
          context: 'main.customerAccount',
          message: error?.message ?? String(error),
          page: 'main'
        });

        accountError =
          String(error?.message || '').includes(
            'Invalid login credentials'
          )
            ? 'Email ou mot de passe incorrect.'
            : String(error?.message || '').includes(
                'already registered'
              )
            ? 'Un compte existe déjà avec cet email.'
            : 'Impossible de traiter la demande pour le moment.';
      }

      accountLoading = false;
      renderAccountContent();
    };
  }
}

function bindAccountDashboardEvents() {
  const closeButton = document.querySelector('#account-close');
  if (closeButton) {
    closeButton.onclick = () =>
      document.querySelector('#account-overlay')?.remove();
  }

  const logoutButton = document.querySelector('#account-logout');
  if (logoutButton) {
    logoutButton.onclick = async () => {
      await signOutCustomer(supabase);
      accountView = 'login';
      accountCustomer = null;
      accountOrders = [];
      accountConsents = [];
      accountDeleteConfirming = false;
      renderAccountContent();
    };
  }

  ['EMAIL', 'SMS'].forEach(channel => {
    const input = document.querySelector(
      `#consent-${channel.toLowerCase()}`
    );

    if (input) {
      input.onchange = async () => {
        try {
          await setCustomerConsent(supabase, {
            restaurantId: restaurant.id,
            customerId: accountCustomer.id,
            channel,
            granted: input.checked
          });

          accountConsents = await getCustomerConsents(
            supabase,
            accountCustomer.id
          );
        } catch (error) {
          console.error(
            '[FOODATOI] Erreur consentement:',
            error
          );
          input.checked = !input.checked;
        }
      };
    }
  });

  const deleteButton = document.querySelector('#account-delete');
  if (deleteButton) {
    deleteButton.onclick = () => {
      accountDeleteConfirming = true;
      renderAccountContent();
    };
  }

  const cancelButton = document.querySelector(
    '#account-delete-cancel'
  );
  if (cancelButton) {
    cancelButton.onclick = () => {
      accountDeleteConfirming = false;
      renderAccountContent();
    };
  }

  const confirmButton = document.querySelector(
    '#account-delete-confirm'
  );
  if (confirmButton) {
    confirmButton.onclick = async () => {
      accountLoading = true;
      renderAccountContent();

      try {
        await deleteCustomerAccount(supabase);
        accountView = 'login';
        accountCustomer = null;
        accountOrders = [];
        accountConsents = [];
        accountDeleteConfirming = false;
        accountError =
          'Ton compte et tes données ont été supprimés.';
      } catch (error) {
        console.error(
          '[FOODATOI] Erreur suppression compte:',
          error
        );

        logClientError(supabase, {
          restaurantId: restaurant?.id,
          context: 'main.deleteAccount',
          message: error?.message ?? String(error),
          page: 'main'
        });

        accountError =
          'Impossible de supprimer le compte pour le moment.';
        accountDeleteConfirming = false;
      }

      accountLoading = false;
      renderAccountContent();
    };
  }
}

function renderCart() {
  const element =
    document.querySelector(
      '#cart-content'
    );

  if (!element) {
    return;
  }

  if (!cart.length) {
    cartStep = 'review';

    element.innerHTML = `
      <div class="empty-ticket">

        <div class="empty-ticket-mark">
          +
        </div>

        <h3>
          Ton panier est vide.
        </h3>

        <p>
          Choisis quelque chose dans la carte.
          On s'occupe du reste.
        </p>

        <button
          class="primary full"
          id="back-menu"
          type="button"
        >
          Voir la carte
        </button>

      </div>
    `;

    element.querySelector(
      '#back-menu'
    ).onclick =
      closeCart;

    return;
  }

  if (cartStep === 'details') {
    renderCartDetails(element);
    return;
  }

  renderCartReview(element);
}

function renderCartReview(element) {
  const subtotal = calculateTotal(cart);
  const cartEtaLabel = getCartEtaLabel();

  element.innerHTML = `
    <div class="oi-cart-items">
      ${cart
        .map((item, index) => ticketItem(item, index))
        .join('')}
    </div>

    <div class="oi-cart-totals">
      <div class="oi-cart-total-row">
        <span>Sous-total</span>
        <span>${euro(subtotal)}</span>
      </div>
      <div class="oi-cart-total-row oi-cart-total-row--grand">
        <span>Total</span>
        <strong>${euro(subtotal)}</strong>
      </div>
    </div>

    ${cartEtaLabel ? `<p class="oi-cart-estimate">${escapeHtml(cartEtaLabel)}</p>` : ''}

    <div class="oi-sheet-cta">
      <button class="primary full" id="cart-continue" type="button">
        Continuer · ${euro(subtotal)}
      </button>
    </div>
  `;

  element.querySelectorAll('[data-remove]').forEach(button => {
    button.onclick = () => {
      cart.splice(Number(button.dataset.remove), 1);
      renderCart();
      updateCartIndicators();
    };
  });

  element.querySelectorAll('[data-edit]').forEach(button => {
    button.onclick = () => {
      openProduct(button.dataset.editId, Number(button.dataset.edit));
    };
  });

  const continueButton = element.querySelector('#cart-continue');

  if (continueButton) {
    continueButton.onclick = () => {
      cartStep = 'details';
      renderCart();
    };
  }
}

function renderCartDetails(element) {
  const subtotal = calculateTotal(cart);
  const openNow = restaurantOpenNow();

  element.innerHTML = `
    <button type="button" id="cart-back" class="oi-back-link">
      ${ICONS.chevronLeft} Retour au panier
    </button>

    <form
      id="order-form"
      class="order-form oi-checkout-form"
    >

      <p class="eyebrow">
        Vos coordonnées
      </p>

      <label>
        TON NOM

        <input
          name="name"
          required
          placeholder="Prénom ou nom"
          autocomplete="name"
        >
      </label>

      <label>
        TON TÉLÉPHONE

        <input
          name="phone"
          required
          inputmode="tel"
          placeholder="06 00 00 00 00"
          autocomplete="tel"
        >
      </label>

      <label>
        EMAIL (facultatif)

        <input
          name="email"
          type="email"
          id="email-field"
          placeholder="toi@exemple.fr"
          autocomplete="email"
        >
      </label>

      <p class="eyebrow oi-form-section">
        Mode de commande
      </p>

      <p class="oi-mode-readout">
        ${orderMode === 'onsite' ? 'Sur place' : 'À emporter'}
      </p>

      <p class="eyebrow oi-form-section">
        Créneau
      </p>

      <label>
        HEURE SOUHAITÉE

        <input
          name="pickupTime"
          type="time"
          required
        >
      </label>

      <label>
        DEMANDE SPÉCIALE (facultatif)

        <textarea
          name="specialInstructions"
          rows="2"
          maxlength="280"
          placeholder="Sans oignons, moins de sauce fromagère..."
        ></textarea>
      </label>

      ${
        !openNow
          ? `
            <div class="closed-banner">
              <p class="eyebrow">
                FERMÉ ACTUELLEMENT
              </p>
              <p>
                ${escapeHtml(getRestaurantDisplayName())}
                n'accepte pas de commande en dehors de ses horaires d'ouverture.
                Reviens plus tard pour commander.
              </p>
            </div>
          `
          : ''
      }

      <p class="oi-payment-note">
        Paiement au restaurant
      </p>

      <div class="oi-sheet-cta">
        <button
          class="primary full"
          type="submit"
          id="submit-order"
          ${!openNow ? 'disabled' : ''}
        >
          Commander · ${euro(subtotal)}
        </button>

        <small>
          ${
            remoteStore
              ? `Commande transmise directement à l’espace ${escapeHtml(
                  getRestaurantDisplayName()
                )}.`
              : 'Mode démo : aucune commande réelle n’est envoyée.'
          }
        </small>
      </div>

    </form>
  `;

  const backButton = element.querySelector('#cart-back');

  if (backButton) {
    backButton.onclick = () => {
      cartStep = 'review';
      renderCart();
    };
  }

  const form =
    element.querySelector(
      '#order-form'
    );

  if (form) {
    const emailField = form.querySelector('#email-field');

    form.onsubmit =
      async event => {
        event.preventDefault();

        if (
          !isRestaurantOpen(
            restaurant?.settings
              ?.opening_hours
          )
        ) {
          renderCart();
          return;
        }

        const formData =
          Object.fromEntries(
            new FormData(
              event.currentTarget
            )
          );

        const email = String(formData.email || '').trim();

        if (email && !isValidEmail(email)) {
          emailField?.setCustomValidity('Adresse email invalide.');
          emailField?.reportValidity();
          return;
        }

        emailField?.setCustomValidity('');

        const order =
          createOrder(
            cart,
            formData
          );

        /*
         * Ni "sur place" ni l'email n'ont de colonne dédiée côté
         * données (create_order n'en attend pas) : reportés dans
         * les notes, déjà lues par le comptoir, plutôt que
         * silencieusement perdus.
         */
        const noteParts = [];

        if (orderMode === 'onsite') {
          noteParts.push('Sur place');
        }

        if (email) {
          noteParts.push(`Email : ${email}`);
        }

        const specialInstructions =
          String(
            formData.specialInstructions ||
              ''
          ).trim();

        if (specialInstructions) {
          noteParts.push(specialInstructions);
        }

        order.notes =
          noteParts.join(' — ').slice(0, 500) || null;

        if (!checkoutIdempotencyKey) {
          checkoutIdempotencyKey =
            crypto.randomUUID();
        }

        order.idempotencyKey =
          checkoutIdempotencyKey;

        await submitOrder(
          order
        );
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Ticket                                                                     */
/* -------------------------------------------------------------------------- */

function ticketItem(
  item,
  index
) {
  const options =
    formatOptions(
      item.options
    );

  return `
    <div class="oi-cart-item">

      <div class="oi-cart-item-main">

        <strong>
          ${item.quantity} × ${escapeHtml(item.name)}
        </strong>

        ${options ? `<span class="oi-cart-item-options">${escapeHtml(options)}</span>` : ''}

        <div class="oi-cart-item-actions">
          <button data-edit="${index}" data-edit-id="${escapeHtml(item.id)}" type="button">
            Modifier
          </button>
          <button data-remove="${index}" type="button">
            Supprimer
          </button>
        </div>

      </div>

      <b>
        ${euro(item.price * item.quantity)}
      </b>

    </div>
  `;
}

function formatOptions(
  options = {}
) {
  if (
    !options ||
    typeof options !==
      'object'
  ) {
    return '';
  }

  const parts = [];

  if (
    Array.isArray(
      options.meats
    )
  ) {
    parts.push(
      `Viandes : ${options.meats.join(
        ', '
      )}`
    );
  } else if (
    options.meat
  ) {
    parts.push(
      `Viande : ${options.meat}`
    );
  }

  if (options.sauce) {
    parts.push(
      `Sauce : ${options.sauce}`
    );
  }

  if (options.drink) {
    parts.push(
      `Boisson : ${options.drink}`
    );
  }

  return parts.join(
    ' · '
  );
}

/* -------------------------------------------------------------------------- */
/* Order submission                                                           */
/* -------------------------------------------------------------------------- */

async function submitOrder(
  order
) {
  try {
    let saved;

    const tenantOrder = {
      ...order,

      restaurant_id:
        restaurant?.id ||
        null,

      restaurantId:
        restaurant?.id ||
        null
    };

    if (
      !tenantOrder.restaurant_id
    ) {
      throw new Error(
        'Restaurant FOODATOI introuvable pour cette commande.'
      );
    }

    if (remoteStore) {
      saved =
        await remoteStore.createOrder(
          tenantOrder
        );
    } else {
      const existing =
        JSON.parse(
          localStorage.getItem(
            'foodatoi-orders'
          ) || '[]'
        );

      saved =
        appendOrder(
          existing,
          tenantOrder
        ).at(-1);

      localStorage.setItem(
        'foodatoi-orders',
        JSON.stringify([
          ...existing,
          saved
        ])
      );
    }

    cart = [];
    checkoutIdempotencyKey = null;

    showConfirmation(
      saved
    );
  } catch (error) {
    console.error(
      '[FOODATOI] Erreur création commande:',
      error
    );

    logClientError(supabase, {
      restaurantId: restaurant?.id,
      context: 'main.createOrder',
      message: error?.message ?? String(error),
      page: 'main'
    });

    alert(
      String(error?.message || '').includes(
        'RESTAURANT_CLOSED'
      )
        ? 'Le restaurant est fermé actuellement, la commande n’a pas pu être envoyée.'
        : String(error?.message || '').includes(
            'RATE_LIMITED'
          )
        ? 'Trop de commandes envoyées récemment avec ce numéro. Réessaie dans quelques minutes.'
        : 'Impossible d’envoyer la commande pour le moment.'
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Confirmation                                                               */
/* -------------------------------------------------------------------------- */

function showConfirmation(
  order
) {
  const ticket =
    buildTicketModel(
      order
    );

  closeCart();

  document.querySelector(
    '#modal-content'
  ).innerHTML = `
    <div class="confirmation">

      <div class="confirmed-stamp">
        ✓
      </div>

      <p class="eyebrow">
        COMMANDE ENREGISTRÉE
      </p>

      <h2>
        ${escapeHtml(
          ticket.number
        )}
      </h2>

      <p>
        Ton ticket est parti chez
        <strong>
          ${escapeHtml(
            getRestaurantDisplayName()
          )}
        </strong>.

        Retrait souhaité à
        <strong>
          ${escapeHtml(
            ticket.pickup
          )}
        </strong>.
      </p>

      <div class="ticket-paper compact">

        <div class="ticket-items">

          ${ticket.items
            .map(
              item => `
                <div class="ticket-item">

                  <div>

                    <strong>
                      ${item.quantity} ×
                      ${escapeHtml(
                        item.name
                      )}
                    </strong>

                    <span>
                      ${escapeHtml(
                        item.options ||
                          ''
                      )}
                    </span>

                  </div>

                </div>
              `
            )
            .join('')}

        </div>

        <div class="ticket-total">

          <span>
            TOTAL
          </span>

          <strong>
            ${escapeHtml(
              ticket.totalLabel
            )}
          </strong>

        </div>

      </div>

      <button
        class="primary full"
        id="done"
        type="button"
      >
        Terminé
      </button>

    </div>
  `;

  document
    .querySelector(
      '#product-modal'
    )
    .classList.remove(
      'hidden'
    );

  document.querySelector(
    '#done'
  ).onclick = () => {
    document
      .querySelector(
        '#product-modal'
      )
      .classList.add(
        'hidden'
      );

    render();
  };
}

/* -------------------------------------------------------------------------- */
/* Application bootstrap                                                      */
/* -------------------------------------------------------------------------- */

async function bootstrap() {
  try {
    renderLoading();

    /**
     * 1. Résout /caz-food
     *    vers le restaurant Caz Food.
     */
    await resolveRestaurant();

    /**
     * 2. Charge uniquement les produits
     *    du restaurant résolu.
     */
    await loadMenu();

    /**
     * 3. Affiche la carte.
     */
    render();

  } catch (error) {
    /*
     * foodatoi.fr est maintenant le domaine de la PLATEFORME, plus
     * celui de Caz Food spécifiquement - visiter la racine sans
     * aucun ?resto= ni chemin ne doit pas afficher une erreur, mais
     * rediriger vers la page vitrine. Un slug fourni mais invalide
     * (lien mal copié) reste, lui, une vraie erreur à afficher.
     */
    const noSlugProvided =
      !getRestaurantSlugFromQuery() &&
      !getRestaurantSlugFromPath();

    if (noSlugProvided) {
      window.location.replace('/pro.html');
      return;
    }

    renderError(
      error
    );
  }
}

bootstrap();
