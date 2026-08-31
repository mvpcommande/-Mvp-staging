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
import { logClientError } from './errorLog.mjs';

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
let openingHours = {};
let products = [];

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
          <label>
            PHOTO (facultatif)
            <input name="photo" type="file" accept="image/jpeg,image/png,image/webp">
          </label>
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

  document.querySelector('#color-input').onchange = async (event) => {
    try {
      await updateRestaurantColor(supabase, restaurant.id, event.target.value);
      restaurant.primary_color = event.target.value;
    } catch (err) {
      console.error('[FOODATOI onboarding]', err);
      alert('Impossible d’enregistrer la couleur pour le moment.');
    }
  };

  document.querySelector('#logo-input').onchange = async (event) => {
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
}

init();
