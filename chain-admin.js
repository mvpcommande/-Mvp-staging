import './styles.css';
import { supabase } from './supabaseClient.js';
import { escapeHtml } from './htmlEscape.mjs';
import { signInOwner, signOutOwner } from './restaurantOwner.mjs';
import { getMyChain, getChainDashboard } from './chainAdmin.mjs';
import {
  logClientError,
  installGlobalErrorLogging
} from './errorLog.mjs';
installGlobalErrorLogging(supabase, {
  page: 'chain-admin',
  getRestaurantId: () => null
});


const root = document.querySelector('#chain-admin-root');

let view = 'loading';
let error = '';
let chain = null;
let restaurants = [];

function euro(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

function render() {
  if (view === 'loading') {
    root.innerHTML = `<div class="onboarding-shell"><p class="eyebrow">FOODATOI</p><h1>Chargement…</h1></div>`;
    return;
  }

  if (view === 'auth') {
    renderAuth();
    return;
  }

  if (view === 'no-chain') {
    root.innerHTML = `
      <div class="onboarding-shell narrow">
        <p class="eyebrow">FOODATOI · CHAÎNE</p>
        <h1>Aucune chaîne associée à ce compte.</h1>
        <p class="onboarding-lede">
          Ce compte n'est pas rattaché à une chaîne de restaurants.
          Contactez FOODATOI si vous pensez qu'il s'agit d'une erreur.
        </p>
        <button class="secondary full" id="logout" type="button">Se déconnecter</button>
      </div>
    `;
    document.querySelector('#logout').onclick = async () => {
      await signOutOwner(supabase);
      view = 'auth';
      render();
    };
    return;
  }

  renderDashboard();
}

function renderAuth() {
  root.innerHTML = `
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · ESPACE CHAÎNE</p>
      <h1>Tableau de bord chaîne</h1>
      <p class="onboarding-lede">
        Suivez vos établissements en un coup d'œil. Cet espace est
        réservé aux comptes chaîne créés par FOODATOI.
      </p>

      ${error ? `<p class="onboarding-error">${escapeHtml(error)}</p>` : ''}

      <form id="auth-form" class="order-form">
        <label>
          EMAIL
          <input name="email" type="email" required autocomplete="email">
        </label>
        <label>
          MOT DE PASSE
          <input name="password" type="password" required minlength="6" autocomplete="current-password">
        </label>
        <button class="primary full" type="submit">Se connecter →</button>
      </form>
    </div>
  `;

  document.querySelector('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));

    error = '';
    view = 'loading';
    render();

    try {
      await signInOwner(supabase, fields);
      await loadChainState();
    } catch (err) {
      console.error('[FOODATOI chain-admin]', err);
      view = 'auth';
      error = String(err?.message || '').includes('Invalid login credentials')
        ? 'Email ou mot de passe incorrect.'
        : 'Impossible de se connecter pour le moment.';
      render();
    }
  };
}

function renderDashboard() {
  const totalOrders = restaurants.reduce((sum, r) => sum + r.orders_today, 0);
  const totalRevenue = restaurants.reduce((sum, r) => sum + r.revenue_today_cents, 0);

  root.innerHTML = `
    <div class="onboarding-shell">
      <p class="eyebrow">FOODATOI · CHAÎNE</p>
      <h1>${escapeHtml(chain.name)}</h1>
      <p class="onboarding-lede">
        ${restaurants.length} établissement${restaurants.length > 1 ? 's' : ''} ·
        ${totalOrders} commande${totalOrders > 1 ? 's' : ''} aujourd'hui ·
        ${euro(totalRevenue)} de chiffre d'affaires du jour
      </p>

      <div class="product-list">
        ${
          restaurants.length
            ? restaurants.map((r) => `
                <a class="product-row chain-site-row" href="/admin.html?resto=${encodeURIComponent(r.slug)}">
                  <div class="product-row-main">
                    <strong>${escapeHtml(r.name)}</strong>
                    <span>
                      ${r.is_active ? 'Actif' : 'Inactif'} ·
                      ${r.orders_today} commande${r.orders_today > 1 ? 's' : ''} aujourd'hui ·
                      ${euro(r.revenue_today_cents)}
                    </span>
                  </div>
                </a>
              `).join('')
            : `<p class="muted">Aucun établissement rattaché à cette chaîne pour le moment.</p>`
        }
      </div>

      <button class="secondary full" id="logout" type="button">Se déconnecter</button>
    </div>
  `;

  document.querySelector('#logout').onclick = async () => {
    await signOutOwner(supabase);
    view = 'auth';
    chain = null;
    restaurants = [];
    render();
  };
}

async function loadChainState() {
  chain = await getMyChain(supabase);

  if (!chain) {
    view = 'no-chain';
    render();
    return;
  }

  restaurants = await getChainDashboard(supabase, chain.id);
  view = 'dashboard';
  render();
}

async function bootstrap() {
  try {
    const {
      data: { user }
    } = await supabase.auth.getUser();

    if (!user) {
      view = 'auth';
      render();
      return;
    }

    await loadChainState();
  } catch (err) {
    console.error('[FOODATOI chain-admin]', err);
    logClientError(supabase, {
      restaurantId: null,
      context: 'chain-admin.bootstrap',
      message: err?.message ?? String(err),
      page: 'chain-admin'
    });
    view = 'auth';
    error = 'Impossible de charger le tableau de bord pour le moment.';
    render();
  }
}

bootstrap();
