import { updateOrderStatus } from './orderStore.mjs';
import { createSupabaseOrderStore } from './supabaseStore.mjs';
import { supabase } from './supabaseClient.js';
import { getNextStatusLabel } from './uiModel.mjs';
import { getAdminSession, signInAdmin, signOutAdmin } from './adminAuth.mjs';
import {
  printOrder,
  subscribeToOrderChanges,
  aggregateOrderItems,
  buildStockSummaryCsv,
  printStockSummary,
  calculateUberEatsSavings,
  filterOrdersByDateRange,
  buildAccountingCsv
} from './adminFeatures.mjs';
import { resolveRestaurant } from './restaurantResolver.mjs';
import { formatPickupTime } from './timeFormat.mjs';
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import WebUSBReceiptPrinter from '@point-of-sale/webusb-receipt-printer';
import {
  isThermalPrinterSupported,
  buildReceiptBytes,
  createThermalPrinterController
} from './thermalPrinter.mjs';
import {
  logClientError,
  installGlobalErrorLogging
} from './errorLog.mjs';
import { escapeHtml } from './htmlEscape.mjs';
import { createRealtimeConnectionManager } from './realtimeResilience.mjs';
import './styles.css';
const root = document.querySelector('#admin-root');

/*
 * Imprimante thermique réelle : uniquement là où WebUSB existe
 * (Chrome/Edge). Sur Safari/iOS, isThermalPrinterSupported() est
 * false, le bouton reste caché, et printOrderSmart() retombe sur le
 * dialogue navigateur existant sans que rien d'autre ne change.
 */
const thermalPrinter = isThermalPrinterSupported()
  ? createThermalPrinterController(WebUSBReceiptPrinter)
  : null;

if (thermalPrinter) {
  thermalPrinter.tryAutoReconnect();
}

function printOrderSmart(order, restaurantName) {
  if (thermalPrinter?.isConnected()) {
    try {
      const bytes = buildReceiptBytes(order, ReceiptPrinterEncoder, {
        restaurantName,
        language: thermalPrinter.getDeviceInfo()?.language || 'esc-pos',
        codepageMapping: thermalPrinter.getDeviceInfo()?.codepageMapping
      });
      thermalPrinter.printBytes(bytes);
      return;
    } catch (err) {
      console.error('[FOODATOI admin] Échec impression thermique, repli navigateur:', err);
    }
  }
  printOrder(order, undefined, restaurantName);
}

const labels = {
  NEW: 'Nouvelle',
  ACCEPTED: 'Acceptée',
  PREPARING: 'En préparation',
  READY: 'Prête',
  CANCELLED: 'Annulée'
};
const deliveryLabels = {
  TO_DELIVER: 'À livrer',
  DELIVERED: 'Livrée'
};
let remote = null;
let mode = 'local';
let session = null;
let restaurant = null;

/*
 * Bloc 5.4 : le canal Realtime n'est plus créé/reconnecté "à la main"
 * ici. realtimeResilience.mjs porte l'invariant "au plus un channel
 * actif, au plus une reconnexion planifiée à la fois" (généralisé par
 * un compteur de génération), le backoff borné, le polling de secours
 * et la reprise Safari/iOS -- ce fichier ne garde que le câblage vers
 * le vrai client Supabase et le rendu.
 *
 * Instance unique créée au chargement du module : ses callbacks
 * relisent `session`/`restaurant`/`mode` à chaque appel (fermetures sur
 * ces `let` mutables), donc un seul gestionnaire suffit pour tout le
 * cycle de vie connexion/déconnexion/reconnexion du comptoir.
 */
const realtimeManager = createRealtimeConnectionManager({
  subscribe: (onMessage, onStatusChange) =>
    subscribeToOrderChanges(supabase, onMessage, onStatusChange),
  unsubscribe: async (channel) => {
    if (supabase) {
      await supabase.removeChannel(channel);
    }
  },
  setAuth: async () => {
    if (supabase && session?.access_token) {
      await supabase.realtime.setAuth(session.access_token);
    }
  },
  onMessage: (payload) => {
    if (payload?.eventType === 'INSERT') {
      showNewOrderToast();
    }
    render();
  },
  onStatusChange: (status) => {
    updateConnectionBadge();
    if (status === 'reconnecting') {
      logRealtimeDrop();
    }
  },
  onPoll: () => render(),
  isActive: () => mode === 'remote'
});

/*
 * Anti-flood dédié aux logs "admin.realtime" : ceux-ci passent par un
 * appel direct à logClientError() (pas par le filet console.error /
 * window.onerror de errorLog.mjs, qui a son propre dédoublonnage 10s),
 * car ils portent un contexte/restaurantId précis. Sans ça, une rafale de CLOSED (même
 * dédupliquée côté connexion par realtimeResilience.mjs) continuerait
 * de produire une ligne par transition d'état -- observé en prod
 * (38 entrées "admin.realtime" pour un seul épisode d'instabilité).
 */
let lastRealtimeLogAt = 0;
let realtimeLogSuppressedCount = 0;
const REALTIME_LOG_DEDUPE_MS = 15000;

function logRealtimeDrop() {
  const now = Date.now();
  if (now - lastRealtimeLogAt < REALTIME_LOG_DEDUPE_MS) {
    realtimeLogSuppressedCount += 1;
    return;
  }
  lastRealtimeLogAt = now;
  const suppressed = realtimeLogSuppressedCount;
  realtimeLogSuppressedCount = 0;
  logClientError(supabase, {
    restaurantId: restaurant?.id,
    context: 'admin.realtime',
    message:
      'Canal realtime perdu, reconnexion programmée' +
      (suppressed > 0
        ? ` (+${suppressed} occurrence(s) similaire(s) supprimée(s) dans les 15s précédentes)`
        : ''),
    page: 'admin'
  });
}

