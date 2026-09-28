import './styles.css';
import { supabase } from './supabaseClient.js';
import { escapeHtml } from './htmlEscape.mjs';
import {
  isValidEmail,
  slugify,
  signUpOwner,
  signInOwner,
  signOutOwner,
  getOwnedRestaurant,
  createOwnedRestaurant,
  updateOpeningHours,
  getOwnProducts,
  addProduct,
  toggleProductActive,
  deleteProduct,
  uploadProductPhoto,
  updateRestaurantColor,
  uploadRestaurantLogo
} from './restaurantOwner.mjs';
import { compressImage } from './imageCompression.mjs';
import { setupMenuImport } from './menuImport.mjs';
import {
  logClientError,
  installGlobalErrorLogging
} from './errorLog.mjs';
import {
  getLoyaltyProgram,
  upsertLoyaltyProgram,
  getLoyaltyRewards,
  addLoyaltyReward,
  toggleLoyaltyReward,
  deleteLoyaltyReward
} from './loyalty.mjs';

// --- Intégration SumUp (paiement en ligne) ---
// client_id et redirect_uri sont publics (ils transitent par le navigateur).
// Le client_secret vit UNIQUEMENT en secret Supabase (Edge Function).
const SUMUP_CLIENT_ID = 'cc_classic_FekbkakoriGLZPgAYEy6xCBlEKHLw';
// STAGING : dérivé du projet Supabase du build (jamais la callback de
// production, qui écrirait des tokens dans la base prod).
const SUMUP_REDIRECT_URI =
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sumup-oauth-callback`;
// TODO: repasser à 'payments' une fois le scope validé par SumUp. Pour
// l'instant on demande un scope déjà accordé, afin de tester le flux de
// connexion de bout en bout dès aujourd'hui (sandbox).
const SUMUP_SCOPES = 'transactions.history';

// Message de retour après redirection SumUp (?sumup=connected|error)
(() => {
  const status = new URLSearchParams(window.location.search).get('sumup');
  if (!status) return;
  if (status === 'connected') {
    alert('Compte SumUp connecté \u2713');
  } else if (status === 'error') {
    alert('La connexion SumUp a échoué. Réessayez.');
  }
  const clean = new URL(window.location.href);
  clean.searchParams.delete('sumup');
  window.history.replaceState({}, '', clean);
})();

const root = document.querySelector('#onboarding-root');

const SECTORS = [
  ['pizza', 'Pizza'],
  ['kebab', 'Kebab'],
  ['burger', 'Burger'],
  ['restaurant', 'Restaurant'],
  ['snack', 'Snack'],
  ['boulangerie', 'Boulangerie'],
  ['sushi', 'Sushi'],
  ['other', 'Autre']
];

const DAYS = [
  ['mon', 'Lundi'],
  ['tue', 'Mardi'],
  ['wed', 'Mercredi'],
  ['thu', 'Jeudi'],
  ['fri', 'Vendredi'],
  ['sat', 'Samedi'],
  ['sun', 'Dimanche']
];

let view = 'loading';
let authMode = 'signup';
let error = '';
let restaurant = null;
installGlobalErrorLogging(supabase, {
  page: 'onboarding',
  getRestaurantId: () => restaurant?.id ?? null
});

let openingHours = {};
let products = [];
let loyaltyProgram = null;
let loyaltyRewards = [];

function siteOrigin() {
  return `${window.location.protocol}//${window.location.host}`;
}

function orderLink() {
  return `${siteOrigin()}/?resto=${restaurant.slug}`;
}

function adminLink() {
  return `${siteOrigin()}/admin.html?resto=${restaurant.slug}`;
}

async function init() {
  if (!supabase) {
    view = 'error';
    error = 'Supabase n’est pas configuré.';
    render();
    return;
  }

  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (!session) {
    view = 'auth';
    render();
    return;
  }

  await loadOwnerState();
}

