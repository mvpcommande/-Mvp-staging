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

function getRestaurantDisplayName() {
  return (
    restaurant?.name ||
    'FOODATOI'
  );
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
      )
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
    <div class="app-frame">

      <main>

        <section class="order-intro">

          <div class="intro-copy">

            <p class="eyebrow">
              FOODATOI
            </p>

            <h1>
              Chargement<br>
              <em>du restaurant.</em>
            </h1>

            <p class="intro-lede">
              Nous préparons la carte.
            </p>

          </div>

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
    <div class="app-frame">

      <main>

        <section class="order-intro">

          <div class="intro-copy">

            <p class="eyebrow">
              FOODATOI
            </p>

            <h1>
              Restaurant<br>
              <em>indisponible.</em>
            </h1>

            <p class="intro-lede">
              La configuration de ce restaurant
              n'est pas encore disponible.
            </p>

            <div class="pickup-line">

              <span>
                Vérifie l'URL ou réessaie plus tard.
              </span>

            </div>

          </div>

        </section>

      </main>

    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Main render                                                                */
/* -------------------------------------------------------------------------- */

function render() {
  const categories =
    getCategories();

  const displayName =
    getRestaurantDisplayName();

  const address =
    getRestaurantAddress();

  const phone =
    getRestaurantPhone();

  app.innerHTML = `
    <div class="app-frame">

      <header class="masthead">

        <div class="brand-lockup">

          ${
            restaurant?.logo_url
              ? `
                <img
                  class="brand-mark-image"
                  src="${escapeHtml(
                    restaurant.logo_url
                  )}"
                  alt="${escapeHtml(
                    displayName
                  )}"
                >
              `
              : `
                <span class="brand-mark">
                  ${escapeHtml(
                    displayName
                      .slice(0, 2)
                      .toUpperCase()
                  )}
                </span>
              `
          }

          <div>

            <strong>
              ${escapeHtml(
                displayName
              )}
            </strong>

            <span>
              ${escapeHtml(
                restaurant?.sector ||
                'RESTAURANT'
              )}
            </span>

          </div>

        </div>

        <div class="masthead-actions">

          <button
            class="account-pill"
            id="open-account"
            type="button"
          >
            Compte
          </button>

          <button
            class="order-pill"
            id="open-cart"
            type="button"
          >
            <span>
              Ma commande
            </span>

            <b>
              ${itemCount()}
            </b>
          </button>

        </div>

      </header>

      <main>

        <section class="order-intro">

          <div class="intro-copy">

            <p class="eyebrow">
              COMMANDE DIRECTE
            </p>

            <h1>
              Choisis.<br>
              <em>On prépare.</em>
            </h1>

            <p class="intro-lede">
              Ton repas, directement chez
              ${escapeHtml(
                displayName
              )}.
              Pas de détour, pas de plateforme.
            </p>

            <div class="pickup-line">

              <span class="live-dot"></span>

              <span>
                Retrait sur place
              </span>

              <span class="slash">
                /
              </span>

              <span>
                Paiement au restaurant
              </span>

            </div>

          </div>

          <div
            class="receipt-hero"
            aria-label="Retrait sur place"
          >

            <div class="receipt-top">

              <span>
                ${escapeHtml(
                  displayName
                )}
              </span>

              <span>
                AUJ.
              </span>

            </div>

            <div class="receipt-hole"></div>

            <div class="receipt-main">

              <small>
                TON REPAS
              </small>

              <strong>
                COMMENCE<br>
                ICI.
              </strong>

              ${
                address
                  ? `
                    <span>
                      ${escapeHtml(
                        address
                      )}
                    </span>
                  `
                  : ''
              }

            </div>

            <div class="receipt-barcode">

              <i></i>
              <i></i>
              <i></i>
              <i></i>
              <i></i>
              <i></i>
              <i></i>

            </div>

            <div class="receipt-code">
              FOODATOI
            </div>

          </div>

        </section>

        ${
          restaurant?.settings?.delivery_redirect_url
            ? `
              <section class="delivery-banner">

                <div>

                  <p class="eyebrow">
                    LIVRAISON À DOMICILE
                  </p>

                  <p>
                    ${escapeHtml(
                      displayName
                    )}
                    livre aussi à domicile via Uber Eats.
                  </p>

                </div>

                <a
                  class="secondary"
                  href="${escapeHtml(
                    restaurant.settings.delivery_redirect_url
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Commander sur Uber Eats →
                </a>

              </section>
            `
            : ''
        }

        <section class="menu-section">

          <div class="section-head">

            <div>

              <p class="eyebrow">
                LA CARTE
              </p>

              <h2>
                Tu prends quoi ?
              </h2>

            </div>

            <span class="menu-count">

              ${menu.length}

              ${
                menu.length > 1
                  ? 'produits'
                  : 'produit'
              }

            </span>

          </div>

          ${
            categories.length > 1
              ? `
                <nav
                  class="category-rail"
                  aria-label="Catégories"
                >

                  ${categories
                    .map(
                      category => `
                        <button
                          class="category"
                          data-category="${escapeHtml(
                            category
                          )}"
                          data-target="${
                            category === 'Tous'
                              ? 'top'
                              : escapeHtml(
                                  slugifyCategory(
                                    category
                                  )
                                )
                          }"
                          type="button"
                        >
                          ${escapeHtml(
                            category
                          )}
                        </button>
                      `
                    )
                    .join('')}

                </nav>
              `
              : ''
          }

          ${
            menu.length
              ? groupByCategory(menu)
                  .map(
                    group => `
                      <section
                        class="menu-category-section"
                        id="menu-cat-${group.slug}"
                      >

                        <h2 class="menu-category-heading">
                          ${escapeHtml(
                            group.category
                          )}
                        </h2>

                        <div class="menu-grid">
                          ${group.items
                            .map(card)
                            .join('')}
                        </div>

                      </section>
                    `
                  )
                  .join('')
              : `
                <div class="empty-ticket">

                  <div class="empty-ticket-mark">
                    +
                  </div>

                  <h3>
                    Carte en préparation.
                  </h3>

                  <p>
                    Ce restaurant n'a pas encore
                    publié de produits.
                  </p>

                </div>
              `
          }

        </section>

      </main>

      <footer class="site-footer">

        <div>

          <strong>
            ${escapeHtml(
              displayName
            )}
          </strong>

          ${
            address
              ? `
                <span>
                  ${escapeHtml(
                    address
                  )}
                </span>
              `
              : ''
          }

        </div>

        ${
          formatOpeningHours(
            restaurant?.settings
              ?.opening_hours
          ).length
            ? `
              <div class="footer-hours">
                ${formatOpeningHours(
                  restaurant?.settings
                    ?.opening_hours
                )
                  .map(
                    (line) => `
                      <span>
                        ${escapeHtml(
                          line.label
                        )}
                        <b>
                          ${escapeHtml(
                            line.hours
                          )}
                        </b>
                      </span>
                    `
                  )
                  .join('')}
              </div>
            `
            : ''
        }

        <div>

          ${
            phone
              ? `
                <a
                  href="tel:${escapeHtml(
                    phone
                  )}"
                >
                  ${escapeHtml(
                    phone
                  )}
                </a>
              `
              : ''
          }

          ${
            restaurant?.settings
              ?.facebook_url
              ? `
                <a
                  href="${escapeHtml(
                    restaurant.settings
                      .facebook_url
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Facebook
                </a>
              `
              : ''
          }

          <a href="/legal.html">
            Mentions légales
          </a>

        </div>

      </footer>

    </div>

    <div
      class="drawer-backdrop hidden"
      id="backdrop"
    ></div>

    <aside
      class="drawer"
      id="drawer"
      aria-label="Panier"
    >

      <div class="drawer-head">

        <div>

          <p class="eyebrow">
            ${escapeHtml(
              displayName
            )}
          </p>

          <h2>
            Ton ticket
          </h2>

        </div>

        <button
          id="close-cart"
          class="icon-btn"
          type="button"
          aria-label="Fermer"
        >
          ×
        </button>

      </div>

      <div id="cart-content"></div>

    </aside>

    <div
      class="modal hidden"
      id="product-modal"
    >

      <div
        class="modal-card"
        id="modal-content"
      ></div>

    </div>
  `;

  bind();
  renderCart();
}