/*
 * Onglet actif sur mobile (<768px), où les 4 colonnes ne peuvent pas
 * être visibles simultanément. Conservé en dehors de render() pour
 * survivre à un re-render déclenché par un événement Realtime pendant
 * que le comptoir consulte un autre onglet.
 */
let activeMobileTab = 'NEW';

let toastTimeout = null;
let ageTickerHandle = null;

/*
 * Verrous anti double-clic : id de commande en cours de mise à jour,
 * indépendants de l'attribut `disabled` du bouton (qui est reconstruit
 * à chaque render()).
 */
const pendingStatusChanges = new Set();
const pendingDeliveryChanges = new Set();

/*
 * Les 4 statuts réellement actionnables par le comptoir (voir
 * orderWorkflow.mjs). CANCELLED existe côté base (cf. policy RLS)
 * mais n'a aucune transition cliquable ici — les commandes dans cet
 * état restent visibles à part, jamais mélangées à ces 4 statuts ni
 * masquées.
 */
const ACTIVE_STATUSES = ['NEW', 'ACCEPTED', 'PREPARING', 'READY'];
const COLUMN_LABELS = {
  NEW: 'Nouvelles',
  ACCEPTED: 'Acceptées',
  PREPARING: 'Préparation',
  READY: 'Prêtes'
};

installGlobalErrorLogging(supabase, {
  page: 'admin',
  getRestaurantId: () => restaurant?.id ?? null
});

/*
 * Bloc 5.4 : reprise déterministe au retour au premier plan et sur les
 * transitions réseau du navigateur. Safari/iOS suspend agressivement
 * les timers et peut geler un WebSocket sans jamais délivrer son
 * événement de fermeture tant que l'onglet reste en arrière-plan --
 * d'où la rafale de CLOSED observée en prod, tous horodatés au moment
 * du retour au premier plan plutôt qu'au moment réel de la coupure.
 *
 * `render()` est appelé ici indépendamment de realtimeManager : même si
 * le channel semble sain (SUBSCRIBED jamais retombé), on revérifie
 * quand même la liste des commandes, au cas où l'événement aurait été
 * perdu silencieusement pendant la suspension.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mode === 'remote') {
      render();
      realtimeManager.healthCheck();
    }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', () => {
    if (mode === 'remote') {
      render();
      realtimeManager.healthCheck();
    }
  });
  window.addEventListener('online', () => {
    if (mode === 'remote') {
      render();
      realtimeManager.handleOnline();
    }
  });
  window.addEventListener('offline', () => {
    realtimeManager.handleOffline();
  });
}

function localOrders() {
  return JSON.parse(
    localStorage.getItem('caz-food-orders') || '[]'
  );
}
function saveLocal(value) {
  localStorage.setItem(
    'caz-food-orders',
    JSON.stringify(value)
  );
}
function euro(value) {
  return `${Number(value).toFixed(2).replace('.', ',')} €`;
}
async function init() {
  if (!supabase) {
    renderSetup();
    return;
  }
  try {
    session = await getAdminSession(supabase);
  } catch (error) {
    console.error(
      'Erreur récupération session:',
      error
    );
    renderLogin();
    return;
  }
  if (session) {
    try {
      restaurant = await resolveRestaurant(supabase);
    } catch (error) {
      console.error(
        'Erreur résolution restaurant:',
        error
      );
      logClientError(supabase, {
        context: 'admin.resolveRestaurant',
        message: error?.message ?? String(error),
        page: 'admin'
      });
      renderRestaurantError(error);
      return;
    }
    remote = createSupabaseOrderStore(supabase, restaurant.id);
    mode = 'remote';
    realtimeManager.start();
    await render();
    return;
  }
  renderLogin();
}

/**
 * Source unique de vérité pour l'état de connexion affiché : le
 * badge du header et la note en bas de page doivent toujours
 * raconter la même chose, donc un seul mapping état -> libellés,
 * jamais deux (c'était le bug : le footer testait `mode === 'remote'`
 * indépendamment du badge, et disait "Temps réel actif" même en
 * 'connecting'/'reconnecting').
 */
const CONNECTION_STATES = {
  live: {
    badge: 'En direct',
    badgeClass: 'is-live',
    footnote: 'Temps réel actif. Les nouvelles commandes apparaissent automatiquement.'
  },
  connecting: {
    badge: 'Connexion…',
    badgeClass: 'is-connecting',
    footnote: 'Connexion au temps réel en cours…'
  },
  reconnecting: {
    badge: 'Reconnexion…',
    badgeClass: 'is-reconnecting',
    footnote: 'Connexion perdue, reconnexion en cours (commandes toujours à jour par vérification périodique).'
  },
  offline: {
    badge: 'Hors ligne',
    badgeClass: 'is-offline',
    footnote: 'Aucune connexion réseau. Reprise automatique dès que la connexion revient.'
  },
  local: {
    badge: 'Mode démo local',
    badgeClass: 'is-local',
    footnote: 'Mode démo local.'
  }
};

function getConnectionState() {
  return mode !== 'remote' ? 'local' : realtimeManager.getStatus();
}

/**
 * Reflète l'état de connexion (badge + note du footer) sans passer
 * par un render() complet (cet état change indépendamment de la
 * liste des commandes). Best-effort : si un élément n'est pas encore
 * dans le DOM (avant le premier render), ce patch-là est ignoré.
 */
