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
  calculateUberEatsSavings
} from './adminFeatures.mjs';
import { resolveRestaurant } from './restaurantResolver.mjs';
import { formatPickupTime } from './timeFormat.mjs';
import { logClientError } from './errorLog.mjs';
import { escapeHtml } from './htmlEscape.mjs';
import './styles.css';
const root = document.querySelector('#admin-root');
const labels = {
  NEW: 'Nouvelle',
  ACCEPTED: 'Acceptée',
  PREPARING: 'En préparation',
  READY: 'Prête',
  CANCELLED: 'Annulée'
};
let remote = null;
let mode = 'local';
let realtimeChannel = null;
let session = null;
let restaurant = null;
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
    subscribeRealtime();
    await render();
    return;
  }
  renderLogin();
}
function subscribeRealtime() {
  if (
    realtimeChannel &&
    supabase
  ) {
    supabase.removeChannel(
      realtimeChannel
    );
  }
  /*
   * IMPORTANT :
   *
   * S'abonner tout de suite après signInAdmin()/
   * getAdminSession() peut, selon le timing, créer
   * le canal avant que le token soit propagé au
   * client realtime, et donc s'abonner en tant
   * qu'anon (aucun droit de lecture sur orders,
   * donc aucun événement ne remonte, sans erreur).
   *
   * On force explicitement l'auth du client realtime
   * avec le token de session avant de créer le canal.
   */
  if (
    supabase &&
    session?.access_token
  ) {
    supabase.realtime.setAuth(
      session.access_token
    );
  }
  realtimeChannel =
    subscribeToOrderChanges(
      supabase,
      () => render(),
      (status) => {
        const dropped =
          status === 'CLOSED' ||
          status === 'TIMED_OUT' ||
          status === 'CHANNEL_ERROR';
        if (
          dropped &&
          mode === 'remote'
        ) {
          console.warn(
            '[Realtime] Reconnexion dans 3s...'
          );
          logClientError(supabase, {
            restaurantId: restaurant?.id,
            context: 'admin.realtime',
            message: `Canal realtime perdu (${status}), reconnexion dans 3s`,
            page: 'admin'
          });
          setTimeout(() => {
            if (mode === 'remote') {
              subscribeRealtime();
            }
          }, 3000);
        }
      }
    );
}
function renderSetup() {
  root.innerHTML = `
    <main class="admin-auth">
      <div class="auth-card">
        <div class="auth-mark">
          CF
        </div>
        <p class="eyebrow">
          CAZ FOOD · CONFIGURATION
        </p>
        <h1>
          Le comptoir<br>
          <em>arrive bientôt.</em>
        </h1>
        <p>
          Ajoute
          <code>VITE_SUPABASE_URL</code>
          et
          <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>
          dans Netlify pour activer le compte commerçant.
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
          CF
        </div>
        <p class="eyebrow">
          CAZ FOOD · LE COMPTOIR
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
          CF
        </div>
        <p class="eyebrow">
          CAZ FOOD · LE COMPTOIR
        </p>
        <h1>
          Bon retour.
        </h1>
        <p>
          Connexion réservée à l'équipe Caz Food.
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
        subscribeRealtime();
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
async function advance(order) {
  const next = {
    NEW: 'ACCEPTED',
    ACCEPTED: 'PREPARING',
    PREPARING: 'READY'
  }[order.status];
  if (!next) {
    return;
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
    await render();
  } catch (error) {
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
  }
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
  const total =
    data.reduce(
      (sum, order) =>
        sum +
        Number(
          order.total ??
          (order.total_cents ?? 0) /
            100
        ),
      0
    );
  root.innerHTML = `
    <main class="admin-shell">
      <header class="admin-header">
        <div>
          <p class="eyebrow">
            CAZ FOOD · SERVICE
          </p>
          <h1>
            Le comptoir.
          </h1>
          <p>
            ${
              mode === 'remote'
                ? 'Commandes en direct · Supabase Realtime'
                : 'Mode démo local'
            }
          </p>
        </div>
        <div class="admin-actions">
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
      <section class="admin-stats">
        <div>
          <span>
            À prendre en charge
          </span>
          <strong>
            ${
              data.filter(
                order =>
                  order.status ===
                  'NEW'
              ).length
            }
          </strong>
        </div>
        <div>
          <span>
            En préparation
          </span>
          <strong>
            ${
              data.filter(
                order =>
                  order.status ===
                  'PREPARING'
              ).length
            }
          </strong>
        </div>
        <div>
          <span>
            Prêtes
          </span>
          <strong>
            ${
              data.filter(
                order =>
                  order.status ===
                  'READY'
              ).length
            }
          </strong>
        </div>
        <div>
          <span>
            Commandé
          </span>
          <strong>
            ${euro(total)}
          </strong>
        </div>
      </section>
      ${
        (() => {
          const savings =
            calculateUberEatsSavings(
              data,
              restaurant?.settings
                ?.uber_eats_commission_rate
            );
          if (!savings || !savings.orderCount) {
            return '';
          }
          return `
            <section class="roi-banner">
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
          `;
        })()
      }
      <section class="orders-grid">
        ${
          data.length
            ? data
                .map(orderCard)
                .join('')
            : `
              <div class="empty-ticket admin-empty">
                <div class="empty-ticket-mark">
                  +
                </div>
                <h2>
                  Le comptoir est calme.
                </h2>
                <p>
                  La prochaine commande apparaîtra ici
                  dès qu'elle sera envoyée.
                </p>
              </div>
            `
        }
      </section>
      <p class="admin-note">
        ●
        ${
          mode === 'remote'
            ? 'Temps réel actif. Les nouvelles commandes apparaissent automatiquement.'
            : 'Mode démo local.'
        }
      </p>
    </main>
  `;
  const logout =
    root.querySelector(
      '#logout'
    );
  if (logout) {
    logout.onclick =
      async () => {
        try {
          if (
            realtimeChannel &&
            supabase
          ) {
            await supabase.removeChannel(
              realtimeChannel
            );
          }
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
          realtimeChannel = null;
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
            advance(order);
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
            printOrder(order);
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
  const healthButton =
    root.querySelector(
      '#system-health'
    );
  if (healthButton) {
    healthButton.onclick =
      () => renderSystemHealth();
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
            rangeLabel: `${data.length} commande${data.length > 1 ? 's' : ''} affichée${data.length > 1 ? 's' : ''}`
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
  link.download = `caz-food-stock-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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
        ${
          order.customer?.name ??
          order.customer_name ??
          'Client'
        }
      </h2>
      <p>
        ${
          order.customer?.phone ??
          order.customer_phone ??
          '—'
        }
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
                      ${
                        item.name ??
                        item.product_name ??
                        'Article'
                      }
                    </strong>
                    <br>
                    <small>
                      ${
                        [
                          item.options?.meat,
                          item.options?.sauce,
                          item.options?.drink
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'
                      }
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
    printOrder(order);
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
    loadingEl.outerHTML = errors.length
      ? `
        <p>
          ${errors.length} erreur${errors.length > 1 ? 's' : ''}
          enregistrée${errors.length > 1 ? 's' : ''}, la plus récente en premier.
        </p>
        <ul class="detail-timeline-list health-list">
          ${errors
            .map(
              (err) => `
                <li>
                  <span>
                    ${new Date(
                      err.created_at
                    ).toLocaleString(
                      'fr-FR',
                      {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                      }
                    )}
                  </span>
                  <div>
                    <strong>
                      ${err.context ?? '—'}
                    </strong>
                    <br>
                    ${err.message ?? ''}
                  </div>
                </li>
              `
            )
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
  const actionLabel =
    getNextStatusLabel(
      status
    );
  const action =
    actionLabel
      ? `
        <button
          class="primary"
          data-next
          data-id="${order.id}"
        >
          ${actionLabel} →
        </button>
      `
      : `
        <span class="ready-badge">
          ✓ Prête pour retrait
        </span>
      `;
  return `
    <article
      class="order-card status-${String(
        status
      ).toLowerCase()}"
      data-order="${order.id}"
    >
      <header>
        <div>
          <span class="order-number">
            ${number}
          </span>
          <span class="status">
            ${
              labels[status] ??
              status
            }
          </span>
        </div>
        <strong>
          ${
            customer.pickupTime ||
            '—'
          }
        </strong>
      </header>
      <div class="order-customer">
        <strong>
          ${customer.name}
        </strong>
        <span>
          ${customer.phone}
        </span>
      </div>
      ${
        items.length
          ? `
            <ul>
              ${items
                .map(
                  item => `
                    <li>
                      <strong>
                        ${item.quantity}×
                      </strong>
                      ${
                        item.name ??
                        item.product_name ??
                        'Article'
                      }
                      ${
                        item.options?.meat
                          ? `
                            <small>
                              · ${item.options.meat}
                            </small>
                          `
                          : ''
                      }
                      ${
                        item.options?.sauce
                          ? `
                            <small>
                              · ${item.options.sauce}
                            </small>
                          `
                          : ''
                      }
                      ${
                        item.options?.drink
                          ? `
                            <small>
                              · ${item.options.drink}
                            </small>
                          `
                          : ''
                      }
                    </li>
                  `
                )
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
        <strong>
          ${euro(total)}
        </strong>
        <div class="order-actions">
          ${action}
          <button
            class="print-button"
            data-print
            data-id="${order.id}"
            title="Imprimer le ticket"
          >
            ⌁ TICKET
          </button>
        </div>
      </footer>
    </article>
  `;
}
init();