async function loadOwnerState() {
  view = 'loading';
  render();

  try {
    restaurant = await getOwnedRestaurant(supabase);

    if (!restaurant) {
      view = 'create';
      render();
      return;
    }

    openingHours = restaurant.settings?.opening_hours || {};
    products = await getOwnProducts(supabase, restaurant.id);

    if (restaurant.plan !== 'commerce') {
      loyaltyProgram = await getLoyaltyProgram(supabase, restaurant.id);
      loyaltyRewards = await getLoyaltyRewards(supabase, restaurant.id);
    }

    view = 'dashboard';
  } catch (err) {
    console.error('[FOODATOI onboarding]', err);
    error = 'Impossible de charger votre espace pour le moment.';
    view = 'error';
  }

  render();
}

function render() {
  if (view === 'loading') {
    root.innerHTML = `<div class="onboarding-shell"><p class="eyebrow">FOODATOI</p><h1>Chargement…</h1></div>`;
    return;
  }

  if (view === 'error') {
    root.innerHTML = `
      <div class="onboarding-shell">
        <p class="eyebrow">FOODATOI</p>
        <h1>Un problème est survenu.</h1>
        <p>${escapeHtml(error)}</p>
      </div>
    `;
    return;
  }

  if (view === 'auth') {
    renderAuth();
    return;
  }

  if (view === 'create') {
    renderCreate();
    return;
  }

  renderDashboard();
}

function renderAuth() {
  const isSignup = authMode === 'signup';

  root.innerHTML = `
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · ESPACE RESTAURATEUR</p>
      <h1>${isSignup ? 'Créer mon restaurant' : 'Se connecter'}</h1>
      <p class="onboarding-lede">
        Créez votre espace, configurez votre carte et récupérez vos
        liens de commande et de comptoir en quelques minutes.
      </p>

      ${error ? `<p class="onboarding-error">${escapeHtml(error)}</p>` : ''}

      <form id="auth-form" class="order-form">
        <label>
          EMAIL
          <input name="email" type="email" required autocomplete="email">
        </label>
        <label>
          MOT DE PASSE
          <input name="password" type="password" required minlength="6" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
        </label>
        <button class="primary full" type="submit">
          ${isSignup ? 'Créer mon compte →' : 'Se connecter →'}
        </button>
      </form>

      <button class="secondary full" id="toggle-auth-mode" type="button">
        ${isSignup ? 'J’ai déjà un compte' : 'Créer un compte'}
      </button>
    </div>
  `;

  document.querySelector('#toggle-auth-mode').onclick = () => {
    authMode = isSignup ? 'login' : 'signup';
    error = '';
    render();
  };

  document.querySelector('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));

    if (!isValidEmail(fields.email)) {
      error = 'Adresse email invalide.';
      render();
      return;
    }

    error = '';
    view = 'loading';
    render();

    try {
      if (isSignup) {
        const result = await signUpOwner(supabase, fields);
        if (result.pendingConfirmation) {
          view = 'auth';
          error = 'Compte créé ! Vérifiez vos emails pour confirmer votre adresse avant de vous connecter.';
          authMode = 'login';
          render();
          return;
        }
      } else {
        await signInOwner(supabase, fields);
      }

      await loadOwnerState();
    } catch (err) {
      console.error('[FOODATOI onboarding]', err);
      view = 'auth';
      error = String(err?.message || '').includes('Invalid login credentials')
        ? 'Email ou mot de passe incorrect.'
        : String(err?.message || '').includes('already registered')
        ? 'Un compte existe déjà avec cet email.'
        : 'Impossible de traiter la demande pour le moment.';
      render();
    }
  };
}