function updateConnectionBadge() {
  const config =
    CONNECTION_STATES[getConnectionState()] ??
    CONNECTION_STATES.connecting;

  const badgeEl = document.querySelector('#counter-live-badge');
  if (badgeEl) {
    badgeEl.textContent = config.badge;
    badgeEl.className = `oi-counter-live ${config.badgeClass}`;
  }

  const footnoteEl = document.querySelector('#counter-footnote-text');
  if (footnoteEl) {
    footnoteEl.textContent = config.footnote;
  }
}

/**
 * Notification discrète (pas de son : aucun mécanisme sonore
 * n'existait avant ce bloc, on n'en ajoute pas ici) affichée à la
 * réception d'un événement INSERT réel via Realtime. Attachée à
 * document.body (comme les autres overlays de ce fichier) pour
 * survivre au réarment complet de #admin-root par render().
 */
function showNewOrderToast() {
  let el = document.querySelector('#counter-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'counter-toast';
    el.className = 'oi-counter-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = 'Nouvelle commande reçue';
  el.classList.remove('is-visible');
  void el.offsetWidth;
  el.classList.add('is-visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 4000);
}
function renderSetup() {
  root.innerHTML = `
    <main class="admin-auth">
      <div class="auth-card">
        <div class="auth-mark">
          F
        </div>
        <p class="eyebrow">
          FOODATOI · CONFIGURATION
        </p>
        <h1>
          Le comptoir<br>
          <em>arrive bientôt.</em>
        </h1>
        <p>
          La configuration du compte commerçant n'est pas encore terminée.
        </p>
      </div>
    </main>
  `;
}
function renderRestaurantError(error) {
  root.innerHTML = `
    <main class="admin-auth">
      <div class="auth-card">
        <div class="auth-mark">
          F
        </div>
        <p class="eyebrow">
          FOODATOI · LE COMPTOIR
        </p>
        <h1>
          Restaurant introuvable.
        </h1>
        <p>
          ${
            (error?.message || 'Impossible de résoudre ce restaurant FOODATOI.')
          }
        </p>
        <button
          class="primary full"
          type="button"
          id="retry-restaurant"
        >
          RÉESSAYER →
        </button>
        <a
          class="secondary auth-back"
          href="/"
        >
          ← Retour à la commande
        </a>
      </div>
    </main>
  `;
  root.querySelector('#retry-restaurant').onclick = () => init();
}
function renderLogin(error = '') {
  root.innerHTML = `
    <main class="admin-auth">
      <div class="auth-card">
        <div class="auth-mark">
          F
        </div>
        <p class="eyebrow">
          FOODATOI · LE COMPTOIR
        </p>
        <h1>
          Bon retour.
        </h1>
        <p>
          Connexion réservée à l'équipe du restaurant.
        </p>
        ${
          error
            ? `
              <div class="auth-error">
                ${error}
              </div>
            `
            : ''
        }
        <form
          id="login-form"
          class="auth-form"
        >
          <label>
            EMAIL
            <input
              name="email"
              type="email"
              autocomplete="username"
              required
              placeholder="vous@cazfood.fr"
            >
          </label>
          <label>
            MOT DE PASSE
            <input
              name="password"
              type="password"
              autocomplete="current-password"
              required
              placeholder="••••••••"
            >
          </label>
          <button
            class="primary full"
            type="submit"
          >
            OUVRIR LE COMPTOIR →
          </button>
        </form>
        <a
          class="secondary auth-back"
          href="/"
        >
          ← Retour à la commande
        </a>
      </div>
    </main>
  `;
  const form =
    root.querySelector(
      '#login-form'
    );
  form.onsubmit =
    async event => {
      event.preventDefault();
      const formData =
        new FormData(
          event.currentTarget
        );
      const button =
        event.currentTarget.querySelector(
          'button'
        );
      button.disabled = true;
      button.textContent =
        'CONNEXION…';
      try {
        session =
          await signInAdmin(
            supabase,
            formData.get('email'),
            formData.get('password')
          );
      } catch (error) {
        console.error(
          'Erreur connexion admin:',
          error
        );
        renderLogin(
          'Email ou mot de passe incorrect.'
        );
        return;
      }
      try {
        restaurant =
          await resolveRestaurant(
            supabase
          );
        remote =
          createSupabaseOrderStore(
            supabase,
            restaurant.id
          );
        mode = 'remote';
        realtimeManager.start();
        await render();
      } catch (error) {
        console.error(
          'Erreur résolution restaurant:',
          error
        );
        renderRestaurantError(error);
      }
    };
}
async function getOrders() {
  if (mode === 'remote') {
    try {
      return await remote.listOrders();
    } catch (error) {
      console.error(
        'Erreur récupération commandes:',
        error
      );
      return [];
    }
  }
  return localOrders();
}
async function advance(order, button) {
  const next = {
    NEW: 'ACCEPTED',
    ACCEPTED: 'PREPARING',
    PREPARING: 'READY'
  }[order.status];
  if (
    !next ||
    pendingStatusChanges.has(order.id)
  ) {
    return;
  }
  pendingStatusChanges.add(order.id);
  const originalLabel = button?.innerHTML ?? '';
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Mise à jour…';
  }
  try {
    if (mode === 'remote') {
      await remote.updateStatus(
        order.id,
        next
      );
    } else {
      saveLocal(
        updateOrderStatus(
          localOrders(),
          order.id,
          next
        )
      );
    }
    pendingStatusChanges.delete(order.id);
    await render();
  } catch (error) {
    pendingStatusChanges.delete(order.id);
    console.error(
      'Erreur changement statut:',
      error
    );
    logClientError(supabase, {
      restaurantId: restaurant?.id,
      context: 'admin.updateStatus',
      message: error?.message ?? String(error),
      details: {
        orderId: order.id,
        from: order.status,
        to: next
      },
      page: 'admin'
    });
    alert(
      'Impossible de modifier le statut de la commande.'
    );
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
    }
  }
}
async function toggleDelivery(order, button) {
  if (
    mode !== 'remote' ||
    pendingDeliveryChanges.has(order.id)
  ) {
    return;
  }
  const next =
    order.delivery_status === 'TO_DELIVER'
      ? 'DELIVERED'
      : 'TO_DELIVER';
  pendingDeliveryChanges.add(order.id);
  const originalLabel = button?.innerHTML ?? '';
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Mise à jour…';
  }
  try {
    await remote.updateDeliveryStatus(
      order.id,
      next
    );
    pendingDeliveryChanges.delete(order.id);
    await render();
  } catch (error) {
    pendingDeliveryChanges.delete(order.id);
    console.error(
      'Erreur changement statut livraison:',
      error
    );
    logClientError(supabase, {
      restaurantId: restaurant?.id,
      context: 'admin.updateDeliveryStatus',
      message: error?.message ?? String(error),
      details: {
        orderId: order.id,
        from: order.delivery_status,
        to: next
      },
      page: 'admin'
    });
    alert(
      'Impossible de modifier le statut de livraison.'
    );
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
    }
  }
}

