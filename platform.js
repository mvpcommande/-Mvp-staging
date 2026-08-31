import './styles.css';
import { supabase } from './supabaseClient.js';
import { escapeHtml } from './htmlEscape.mjs';
import { signInOwner, signOutOwner } from './restaurantOwner.mjs';

const root = document.querySelector('#platform-root');

let view = 'loading';
let error = '';
let pending = [];

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

  await loadPending();
}

async function loadPending() {
  view = 'loading';
  render();

  const { data, error: fetchError } = await supabase
    .from('restaurants')
    .select('*')
    .eq('is_active', false)
    .order('created_at', { ascending: true });

  if (fetchError) {
    console.error('[FOODATOI platform]', fetchError);
    view = 'auth';
    error = 'Accès refusé ou session expirée. Reconnectez-vous avec le compte plateforme.';
    render();
    return;
  }

  pending = data ?? [];
  view = 'dashboard';
  render();
}

function render() {
  if (view === 'loading') {
    root.innerHTML = `<div class="onboarding-shell"><p class="eyebrow">FOODATOI · PLATEFORME</p><h1>Chargement…</h1></div>`;
    return;
  }

  if (view === 'error') {
    root.innerHTML = `<div class="onboarding-shell"><p class="eyebrow">FOODATOI</p><h1>Erreur</h1><p>${escapeHtml(error)}</p></div>`;
    return;
  }

  if (view === 'auth') {
    renderAuth();
    return;
  }

  renderDashboard();
}

function renderAuth() {
  root.innerHTML = `
    <div class="onboarding-shell narrow">
      <p class="eyebrow">FOODATOI · PLATEFORME</p>
      <h1>Connexion</h1>
      ${error ? `<p class="onboarding-error">${escapeHtml(error)}</p>` : ''}
      <form id="login-form" class="order-form">
        <label>EMAIL<input name="email" type="email" required autocomplete="email"></label>
        <label>MOT DE PASSE<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary full" type="submit">Se connecter →</button>
      </form>
    </div>
  `;

  document.querySelector('#login-form').onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    error = '';
    view = 'loading';
    render();

    try {
      await signInOwner(supabase, fields);
      await loadPending();
    } catch (err) {
      console.error('[FOODATOI platform]', err);
      view = 'auth';
      error = 'Email ou mot de passe incorrect.';
      render();
    }
  };
}

function renderDashboard() {
  root.innerHTML = `
    <div class="onboarding-shell">
      <div class="onboarding-header">
        <div>
          <p class="eyebrow">FOODATOI · PLATEFORME</p>
          <h1>Restaurants en attente.</h1>
        </div>
        <button class="secondary" id="signout-btn" type="button">Se déconnecter</button>
      </div>

      ${
        pending.length
          ? `<div class="product-list">
              ${pending.map((r) => `
                <div class="pending-row">
                  <div>
                    <strong>${escapeHtml(r.name)}</strong>
                    <span>${escapeHtml(r.sector || '—')} · /?resto=${escapeHtml(r.slug)}</span>
                    <span>${escapeHtml(r.phone || 'Pas de téléphone renseigné')}</span>
                    <span>Créé le ${new Date(r.created_at).toLocaleDateString('fr-FR')}</span>
                  </div>
                  <div class="pending-actions">
                    <button class="primary" data-activate="${r.id}" type="button">Activer</button>
                    <button class="danger small" data-reject="${r.id}" type="button">Rejeter</button>
                  </div>
                </div>
              `).join('')}
            </div>`
          : `<p class="muted">Aucun restaurant en attente pour le moment.</p>`
      }
    </div>
  `;

  document.querySelector('#signout-btn').onclick = async () => {
    await signOutOwner(supabase);
    view = 'auth';
    render();
  };

  document.querySelectorAll('[data-activate]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      const { error: updateError } = await supabase
        .from('restaurants')
        .update({ is_active: true, onboarding_status: 'READY' })
        .eq('id', btn.dataset.activate);

      if (updateError) {
        console.error('[FOODATOI platform]', updateError);
        alert('Impossible d’activer ce restaurant pour le moment.');
        btn.disabled = false;
        return;
      }

      pending = pending.filter((r) => r.id !== btn.dataset.activate);
      render();
    };
  });

  document.querySelectorAll('[data-reject]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Supprimer définitivement ce restaurant en attente ?')) {
        return;
      }

      const { error: deleteError } = await supabase
        .from('restaurants')
        .delete()
        .eq('id', btn.dataset.reject);

      if (deleteError) {
        console.error('[FOODATOI platform]', deleteError);
        alert('Impossible de supprimer ce restaurant pour le moment.');
        return;
      }

      pending = pending.filter((r) => r.id !== btn.dataset.reject);
      render();
    };
  });
}

init();