function renderCreate() {
  root.innerHTML = `
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · ÉTAPE 1</p>
      <h1>Votre restaurant</h1>
      <p class="onboarding-lede">
        Quelques infos de base pour créer votre espace. Vous
        pourrez tout modifier ensuite.
      </p>

      ${error ? `<p class="onboarding-error">${escapeHtml(error)}</p>` : ''}

      <form id="create-form" class="order-form">
        <label>
          NOM DU RESTAURANT
          <input name="name" id="create-name" required autocomplete="organization">
        </label>

        <label>
          ADRESSE DE VOTRE ESPACE
          <div class="slug-preview">
            foodatoi.fr/?resto=<span id="slug-preview-text">votre-restaurant</span>
          </div>
          <input name="slug" id="create-slug" required>
        </label>

        <label>
          TYPE D'ÉTABLISSEMENT
          <select name="sector" required>
            ${SECTORS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}
          </select>
        </label>

        <label>
          TÉLÉPHONE (facultatif)
          <input name="phone" inputmode="tel" autocomplete="tel">
        </label>

        <label>
          ADRESSE (facultatif)
          <input name="addressStreet" placeholder="Rue" autocomplete="street-address">
        </label>
        <div class="form-grid">
          <label>
            CODE POSTAL
            <input name="addressPostalCode" inputmode="numeric">
          </label>
          <label>
            VILLE
            <input name="addressCity" autocomplete="address-level2">
          </label>
        </div>

        <button class="primary full" type="submit">
          Créer mon restaurant →
        </button>
      </form>
    </div>
  `;

  const nameInput = document.querySelector('#create-name');
  const slugInput = document.querySelector('#create-slug');
  const slugPreview = document.querySelector('#slug-preview-text');
  let slugEditedManually = false;

  nameInput.oninput = () => {
    if (!slugEditedManually) {
      slugInput.value = slugify(nameInput.value);
      slugPreview.textContent = slugInput.value || 'votre-restaurant';
    }
  };

  slugInput.oninput = () => {
    slugEditedManually = true;
    slugInput.value = slugify(slugInput.value);
    slugPreview.textContent = slugInput.value || 'votre-restaurant';
  };

  document.querySelector('#create-form').onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));

    error = '';
    view = 'loading';
    render();

    try {
      await createOwnedRestaurant(supabase, fields);
      await loadOwnerState();
    } catch (err) {
      console.error('[FOODATOI onboarding]', err);
      view = 'create';
      error = String(err?.message || '').includes('SLUG_ALREADY_TAKEN')
        ? 'Cette adresse est déjà prise, choisissez-en une autre.'
        : 'Impossible de créer le restaurant pour le moment.';
      render();
    }
  };
}