/**
 * "À l'instant" / "Il y a N min" / "Il y a N h" à partir de
 * created_at (jamais stocké, recalculé côté client). Fonction pure
 * pour rester testable, `now` en paramètre plutôt que Date.now() en
 * dur.
 */
function formatOrderAge(createdAt, now = new Date()) {
  if (!createdAt) {
    return '';
  }
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return '';
  }
  const diffMinutes = Math.max(
    0,
    Math.round((now.getTime() - created.getTime()) / 60000)
  );
  if (diffMinutes < 1) {
    return "À l'instant";
  }
  if (diffMinutes < 60) {
    return `Il y a ${diffMinutes} min`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  return `Il y a ${diffHours} h`;
}

/**
 * Rafraîchit uniquement le texte des pastilles d'ancienneté déjà
 * dans le DOM, sans re-render()/re-fetch : évite de rappeler
 * getOrders() (Supabase) toutes les 30s juste pour un texte relatif.
 * Démarré une seule fois (voir render()).
 */
function tickOrderAges() {
  document
    .querySelectorAll('.oi-counter-age[data-created-at]')
    .forEach((el) => {
      el.textContent = formatOrderAge(el.dataset.createdAt);
    });
}
function ensureAgeTicker() {
  if (ageTickerHandle) {
    return;
  }
  ageTickerHandle = setInterval(tickOrderAges, 30000);
}

/**
 * Options d'un article de commande, jointes en une seule ligne
 * lisible ("Poulet · Algérienne"), jamais en JSON brut. Partagée par
 * orderCard() et renderOrderDetail() (auparavant dupliquée en ligne
 * dans renderOrderDetail() uniquement) — même champs lus, aucune
 * option métier perdue.
 */