/* -------------------------------------------------------------------------- */
/* Product card                                                               */
/* -------------------------------------------------------------------------- */

function card(item) {
  return `
    <article class="menu-card">

      <div class="menu-card-media">
        ${
          item.imageUrl
            ? `
              <img
                src="${escapeHtml(
                  item.imageUrl
                )}"
                alt=""
                loading="lazy"
              >
            `
            : `
              <span class="menu-card-media-fallback">
                ${escapeHtml(
                  item.emoji
                )}
              </span>
            `
        }
      </div>

      <div class="menu-card-body">

        <p class="eyebrow">
          ${escapeHtml(
            item.category
          )}
        </p>

        <h3>
          ${escapeHtml(
            item.name
          )}
        </h3>

        ${
          item.description
            ? `
              <p>
                ${escapeHtml(
                  item.description
                )}
              </p>
            `
            : ''
        }

      </div>

      <div class="menu-card-bottom">

        <strong>
          ${euro(
            item.price
          )}
        </strong>

        <button
          class="add-button"
          data-add="${escapeHtml(
            item.id
          )}"
          type="button"
          aria-label="Ajouter ${escapeHtml(
            item.name
          )}"
        >

          <span>
            +
          </span>

          Ajouter

        </button>

      </div>

    </article>
  `;
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
        openProduct(
          button.dataset.add
        );
    });

  const openCartButton =
    document.querySelector(
      '#open-cart'
    );

  if (openCartButton) {
    openCartButton.onclick =
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

/* -------------------------------------------------------------------------- */
/* Product modal                                                              */
/* -------------------------------------------------------------------------- */

function openProduct(id) {
  const item =
    menu.find(
      product =>
        product.id === id
    );

  if (!item) {
    return;
  }

  const meatField =
    buildMeatField(item);

  const sauceField =
    buildSauceField(item);

  const drinkField =
    buildDrinkField(item);

  document.querySelector(
    '#modal-content'
  ).innerHTML = `

    <button
      class="modal-close"
      id="modal-close"
      type="button"
      aria-label="Fermer"
    >
      ×
    </button>

    ${
      item.imageUrl
        ? `
          <img
            class="product-photo"
            src="${escapeHtml(
              item.imageUrl
            )}"
            alt=""
          >
        `
        : `
          <div class="product-mark">
            ${escapeHtml(
              item.emoji
            )}
          </div>
        `
    }

    <p class="eyebrow">
      ${escapeHtml(
        item.category
      )}
    </p>

    <h2>
      ${escapeHtml(
        item.name
      )}
    </h2>

    ${
      item.description
        ? `
          <p>
            ${escapeHtml(
              item.description
            )}
          </p>
        `
        : ''
    }

    <div class="form-grid">

      ${meatField}

      ${sauceField}

      ${drinkField}

      <label>
        QUANTITÉ

        <input
          id="qty"
          type="number"
          min="1"
          max="20"
          value="1"
          inputmode="numeric"
        >
      </label>

    </div>

    <button
      class="primary full"
      id="confirm-add"
      type="button"
    >
      Ajouter · ${euro(
        item.price
      )}
    </button>
  `;

  document
    .querySelector(
      '#product-modal'
    )
    .classList.remove(
      'hidden'
    );

  document.querySelector(
    '#modal-close'
  ).onclick = () => {
    document
      .querySelector(
        '#product-modal'
      )
      .classList.add(
        'hidden'
      );
  };

  document.querySelector(
    '#confirm-add'
  ).onclick = () => {
    const quantity =
      Math.max(
        1,
        Math.min(
          20,
          Number(
            document.querySelector(
              '#qty'
            ).value || 1
          )
        )
      );

    const options = {};

    const meat1 =
      document.querySelector(
        '#meat-1'
      )?.value;

    const meat2 =
      document.querySelector(
        '#meat-2'
      )?.value;

    const meat3 =
      document.querySelector(
        '#meat-3'
      )?.value;

    const sauce =
      document.querySelector(
        '#sauce'
      )?.value;

    const drink =
      document.querySelector(
        '#drink'
      )?.value;

    if (meat1) {
      options.meat =
        meat1;
    }

    if (meat2) {
      options.meat2 =
        meat2;
    }

    if (meat3) {
      options.meat3 =
        meat3;
    }

    if (meat2 || meat3) {
      options.meats = [
        meat1,
        meat2,
        meat3
      ].filter(Boolean);
    }

    if (sauce) {
      options.sauce =
        sauce;
    }

    if (drink) {
      options.drink =
        drink;
    }

    cart = addItem(
      cart,
      {
        ...item,
        quantity,
        options
      }
    );

    document
      .querySelector(
        '#product-modal'
      )
      .classList.add(
        'hidden'
      );

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

function buildMeatField(item) {
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
    return `
      <label>
        VIANDE 1

        <select id="meat-1">
          ${optionsHtml(
            options
          )}
        </select>
      </label>

      <label>
        VIANDE 2

        <select id="meat-2">
          ${optionsHtml(
            options
          )}
        </select>
      </label>

      <label>
        VIANDE 3

        <select id="meat-3">
          ${optionsHtml(
            options
          )}
        </select>
      </label>
    `;
  }

  if (item.multipleMeat) {
    return `
      <label>
        VIANDE 1

        <select id="meat-1">
          ${optionsHtml(
            options
          )}
        </select>
      </label>

      <label>
        VIANDE 2

        <select id="meat-2">
          ${optionsHtml(
            options
          )}
        </select>
      </label>
    `;
  }

  return `
    <label>
      VIANDE

      <select id="meat-1">
        ${optionsHtml(
          options
        )}
      </select>
    </label>
  `;
}