function renderDashboard() {
  root.innerHTML = `
    <div class="onboarding-shell">
      <div class="onboarding-header">
        <div>
          <p class="eyebrow">FOODATOI · ${escapeHtml(restaurant.name)}</p>
          <h1>Votre espace.</h1>
        </div>
        <button class="secondary" id="signout-btn" type="button">Se déconnecter</button>
      </div>

      <section class="links-card">
        <p class="eyebrow">VOS LIENS</p>

        <div class="link-row">
          <div>
            <strong>Lien de commande</strong>
            <span>À partager avec vos clients (Facebook, flyers…)</span>
            <code>${escapeHtml(orderLink())}</code>
          </div>
          <button class="primary copy-btn" data-copy="${escapeHtml(orderLink())}" type="button">
            Copier
          </button>
        </div>

        <div class="link-row">
          <div>
            <strong>Lien comptoir</strong>
            <span>Gardez-le pour vous et votre équipe uniquement</span>
            <code>${escapeHtml(adminLink())}</code>
          </div>
          <button class="primary copy-btn" data-copy="${escapeHtml(adminLink())}" type="button">
            Copier
          </button>
        </div>

        ${
          !restaurant.is_active
            ? `
              <p class="onboarding-note">
                Votre espace est prêt à être configuré. Un dernier
                contrôle de notre équipe avant la mise en ligne
                publique (généralement sous 24h) — vous pouvez
                déjà tout préparer ci-dessous.
              </p>
            `
            : ''
        }
      </section>

      <section class="onboarding-section">
        <h2>Identité visuelle</h2>
        ${
          restaurant.plan === 'commerce'
            ? `<p class="muted">Logo et couleur personnalisés disponibles avec le palier Pro.</p>`
            : `
              <div class="identity-row">
                <div class="identity-logo-preview">
                  ${
                    restaurant.logo_url
                      ? `<img src="${escapeHtml(restaurant.logo_url)}" alt="">`
                      : `<span>${escapeHtml((restaurant.name || '?').slice(0, 2).toUpperCase())}</span>`
                  }
                </div>
                <label class="secondary" id="logo-upload-label">
                  ${restaurant.logo_url ? 'Changer le logo' : 'Ajouter un logo'}
                  <input type="file" id="logo-input" accept="image/jpeg,image/png,image/webp" hidden>
                </label>
              </div>
              <label class="color-picker-row">
                COULEUR PRINCIPALE
                <input type="color" id="color-input" value="${escapeHtml(restaurant.primary_color || '#e84d27')}">
              </label>
            `
        }
      </section>

      <section class="onboarding-section">
        <h2>Paiement en ligne (SumUp)</h2>
        ${
          restaurant.sumup_connected
            ? `<p class="muted">\u2713 Compte SumUp connecté${restaurant.sumup_merchant_code ? ` \u2014 ${escapeHtml(restaurant.sumup_merchant_code)}` : ''}. Les commandes payées en ligne seront encaissées directement sur votre compte SumUp, sans commission.</p>
               <button type="button" class="secondary" id="sumup-connect">Reconnecter SumUp</button>`
            : `<p class="muted">Connectez votre compte SumUp pour encaisser les commandes payées en ligne directement sur votre compte \u2014 sans commission, l'argent va chez vous.</p>
               <button type="button" class="secondary" id="sumup-connect">Connecter SumUp</button>`
        }
      </section>

      <section class="onboarding-section">
        <h2>Programme de fidélité</h2>
        ${
          restaurant.plan === 'commerce'
            ? `<p class="muted">Programme de fidélité disponible avec le palier Pro.</p>`
            : `
              <label class="account-toggle">
                <input type="checkbox" id="loyalty-active" ${loyaltyProgram?.is_active ? 'checked' : ''}>
                Activer le programme de fidélité
              </label>
              <div class="form-grid">
                <label>
                  NOM DU PROGRAMME
                  <input id="loyalty-name" value="${escapeHtml(loyaltyProgram?.name || 'Carte fidélité')}">
                </label>
                <label>
                  POINTS PAR EURO DÉPENSÉ
                  <input id="loyalty-rate" type="number" min="0.1" step="0.1" value="${loyaltyProgram?.points_per_euro || 1}">
                </label>
              </div>
              <button class="secondary full" id="save-loyalty-program" type="button">Enregistrer le programme</button>

              <p class="onboarding-hint">
                Les points sont attribués automatiquement quand une commande passe au statut "Prête" -
                aucune action supplémentaire nécessaire au comptoir.
              </p>

              <h3>Récompenses</h3>
              <div class="product-list">
                ${
                  loyaltyRewards.length
                    ? loyaltyRewards.map((r) => `
                        <div class="product-row">
                          <div class="product-row-main">
                            <strong>${escapeHtml(r.name)}</strong>
                            <span>${r.cost_points} points${r.description ? ' · ' + escapeHtml(r.description) : ''}</span>
                          </div>
                          <div class="product-row-actions">
                            <label class="account-toggle small">
                              <input type="checkbox" class="reward-active" data-id="${r.id}" ${r.is_active ? 'checked' : ''}>
                              Active
                            </label>
                            <button class="danger small" data-delete-reward="${r.id}" type="button">Supprimer</button>
                          </div>
                        </div>
                      `).join('')
                    : `<p class="muted">Aucune récompense pour le moment.</p>`
                }
              </div>

              <form id="reward-form" class="order-form">
                <label>
                  NOM DE LA RÉCOMPENSE
                  <input name="name" required placeholder="Ex: Boisson offerte">
                </label>
                <div class="form-grid">
                  <label>
                    COÛT EN POINTS
                    <input name="costPoints" type="number" min="1" required>
                  </label>
                  <label>
                    DESCRIPTION (facultatif)
                    <input name="description">
                  </label>
                </div>
                <button class="primary full" type="submit">Ajouter la récompense</button>
              </form>
            `
        }
      </section>

      <section class="onboarding-section">
        <h2>Horaires d'ouverture</h2>
        <form id="hours-form">
          ${DAYS.map(([key, label]) => {
            const ranges = openingHours[key] || [];
            const isOpen = ranges.length > 0;
            const r1 = ranges[0] || ['11:30', '14:00'];
            const r2 = ranges[1] || ['18:30', '22:00'];

            return `
              <div class="hours-row" data-day="${key}">
                <label class="account-toggle">
                  <input type="checkbox" class="day-open" ${isOpen ? 'checked' : ''}>
                  ${label}
                </label>
                <div class="hours-inputs" ${isOpen ? '' : 'style="display:none"'}>
                  <input type="time" class="r1-start" value="${r1[0]}">
                  <input type="time" class="r1-end" value="${r1[1]}">
                  <label class="account-toggle small">
                    <input type="checkbox" class="has-r2" ${ranges[1] ? 'checked' : ''}>
                    2e créneau
                  </label>
                  <div class="hours-inputs r2" ${ranges[1] ? '' : 'style="display:none"'}>
                    <input type="time" class="r2-start" value="${r2[0]}">
                    <input type="time" class="r2-end" value="${r2[1]}">
                  </div>
                </div>
              </div>
            `;
          }).join('')}
          <button class="primary" type="submit">Enregistrer les horaires</button>
          <span id="hours-saved" class="onboarding-saved hidden">Enregistré ✓</span>
        </form>
      </section>

      <section class="onboarding-section">
        <h2>Votre carte (${products.length})</h2>

        <div class="product-list">
          ${
            products.length
              ? products.map((p) => {
                  const hasPhoto = (p.product_images || []).length > 0;
                  return `
                    <div class="product-row">
                      <div class="product-row-main">
                        <strong>${escapeHtml(p.name)}</strong>
                        <span>${escapeHtml(p.category)} · ${(p.price_cents / 100).toFixed(2)} €</span>
                      </div>
                      <div class="product-row-actions">
                        ${
                          hasPhoto
                            ? `<span class="photo-ok">Photo ✓</span>`
                            : restaurant.plan === 'commerce'
                            ? `<span class="muted small-note">Photo (palier Pro)</span>`
                            : `
                              <label class="photo-upload-btn">
                                Ajouter une photo
                                <input type="file" accept="image/jpeg,image/png,image/webp" class="photo-input" data-product="${p.id}" hidden>
                              </label>
                            `
                        }
                        <label class="account-toggle small">
                          <input type="checkbox" class="product-active" data-id="${p.id}" ${p.is_active ? 'checked' : ''}>
                          Actif
                        </label>
                        <button class="danger small" data-delete="${p.id}" type="button">Supprimer</button>
                      </div>
                    </div>
                  `;
                }).join('')
              : `<p class="muted">Aucun produit pour le moment.</p>`
          }
        </div>

        <h3>Importer un menu (PDF ou photo)</h3>
        <p class="menu-import-hint">Envoyez la carte : l'IA la lit et pré-remplit vos produits. Vous vérifiez et corrigez avant l'ajout.</p>
        <input type="file" id="menu-import-file" accept="application/pdf,image/jpeg,image/png,image/webp">
        <span id="menu-import-status" class="onboarding-saved"></span>
        <div id="menu-import-review"></div>

        <h3>Ajouter un produit</h3>
        <form id="product-form" class="order-form">
          <label>
            NOM
            <input name="name" required>
          </label>
          <div class="form-grid">
            <label>
              CATÉGORIE
              <input name="category" placeholder="Ex: Burgers" required>
            </label>
            <label>
              PRIX (€)
              <input name="price" type="number" step="0.01" min="0" required>
            </label>
          </div>
          <label>
            DESCRIPTION (facultatif)
            <input name="description">
          </label>
          ${
            restaurant.plan === 'commerce'
              ? ''
              : `
                <label>
                  PHOTO (facultatif)
                  <input name="photo" type="file" accept="image/jpeg,image/png,image/webp">
                </label>
              `
          }
          <label class="account-toggle"><input type="checkbox" name="meat">Choix de viande</label>
          <label class="account-toggle"><input type="checkbox" name="sauce">Choix de sauce</label>
          <label class="account-toggle"><input type="checkbox" name="drink">Boisson incluse</label>
          <button class="primary full" type="submit">Ajouter le produit</button>
        </form>
      </section>
    </div>
  `;

  bindDashboardEvents();
}