function formatOrderItemOptions(item) {
  return [
    item.options?.meat,
    item.options?.sauce,
    item.options?.drink,
    ...(Array.isArray(item.options?.groups)
      ? item.options.groups.map((g) =>
          g && g.label && g.choice ? `${g.label}: ${g.choice}` : null
        )
      : [])
  ]
    .filter(Boolean)
    .join(' · ');
}
async function render() {
  if (
    !session &&
    mode === 'remote'
  ) {
    renderLogin();
    return;
  }
  const data =
    (await getOrders())
      .slice()
      .sort(
        (a, b) =>
          new Date(
            b.created_at ??
            b.createdAt
          ) -
          new Date(
            a.created_at ??
            a.createdAt
          )
      );
  /*
   * Regroupement par statut réel (voir orderWorkflow.mjs) : les 4
   * statuts actionnables forment le tableau de service principal ;
   * tout le reste (CANCELLED aujourd'hui, ou un statut futur non
   * géré côté client) reste visible mais à part, jamais mélangé ni
   * masqué.
   */
  const grouped = {
    NEW: [],
    ACCEPTED: [],
    PREPARING: [],
    READY: []
  };
  const other = [];

  data.forEach((order) => {
    if (ACTIVE_STATUSES.includes(order.status)) {
      grouped[order.status].push(order);
    } else {
      other.push(order);
    }
  });

  const hasActiveOrders = ACTIVE_STATUSES.some(
    (status) => grouped[status].length > 0
  );

  const savings = calculateUberEatsSavings(
    data,
    restaurant?.settings?.uber_eats_commission_rate
  );

  root.innerHTML = `
    <main class="admin-shell oi-counter-shell">
      <header class="oi-counter-header">
        <div class="oi-counter-identity">
          <span class="oi-counter-eyebrow">FOODATOI</span>
          <strong class="oi-counter-name">${escapeHtml(restaurant?.name || 'Restaurant')}</strong>
        </div>
        <div class="oi-counter-status">
          <span class="oi-counter-role">Comptoir</span>
          <span id="counter-live-badge" class="oi-counter-live"></span>
        </div>
        <div class="admin-actions oi-counter-tools">
          <button
            class="secondary"
            id="system-health"
          >
            État système
          </button>
          <button
            class="secondary"
            id="export-stock"
          >
            Exporter (CSV)
          </button>
          <button
            class="secondary"
            id="export-accounting"
          >
            Export comptable
          </button>
          <button
            class="secondary"
            id="connect-printer"
            hidden
          >
            Connecter l'imprimante
          </button>
          <button
            class="secondary"
            id="print-stock"
          >
            Imprimer le résumé
          </button>
          <button
            class="secondary"
            id="logout"
          >
            Quitter
          </button>
          <a
            class="secondary"
            href="/"
          >
            ← Voir la commande
          </a>
        </div>
      </header>

      ${
        savings && savings.orderCount
          ? `
            <section class="roi-banner oi-counter-roi">
              <p class="eyebrow">
                VOTRE ÉCONOMIE FOODATOI
              </p>
              <p>
                ${savings.orderCount}
                commande${savings.orderCount > 1 ? 's' : ''}
                prise${savings.orderCount > 1 ? 's' : ''} en direct.
                Au tarif Uber Eats vente à emporter (6 %),
                ça aurait coûté environ
                <strong>${euro(savings.savingsCents / 100)}</strong>
                de commission. Avec FOODATOI, cette marge reste
                intégralement chez vous.
              </p>
            </section>
          `
          : ''
      }

      ${
        hasActiveOrders
          ? `
            <nav class="oi-counter-tabs" role="tablist" aria-label="Filtrer par état">
              ${ACTIVE_STATUSES.map(
                (status) => `
                  <button
                    type="button"
                    role="tab"
                    class="oi-counter-tab${activeMobileTab === status ? ' is-active' : ''}"
                    aria-selected="${activeMobileTab === status}"
                    data-tab="${status}"
                  >
                    ${COLUMN_LABELS[status]}
                    <span class="oi-counter-tab-count">${grouped[status].length}</span>
                  </button>
                `
              ).join('')}
            </nav>

            <section class="oi-counter-board" data-active="${activeMobileTab}">
              ${ACTIVE_STATUSES.map(
                (status) => `
                  <div class="oi-counter-column" data-status="${status}">
                    <h2 class="oi-counter-column-head">
                      ${COLUMN_LABELS[status]}
                      <span class="oi-counter-count">${grouped[status].length}</span>
                    </h2>
                    <div class="oi-counter-cards">
                      ${
                        grouped[status].length
                          ? grouped[status].map(orderCard).join('')
                          : `<p class="oi-counter-column-empty">Aucune commande.</p>`
                      }
                    </div>
                  </div>
                `
              ).join('')}
            </section>
          `
          : `
            <div class="empty-ticket admin-empty oi-counter-empty">
              <div class="empty-ticket-mark">
                +
              </div>
              <h2>
                Aucune commande en attente
              </h2>
              <p>
                Les nouvelles commandes apparaîtront ici automatiquement.
              </p>
            </div>
          `
      }

      ${
        other.length
          ? `
            <details class="oi-counter-archive">
              <summary>Autres commandes (${other.length})</summary>
              <div class="oi-counter-cards">
                ${other.map(orderCard).join('')}
              </div>
            </details>
          `
          : ''
      }

      <p class="admin-note oi-counter-footnote">
        ●
        <span id="counter-footnote-text"></span>
      </p>
    </main>
  `;
  updateConnectionBadge();
  ensureAgeTicker();
  root
    .querySelectorAll(
      '[data-tab]'
    )
    .forEach(tabButton => {
      tabButton.onclick =
        () => {
          activeMobileTab =
            tabButton.dataset.tab;
          const board =
            root.querySelector(
              '.oi-counter-board'
            );
          if (board) {
            board.dataset.active =
              activeMobileTab;
          }
          root
            .querySelectorAll(
              '[data-tab]'
            )
            .forEach(otherTab => {
              const isActive =
                otherTab.dataset.tab ===
                activeMobileTab;
              otherTab.classList.toggle(
                'is-active',
                isActive
              );
              otherTab.setAttribute(
                'aria-selected',
                String(isActive)
              );
            });
        };
    });
  const logout =
    root.querySelector(
      '#logout'
    );
  if (logout) {
    logout.onclick =
      async () => {
        try {
          await realtimeManager.stop();
          if (supabase) {
            await signOutAdmin(
              supabase
            );
          }
        } finally {
          session = null;
          restaurant = null;
          remote = null;
          mode = 'local';
          if (ageTickerHandle) {
            clearInterval(ageTickerHandle);
            ageTickerHandle = null;
          }
          renderLogin();
        }
      };
  }
  root
    .querySelectorAll(
      '[data-next]'
    )
    .forEach(button => {
      button.onclick =
        () => {
          const order =
            data.find(
              item =>
                String(
                  item.id ?? ''
                ) ===
                String(
                  button.dataset.id
                )
            );
          if (order) {
            advance(order, button);
          }
        };
    });
  root
    .querySelectorAll(
      '[data-print]'
    )
    .forEach(button => {
      button.onclick =
        () => {
          const order =
            data.find(
              item =>
                String(
                  item.id ?? ''
                ) ===
                String(
                  button.dataset.id
                )
            );
          if (order) {
            printOrderSmart(order, restaurant?.name);
          }
        };
    });
  root
    .querySelectorAll(
      '[data-toggle-delivery]'
    )
    .forEach(button => {
      button.onclick =
        () => {
          const order =
            data.find(
              item =>
                String(
                  item.id ?? ''
                ) ===
                String(
                  button.dataset.id
                )
            );
          if (order) {
            toggleDelivery(order, button);
          }
        };
    });
  const exportButton =
    root.querySelector(
      '#export-stock'
    );
  if (exportButton) {
    exportButton.onclick =
      () => downloadStockSummaryCsv(data);
  }
  const accountingExportButton =
    root.querySelector(
      '#export-accounting'
    );
  if (accountingExportButton) {
    accountingExportButton.onclick =
      () => openAccountingExportModal(data);
  }
  const connectPrinterButton =
    root.querySelector(
      '#connect-printer'
    );
  if (connectPrinterButton && thermalPrinter) {
    connectPrinterButton.hidden = false;
    connectPrinterButton.textContent = thermalPrinter.isConnected()
      ? `Imprimante : ${thermalPrinter.getDeviceInfo()?.productName || 'connectée'}`
      : "Connecter l'imprimante";
    connectPrinterButton.onclick = async () => {
      connectPrinterButton.textContent = 'Connexion…';
      try {
        await thermalPrinter.connect();
        connectPrinterButton.textContent = `Imprimante : ${thermalPrinter.getDeviceInfo()?.productName || 'connectée'}`;
      } catch (err) {
        console.error('[FOODATOI admin] Connexion imprimante annulée ou échouée:', err);
        connectPrinterButton.textContent = "Connecter l'imprimante";
      }
    };
  }
  const healthButton =
    root.querySelector(
      '#system-health'
    );
  if (healthButton) {
    healthButton.onclick =
      () => renderSystemHealth();
    // Badge : nombre d'erreurs des dernières 24 h, pour que le comptoir
    // remarque un incident sans ouvrir la modale. Best-effort — en cas
    // d'échec, getRecentErrors a déjà tracé via console.error (filet
    // global), donc rien n'est perdu ici.
    if (mode === 'remote' && remote?.getRecentErrors) {
      remote
        .getRecentErrors()
        .then((errors) => {
          const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const recent = errors.filter(
            (e) => new Date(e.created_at).getTime() > dayAgo
          ).length;
          if (recent > 0) {
            healthButton.textContent = `État système (${recent})`;
            healthButton.classList.add('has-errors');
          }
        })
        .catch(() => {});
    }
  }
  const printStockButton =
    root.querySelector(
      '#print-stock'
    );
  if (printStockButton) {
    printStockButton.onclick =
      () =>
        printStockSummary(
          aggregateOrderItems(data),
          {
            rangeLabel: `${data.length} commande${data.length > 1 ? 's' : ''} affichée${data.length > 1 ? 's' : ''}`,
            restaurantName: restaurant?.name
          }
        );
  }
  root
    .querySelectorAll(
      '.order-card'
    )
    .forEach(card => {
      card.onclick =
        (event) => {
          if (
            event.target.closest(
              'button'
            )
          ) {
            return;
          }
          const order =
            data.find(
              item =>
                String(
                  item.id ?? ''
                ) ===
                String(
                  card.dataset.order
                )
            );
          if (order) {
            renderOrderDetail(
              order
            );
          }
        };
    });
}
function downloadStockSummaryCsv(orders) {
  const csv = buildStockSummaryCsv(
    aggregateOrderItems(orders)
  );
  const blob = new Blob(
    [
      '\uFEFF' + csv
    ],
    { type: 'text/csv;charset=utf-8;' }
  );
  const url =
    URL.createObjectURL(blob);
  const link =
    document.createElement('a');
  link.href = url;
  link.download = `${restaurantFilePrefix()}-stock-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function restaurantFilePrefix() {
  return (restaurant?.name || 'foodatoi')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'foodatoi';
}

function downloadAccountingCsv(orders, from, to) {
  const filtered = filterOrdersByDateRange(orders, from, to);
  const csv = buildAccountingCsv(filtered);
  const blob = new Blob(
    ['\uFEFF' + csv],
    { type: 'text/csv;charset=utf-8;' }
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const suffix = from || to
    ? `${from || 'debut'}_${to || 'fin'}`
    : new Date().toISOString().slice(0, 10);
  link.download = `${restaurantFilePrefix()}-comptabilite-${suffix}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openAccountingExportModal(orders) {
  const overlay = document.createElement('div');
  overlay.id = 'accounting-export-overlay';
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card">
      <button class="modal-close" id="close-accounting-export">×</button>
      <p class="eyebrow">EXPORT COMPTABLE</p>
      <h2>Choisis une période</h2>
      <p>Laisse les deux champs vides pour tout exporter.</p>
      <form id="accounting-export-form" class="order-form">
        <label>DU<input type="date" name="from"></label>
        <label>AU<input type="date" name="to"></label>
        <button class="primary full" type="submit">Télécharger le CSV</button>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  document.querySelector('#close-accounting-export').onclick = () => overlay.remove();

  document.querySelector('#accounting-export-form').onsubmit = (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    downloadAccountingCsv(orders, fields.from || null, fields.to || null);
    overlay.remove();
  };
}

function closeOrderDetail() {
  const overlay =
    document.querySelector(
      '#order-detail-overlay'
    );
  if (overlay) {
    overlay.remove();
  }
}
async function renderOrderDetail(order) {
  const items =
    order.items ??
    order.order_items ??
    [];
  const total =
    order.total ??
    (order.total_cents ?? 0) /
      100;
  const overlay =
    document.createElement(
      'div'
    );
  overlay.id =
    'order-detail-overlay';
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card order-detail-card">
      <button
        class="modal-close"
        id="close-order-detail"
      >
        ×
      </button>
      <p class="eyebrow">
        ${
          order.number ??
          order.order_number ??
          '—'
        }
        ·
        ${
          labels[order.status] ??
          order.status
        }
      </p>
      <h2>
        ${escapeHtml(
          order.customer?.name ??
          order.customer_name ??
          'Client'
        )}
      </h2>
      <p>
        ${escapeHtml(
          order.customer?.phone ??
          order.customer_phone ??
          '—'
        )}
        · retrait
        ${
          formatPickupTime(
            order.pickup_time
          ) || '—'
        }
      </p>
      <table class="detail-items">
        <tbody>
          ${items
            .map(
              item => `
                <tr>
                  <td>
                    <strong>
                      ${item.quantity}×
                      ${escapeHtml(
                        item.name ??
                        item.product_name ??
                        'Article'
                      )}
                    </strong>
                    <br>
                    <small>
                      ${escapeHtml(
                        formatOrderItemOptions(item) || '—'
                      )}
                    </small>
                  </td>
                  <td class="num">
                    ${euro(
                      (item.line_total_cents ??
                        (item.price ?? 0) *
                          item.quantity *
                          100) / 100
                    )}
                  </td>
                </tr>
              `
            )
            .join('')}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td class="num">
              ${euro(total)}
            </td>
          </tr>
        </tfoot>
      </table>
      ${
        order.notes
          ? `
            <p class="detail-notes">
              <strong>Note :</strong>
              ${escapeHtml(
                order.notes
              )}
            </p>
          `
          : ''
      }
      <div id="detail-timeline">
        <p class="eyebrow">
          Historique
        </p>
        <p class="detail-timeline-loading">
          ${
            mode === 'remote'
              ? 'Chargement…'
              : 'Non disponible en mode local.'
          }
        </p>
      </div>
      <button
        class="secondary full"
        id="print-from-detail"
      >
        ⌁ Imprimer le ticket
      </button>
    </div>
  `;
  document.body.appendChild(
    overlay
  );
  overlay.onclick =
    (event) => {
      if (event.target === overlay) {
        closeOrderDetail();
      }
    };
  overlay
    .querySelector(
      '#close-order-detail'
    ).onclick = closeOrderDetail;
  overlay
    .querySelector(
      '#print-from-detail'
    ).onclick = () =>
    printOrderSmart(order, restaurant?.name);
  if (
    mode === 'remote' &&
    remote?.getOrderEvents
  ) {
    try {
      const events =
        await remote.getOrderEvents(
          order.id
        );
      const timelineEl =
        overlay.querySelector(
          '#detail-timeline'
        );
      if (!timelineEl) return;
      timelineEl.innerHTML = `
        <p class="eyebrow">
          Historique
        </p>
        ${
          events.length
            ? `
              <ul class="detail-timeline-list">
                ${events
                  .map(
                    (event) => `
                      <li>
                        <span>
                          ${new Date(
                            event.created_at
                          ).toLocaleTimeString(
                            'fr-FR',
                            {
                              hour: '2-digit',
                              minute: '2-digit'
                            }
                          )}
                        </span>
                        ${
                          labels[
                            event.from_status
                          ] ??
                          event.from_status ??
                          '—'
                        }
                        →
                        ${
                          labels[
                            event.to_status
                          ] ??
                          event.to_status
                        }
                      </li>
                    `
                  )
                  .join('')}
              </ul>
            `
            : `
              <p class="detail-timeline-loading">
                Aucun changement de statut encore.
              </p>
            `
        }
      `;
    } catch (error) {
      console.error(
        'Erreur historique commande:',
        error
      );
      const timelineEl =
        overlay.querySelector(
          '.detail-timeline-loading'
        );
      if (timelineEl) {
        timelineEl.textContent =
          'Historique indisponible.';
      }
    }
  }
}
async function renderSystemHealth() {
  const overlay =
    document.createElement(
      'div'
    );
  overlay.id =
    'system-health-overlay';
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card order-detail-card">
      <button
        class="modal-close"
        id="close-system-health"
      >
        ×
      </button>
      <p class="eyebrow">
        Diagnostic
      </p>
      <h2>
        État système
      </h2>
      <p id="health-loading">
        ${
          mode === 'remote'
            ? 'Chargement…'
            : 'Non disponible en mode local.'
        }
      </p>
    </div>
  `;
  document.body.appendChild(
    overlay
  );
  overlay.onclick =
    (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    };
  overlay
    .querySelector(
      '#close-system-health'
    ).onclick = () =>
    overlay.remove();
  if (
    mode !== 'remote' ||
    !remote?.getRecentErrors
  ) {
    return;
  }
  try {
    const errors =
      await remote.getRecentErrors();
    const loadingEl =
      overlay.querySelector(
        '#health-loading'
      );
    if (!loadingEl) return;
    const byContext = errors.reduce((acc, e) => {
      const key = e.context || '—';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(byContext)
      .sort((a, b) => b[1] - a[1])
      .map(([ctx, n]) => `${escapeHtml(ctx)} (${n})`)
      .join(' · ');
    loadingEl.outerHTML = errors.length
      ? `
        <p>
          ${errors.length} erreur${errors.length > 1 ? 's' : ''}
          enregistrée${errors.length > 1 ? 's' : ''}, la plus récente en premier.
        </p>
        <p class="health-summary">${summary}</p>
        <ul class="detail-timeline-list health-list">
          ${errors
            .map((err) => {
              const when = new Date(err.created_at).toLocaleString('fr-FR', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
              });
              const stack =
                err.details && err.details.stack
                  ? String(err.details.stack)
                  : '';
              return `
                <li>
                  <span>${when}</span>
                  <div>
                    <strong>${escapeHtml(err.context ?? '—')}</strong>
                    ${err.page ? ` · <em>${escapeHtml(err.page)}</em>` : ''}
                    <br>
                    ${escapeHtml(err.message ?? '')}
                    ${
                      stack
                        ? `<details class="health-stack"><summary>détails</summary><pre>${escapeHtml(stack)}</pre></details>`
                        : ''
                    }
                  </div>
                </li>
              `;
            })
            .join('')}
        </ul>
      `
      : `
        <p>
          Aucune erreur enregistrée récemment. Bon signe.
        </p>
      `;
  } catch (error) {
    console.error(
      'Erreur chargement état système:',
      error
    );
    const loadingEl =
      overlay.querySelector(
        '#health-loading'
      );
    if (loadingEl) {
      loadingEl.textContent =
        'Impossible de charger les logs.';
    }
  }
}
function orderCard(order) {
  const status =
    order.status;
  const items =
    order.items ??
    order.order_items ??
    [];
  /*
   * IMPORTANT :
   *
   * On reconstruit TOUJOURS customer.pickupTime
   * depuis order.pickup_time.
   *
   * Même si order.customer.pickupTime existe,
   * on l'écrase volontairement.
   *
   * Cela évite que le supabaseStore.mjs fournisse
   * une heure déjà convertie en UTC/local.
   */
  const customer = {
    ...(order.customer ?? {}),
    name:
      order.customer?.name ??
      order.customer_name ??
      'Client',
    phone:
      order.customer?.phone ??
      order.customer_phone ??
      '—',
    pickupTime:
      formatPickupTime(
        order.pickup_time
      )
  };
  const number =
    order.number ??
    order.order_number ??
    '—';
  const total =
    order.total ??
    (order.total_cents ?? 0) /
      100;
  const isDelivery =
    order.fulfillment_type ===
    'DELIVERY';
  const deliveryAddress =
    order.delivery_address ??
    null;
  const deliveryStatus =
    order.delivery_status;
  const actionLabel =
    getNextStatusLabel(
      status
    );
  let action;
  if (actionLabel) {
    action = `
      <button
        class="primary"
        data-next
        data-id="${order.id}"
      >
        ${actionLabel} →
      </button>
    `;
  } else if (status === 'READY') {
    action = `
      <span class="ready-badge">
        ✓ Prête${
          isDelivery
            ? ', à livrer'
            : ' pour retrait'
        }
      </span>
    `;
  } else {
    /*
     * Statut sans action suivante ET différent de READY (ex.
     * CANCELLED) : auparavant affiché à tort comme "✓ Prête" (le
     * badge par défaut ne distinguait pas ce cas). On affiche
     * désormais le vrai statut, jamais une confirmation inventée.
     */
    action = `
      <span class="oi-counter-terminal-badge">
        ${escapeHtml(labels[status] ?? status)}
      </span>
    `;
  }
  const deliveryToggle =
    isDelivery
      ? `
        <button
          class="delivery-toggle${
            deliveryStatus ===
            'DELIVERED'
              ? ' is-delivered'
              : ''
          }"
          data-toggle-delivery
          data-id="${order.id}"
        >
          ${
            deliveryLabels[
              deliveryStatus
            ] ??
            deliveryLabels.TO_DELIVER
          }
        </button>
      `
      : '';
  const createdAt =
    order.created_at ??
    order.createdAt ??
    null;
  const modeLabel =
    isDelivery ? 'Livraison' : 'Retrait';
  const slotLine =
    customer.pickupTime && customer.pickupTime !== '—'
      ? `${modeLabel} ${customer.pickupTime}`
      : '';
  return `
    <article
      class="order-card oi-counter-card status-${String(
        status
      ).toLowerCase()}"
      data-order="${order.id}"
    >
      <header class="oi-counter-card-head">
        <span class="oi-counter-number">
          ${escapeHtml(number)}
        </span>
        ${
          createdAt
            ? `<span class="oi-counter-age" data-created-at="${escapeHtml(createdAt)}">${escapeHtml(formatOrderAge(createdAt))}</span>`
            : ''
        }
      </header>
      <p class="oi-counter-mode">
        <span class="oi-counter-mode-tag">${modeLabel}</span>
        ${slotLine ? `<span class="oi-counter-slot">${escapeHtml(slotLine)}</span>` : ''}
        <span class="oi-counter-status-tag">${escapeHtml(labels[status] ?? status)}</span>
      </p>
      <div class="oi-counter-customer">
        <strong>
          ${escapeHtml(customer.name)}
        </strong>
        <span>
          ${escapeHtml(customer.phone)}
        </span>
      </div>
      ${
        isDelivery && deliveryAddress
          ? `
            <div class="order-delivery">
              <span>
                ${escapeHtml(deliveryAddress.street ?? '')},
                ${escapeHtml(deliveryAddress.postal_code ?? '')}
                ${escapeHtml(deliveryAddress.city ?? '')}
              </span>
              ${
                deliveryAddress.complement
                  ? `<small>${escapeHtml(deliveryAddress.complement)}</small>`
                  : ''
              }
            </div>
          `
          : ''
      }
      ${
        items.length
          ? `
            <ul class="oi-counter-items">
              ${items
                .map((item) => {
                  const optionsLine =
                    formatOrderItemOptions(item);
                  return `
                    <li>
                      <strong>
                        ${item.quantity}×
                      </strong>
                      ${escapeHtml(
                        item.name ??
                        item.product_name ??
                        'Article'
                      )}
                      ${
                        optionsLine
                          ? `<small>${escapeHtml(optionsLine)}</small>`
                          : ''
                      }
                    </li>
                  `;
                })
                .join('')}
            </ul>
          `
          : `
            <p class="order-items-empty">
              Détail des articles indisponible
            </p>
          `
      }
      <footer>
        <strong class="oi-counter-total">
          ${euro(total)}
        </strong>
        <div class="order-actions">
          ${action}
          ${deliveryToggle}
          <button
            class="print-button"
            data-print
            data-id="${order.id}"
            title="Imprimer le ticket"
          >
            Ticket
          </button>
        </div>
      </footer>
    </article>
  `;
}
init();