function buildSauceField(item) {
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

  return `
    <label>
      SAUCE

      <select id="sauce">
        ${optionsHtml(
          options
        )}
      </select>
    </label>
  `;
}

function buildDrinkField(item) {
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

  return `
    <label>
      BOISSON

      <select id="drink">
        ${optionsHtml(
          options
        )}
      </select>
    </label>
  `;
}

function optionsHtml(options) {
  return options
    .map(
      option =>
        `<option value="${escapeHtml(
          option
        )}">${escapeHtml(
          option
        )}</option>`
    )
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Cart                                                                       */
/* -------------------------------------------------------------------------- */

function openCart() {
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
    element.innerHTML = `
      <div class="empty-ticket">

        <div class="empty-ticket-mark">
          +
        </div>

        <h3>
          Ton ticket est vide.
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

  element.innerHTML = `
    <div class="ticket-paper">

      <div class="ticket-header">

        <span>
          ${escapeHtml(
            getRestaurantDisplayName()
          )}
        </span>

        <span>
          COMMANDE
        </span>

      </div>

      <div class="ticket-items">

        ${cart
          .map(
            (
              item,
              index
            ) =>
              ticketItem(
                item,
                index
              )
          )
          .join('')}

      </div>

      <div class="ticket-total">

        <span>
          TOTAL
        </span>

        <strong>
          ${euro(
            calculateTotal(
              cart
            )
          )}
        </strong>

      </div>

      <div class="ticket-note">

        <strong>
          RETRAIT SUR PLACE
        </strong>

        ${
          getRestaurantAddress()
            ? `
              <span>
                ${escapeHtml(
                  getRestaurantAddress()
                )}
              </span>
            `
            : ''
        }

        <small>
          Paiement au restaurant
        </small>

      </div>

    </div>

    ${
      !isRestaurantOpen(
        restaurant?.settings
          ?.opening_hours
      )
        ? `
          <div class="closed-banner">
            <p class="eyebrow">
              FERMÉ ACTUELLEMENT
            </p>
            <p>
              ${escapeHtml(
                getRestaurantDisplayName()
              )}
              n'accepte pas de commande en dehors de ses horaires d'ouverture.
              Reviens plus tard pour commander.
            </p>
          </div>
        `
        : ''
    }

    <form
      id="order-form"
      class="order-form"
    >

      <p class="eyebrow">
        DERNIÈRE ÉTAPE
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

      <button
        class="primary full"
        type="submit"
        ${
          !isRestaurantOpen(
            restaurant?.settings
              ?.opening_hours
          )
            ? 'disabled'
            : ''
        }
      >
        Envoyer ma commande →
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

    </form>
  `;

  element
    .querySelectorAll(
      '[data-remove]'
    )
    .forEach(button => {
      button.onclick = () => {
        cart.splice(
          Number(
            button.dataset.remove
          ),
          1
        );

        renderCart();
      };
    });

  const form =
    element.querySelector(
      '#order-form'
    );

  if (form) {
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

        const order =
          createOrder(
            cart,
            formData
          );

        order.notes =
          String(
            formData.specialInstructions ||
              ''
          ).trim() || null;

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
    <div class="ticket-item">

      <div>

        <strong>
          ${item.quantity} ×
          ${escapeHtml(
            item.name
          )}
        </strong>

        ${
          options
            ? `
              <span>
                ${escapeHtml(
                  options
                )}
              </span>
            `
            : ''
        }

      </div>

      <b>
        ${euro(
          item.price *
            item.quantity
        )}
      </b>

      <button
        data-remove="${index}"
        type="button"
        aria-label="Supprimer"
      >
        ×
      </button>

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