function bindDashboardEvents() {
  document.querySelector('#signout-btn').onclick = async () => {
    await signOutOwner(supabase);
    restaurant = null;
    view = 'auth';
    authMode = 'login';
    render();
  };

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copié ✓';
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      });
    };
  });

  document.querySelectorAll('.hours-row').forEach((row) => {
    const dayOpen = row.querySelector('.day-open');
    const inputs = row.querySelector('.hours-inputs');
    const hasR2 = row.querySelector('.has-r2');
    const r2 = row.querySelector('.r2');

    dayOpen.onchange = () => {
      inputs.style.display = dayOpen.checked ? '' : 'none';
    };

    hasR2.onchange = () => {
      r2.style.display = hasR2.checked ? '' : 'none';
    };
  });

  document.querySelector('#hours-form').onsubmit = async (event) => {
    event.preventDefault();

    const newHours = {};

    document.querySelectorAll('.hours-row').forEach((row) => {
      const day = row.dataset.day;
      const isOpen = row.querySelector('.day-open').checked;

      if (!isOpen) {
        newHours[day] = [];
        return;
      }

      const ranges = [[
        row.querySelector('.r1-start').value,
        row.querySelector('.r1-end').value
      ]];

      if (row.querySelector('.has-r2').checked) {
        ranges.push([
          row.querySelector('.r2-start').value,
          row.querySelector('.r2-end').value
        ]);
      }

      newHours[day] = ranges;
    });

    try {
      await updateOpeningHours(supabase, restaurant.id, newHours);
      openingHours = newHours;
      const saved = document.querySelector('#hours-saved');
      saved.classList.remove('hidden');
      setTimeout(() => saved.classList.add('hidden'), 2000);
    } catch (err) {
      console.error('[FOODATOI onboarding]', err);
      alert('Impossible d’enregistrer les horaires pour le moment.');
    }
  };

  document.querySelectorAll('.product-active').forEach((input) => {
    input.onchange = async () => {
      try {
        await toggleProductActive(supabase, input.dataset.id, input.checked);
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        input.checked = !input.checked;
      }
    };
  });

  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Supprimer ce produit ?')) {
        return;
      }
      try {
        await deleteProduct(supabase, btn.dataset.delete);
        products = products.filter((p) => p.id !== btn.dataset.delete);
        render();
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible de supprimer ce produit pour le moment.');
      }
    };
  });

  const colorInput = document.querySelector('#color-input');
  if (colorInput) {
    colorInput.onchange = async (event) => {
      try {
        await updateRestaurantColor(supabase, restaurant.id, event.target.value);
        restaurant.primary_color = event.target.value;
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible d’enregistrer la couleur pour le moment.');
      }
    };
  }

  const logoInput = document.querySelector('#logo-input');
  if (logoInput) {
    logoInput.onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) {
        return;
      }

      const label = document.querySelector('#logo-upload-label');
      const originalText = label.firstChild.textContent;
      label.firstChild.textContent = 'Envoi…';

      try {
        const compressed = await compressImage(file, 'logo');
        restaurant.logo_url = await uploadRestaurantLogo(supabase, restaurant.id, compressed);
        render();
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible d’envoyer le logo pour le moment.');
        label.firstChild.textContent = originalText;
      }
    };
  }

  const sumupBtn = document.querySelector('#sumup-connect');
  if (sumupBtn) {
    sumupBtn.onclick = async () => {
      sumupBtn.disabled = true;
      try {
        const { data: state, error } = await supabase.rpc('sumup_begin_connect');
        if (error || !state) {
          throw error || new Error('no state');
        }
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: SUMUP_CLIENT_ID,
          redirect_uri: SUMUP_REDIRECT_URI,
          scope: SUMUP_SCOPES,
          state
        });
        window.location.href = `https://api.sumup.com/authorize?${params.toString()}`;
      } catch (err) {
        console.error('[FOODATOI onboarding] SumUp connect', err);
        alert('Impossible de démarrer la connexion SumUp pour le moment.');
        sumupBtn.disabled = false;
      }
    };
  }

  document.querySelectorAll('.photo-input').forEach((input) => {
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) {
        return;
      }

      const label = input.closest('.photo-upload-btn');
      label.textContent = 'Envoi…';

      try {
        const compressed = await compressImage(file, 'product');
        await uploadProductPhoto(supabase, restaurant.id, input.dataset.product, compressed);
        products = await getOwnProducts(supabase, restaurant.id);
        render();
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        logClientError(supabase, {
          restaurantId: restaurant?.id,
          context: 'onboarding.uploadProductPhoto',
          message: err?.message ?? String(err),
          page: 'onboarding'
        });
        alert('Impossible d’envoyer cette photo pour le moment.');
        label.textContent = 'Ajouter une photo';
      }
    };
  });

  setupMenuImport({
    supabase,
    restaurant,
    onImported: async () => {
      products = await getOwnProducts(supabase, restaurant.id);
      render();
    }
  });

  document.querySelector('#product-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    const photoFile = form.photo.files[0];

    try {
      const created = await addProduct(supabase, restaurant.id, fields);

      if (photoFile) {
        const compressed = await compressImage(photoFile, 'product');
        await uploadProductPhoto(supabase, restaurant.id, created.id, compressed);
      }

      products = await getOwnProducts(supabase, restaurant.id);
      render();
    } catch (err) {
      console.error('[FOODATOI onboarding]', err);
      logClientError(supabase, {
        restaurantId: restaurant?.id,
        context: 'onboarding.addProduct',
        message: err?.message ?? String(err),
        page: 'onboarding'
      });
      alert('Impossible d’ajouter ce produit pour le moment.');
    }
  };

  const saveLoyaltyButton = document.querySelector('#save-loyalty-program');
  if (saveLoyaltyButton) {
    saveLoyaltyButton.onclick = async () => {
      try {
        await upsertLoyaltyProgram(supabase, restaurant.id, {
          name: document.querySelector('#loyalty-name').value,
          isActive: document.querySelector('#loyalty-active').checked,
          pointsPerEuro: document.querySelector('#loyalty-rate').value
        });
        loyaltyProgram = await getLoyaltyProgram(supabase, restaurant.id);
        render();
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible d’enregistrer le programme pour le moment.');
      }
    };
  }

  const rewardForm = document.querySelector('#reward-form');
  if (rewardForm) {
    rewardForm.onsubmit = async (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));

      try {
        await addLoyaltyReward(supabase, restaurant.id, fields);
        loyaltyRewards = await getLoyaltyRewards(supabase, restaurant.id);
        render();
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible d’ajouter cette récompense pour le moment.');
      }
    };
  }

  document.querySelectorAll('.reward-active').forEach((toggle) => {
    toggle.onchange = async () => {
      try {
        await toggleLoyaltyReward(supabase, toggle.dataset.id, toggle.checked);
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible de mettre à jour cette récompense pour le moment.');
        toggle.checked = !toggle.checked;
      }
    };
  });

  document.querySelectorAll('[data-delete-reward]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await deleteLoyaltyReward(supabase, btn.dataset.deleteReward);
        loyaltyRewards = loyaltyRewards.filter((r) => r.id !== btn.dataset.deleteReward);
        render();
      } catch (err) {
        console.error('[FOODATOI onboarding]', err);
        alert('Impossible de supprimer cette récompense pour le moment.');
      }
    };
  });
}

init();
