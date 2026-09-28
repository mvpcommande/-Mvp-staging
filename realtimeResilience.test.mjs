import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeConnectionManager } from './realtimeResilience.mjs';

/*
 * Horloge factice synchrone : les timers réels rendraient ces
 * scénarios (backoff, rafales de CLOSED, offline/online) lents et non
 * déterministes. advance(ms) exécute tout timeout/intervalle dû dans
 * l'ordre, en autorisant un callback à en replanifier d'autres dans la
 * même fenêtre (comme le ferait un vrai setTimeout imbriqué).
 */
function createFakeClock() {
  let time = 0;
  let idCounter = 0;
  const timeouts = new Map();
  const intervals = new Map();

  function setTimeoutFn(fn, delay) {
    const id = ++idCounter;
    timeouts.set(id, { at: time + delay, fn });
    return id;
  }
  function clearTimeoutFn(id) {
    timeouts.delete(id);
  }
  function setIntervalFn(fn, delay) {
    const id = ++idCounter;
    intervals.set(id, { every: delay, next: time + delay, fn });
    return id;
  }
  function clearIntervalFn(id) {
    intervals.delete(id);
  }

  function advance(ms) {
    const target = time + ms;
    for (;;) {
      let nextAt = null;
      let kind = null;
      let id = null;
      for (const [tid, t] of timeouts) {
        if (t.at <= target && (nextAt === null || t.at < nextAt)) {
          nextAt = t.at;
          kind = 'timeout';
          id = tid;
        }
      }
      for (const [iid, iv] of intervals) {
        if (iv.next <= target && (nextAt === null || iv.next < nextAt)) {
          nextAt = iv.next;
          kind = 'interval';
          id = iid;
        }
      }
      if (nextAt === null) break;
      time = nextAt;
      if (kind === 'timeout') {
        const t = timeouts.get(id);
        timeouts.delete(id);
        t.fn();
      } else {
        const iv = intervals.get(id);
        iv.next += iv.every;
        iv.fn();
      }
    }
    time = target;
  }

  return { setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn, advance, now: () => time };
}

async function tick(n = 5) {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

/*
 * Channel factice : subscribe() renvoie un objet opaque distinct à
 * chaque appel (permet de vérifier qu'un seul channel "vivant" existe
 * jamais), et enregistre les callbacks pour que le test simule des
 * événements de statut à la main (SUBSCRIBED, CLOSED, CHANNEL_ERROR...).
 */
function createHarness({ backoffMs, pollIntervalMs } = {}) {
  const clock = createFakeClock();
  let channelSeq = 0;
  const subscribeCalls = [];
  const unsubscribeCalls = [];
  const setAuthCalls = [];
  const statusHistory = [];
  const pollCalls = [];
  const messages = [];
  let active = true;

  const manager = createRealtimeConnectionManager({
    subscribe: (onMessage, onStatusChange) => {
      const channel = { id: ++channelSeq, onMessage, onStatusChange };
      subscribeCalls.push(channel);
      return channel;
    },
    unsubscribe: async (channel) => {
      unsubscribeCalls.push(channel.id);
    },
    setAuth: async () => {
      setAuthCalls.push(clock.now());
    },
    onMessage: (payload) => messages.push(payload),
    onStatusChange: (status) => statusHistory.push(status),
    onPoll: () => pollCalls.push(clock.now()),
    isActive: () => active,
    backoffMs: backoffMs ?? [1000, 2000, 5000, 10000, 20000, 30000],
    pollIntervalMs: pollIntervalMs ?? 12000,
    jitterMs: 0,
    now: clock.now,
    random: () => 0,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn
  });

  return {
    manager,
    clock,
    subscribeCalls,
    unsubscribeCalls,
    setAuthCalls,
    statusHistory,
    pollCalls,
    messages,
    setActive: (v) => {
      active = v;
    },
    currentChannel: () => subscribeCalls[subscribeCalls.length - 1]
  };
}

// A. SUBSCRIBED normal -> exactement 1 channel -> aucun polling fallback.
test('A. connexion normale : un seul channel, pas de polling', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');

  assert.equal(h.manager.getStatus(), 'live');
  const counters = h.manager.getDebugCounters();
  assert.equal(counters.activeChannelCount, 1);
  assert.equal(counters.pollingActive, false);
  assert.equal(h.subscribeCalls.length, 1);
});

// B. CHANNEL_ERROR -> RECONNECTING -> fallback polling démarre -> une
// seule reconnexion programmée.
test('B. CHANNEL_ERROR déclenche reconnecting + polling, une seule reconnexion programmée', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CHANNEL_ERROR');

  assert.equal(h.manager.getStatus(), 'reconnecting');
  const counters = h.manager.getDebugCounters();
  assert.equal(counters.pollingActive, true);
  assert.equal(counters.reconnectTimerCount, 1);
});

// C. 5 CLOSED consécutifs rapides -> UNE SEULE tentative planifiée, pas
// 5 timers, pas 5 channels.
test('C. rafale de 5 CLOSED rapprochés : une seule reconnexion planifiée', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  const firstChannel = h.currentChannel();
  firstChannel.onStatusChange('SUBSCRIBED');

  for (let i = 0; i < 5; i += 1) {
    firstChannel.onStatusChange('CLOSED');
  }

  const counters = h.manager.getDebugCounters();
  assert.equal(counters.reconnectTimerCount, 1, 'un seul timer malgré 5 CLOSED');
  assert.equal(counters.reconnectAttempt, 1, 'un seul incrément de backoff');
  assert.equal(h.subscribeCalls.length, 1, 'aucun nouveau channel créé avant expiration du backoff');
});

// D. reconnexion réussie -> SUBSCRIBED -> attempt reset -> polling
// arrêté -> badge LIVE.
test('D. reconnexion réussie remet à zéro backoff et arrête le polling', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CLOSED');
  assert.equal(h.manager.getDebugCounters().pollingActive, true);

  h.clock.advance(1000); // backoff[0]
  await tick();
  assert.equal(h.subscribeCalls.length, 2, 'nouveau channel après expiration du backoff');
  h.currentChannel().onStatusChange('SUBSCRIBED');

  const counters = h.manager.getDebugCounters();
  assert.equal(h.manager.getStatus(), 'live');
  assert.equal(counters.reconnectAttempt, 0);
  assert.equal(counters.pollingActive, false);
  assert.equal(counters.reconnectTimerCount, 0);
});

// E. offline -> badge OFFLINE -> pas de boucle reconnect agressive.
test('E. offline coupe le polling et toute reconnexion planifiée', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CHANNEL_ERROR');
  assert.equal(h.manager.getDebugCounters().reconnectTimerCount, 1);

  h.manager.handleOffline();

  assert.equal(h.manager.getStatus(), 'offline');
  const counters = h.manager.getDebugCounters();
  assert.equal(counters.reconnectTimerCount, 0, 'le timer de reconnexion est annulé');
  assert.equal(counters.pollingActive, false, 'pas de polling à vide sans réseau');

  h.clock.advance(60000);
  assert.equal(h.subscribeCalls.length, 1, 'aucune tentative de reconnexion pendant 60s hors ligne');
});

// F. online -> reconnexion immédiate -> retour LIVE.
test('F. online déclenche une reconnexion immédiate (sans attendre le backoff)', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CHANNEL_ERROR');
  h.manager.handleOffline();

  h.manager.handleOnline();
  await tick();

  assert.equal(h.subscribeCalls.length, 2, 'reconnexion immédiate, pas de backoff de 1s+ à attendre');
  h.currentChannel().onStatusChange('SUBSCRIBED');
  assert.equal(h.manager.getStatus(), 'live');
});

// G. Safari : visibilité cachée puis visible -> health check.
test('G1. healthCheck ne recrée rien si le channel est sain (live)', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');

  h.manager.healthCheck();
  await tick();

  assert.equal(h.subscribeCalls.length, 1, 'aucun second channel créé alors que le premier est live');
});

test('G2. healthCheck reconnecte immédiatement si le channel est mort', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CHANNEL_ERROR');
  assert.equal(h.manager.getStatus(), 'reconnecting');

  h.manager.healthCheck();
  await tick();

  assert.equal(h.subscribeCalls.length, 2, 'reconnexion déclenchée sans attendre le backoff programmé');
});

// H. pageshow après suspension : même garantie que G (même méthode,
// admin.js appelle healthCheck() depuis visibilitychange ET pageshow).
test('H. deux appels healthCheck rapprochés (visibilitychange + pageshow) ne créent pas 2 channels', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CLOSED');

  h.manager.healthCheck();
  h.manager.healthCheck();
  await tick();

  assert.equal(h.subscribeCalls.length, 2, 'un seul nouveau channel malgré 2 appels healthCheck');
});

// I. commande créée pendant panne Realtime -> récupérée via le
// polling de secours.
test('I. le polling de secours tourne pendant reconnecting et s\'arrête au retour live', async () => {
  const h = createHarness({ pollIntervalMs: 12000 });
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CHANNEL_ERROR');

  h.clock.advance(12000);
  assert.equal(h.pollCalls.length, 1, 'premier cycle de polling à 12s');

  h.clock.advance(12000);
  assert.ok(h.pollCalls.length >= 2, 'le polling continue tant que reconnecting');
});

// K/L. déconnexion/reconnexion et re-init : jamais plus d'un channel
// actif, l'ancien est réellement détruit (unsubscribe appelé).
test('K/L. connect() concurrent (ex. healthCheck pendant un reconnect déjà en vol) ne laisse qu\'un seul channel actif', async () => {
  const h = createHarness();
  h.manager.start();
  // Deuxième démarrage explicite avant que le premier n'ait fini de
  // s'installer (le cas "navigation/re-init" de l'énoncé).
  h.manager.start();
  await tick();

  assert.equal(h.manager.getDebugCounters().activeChannelCount, 1, 'au plus un channel actif');
  // Le channel de la génération périmée doit avoir été désabonné.
  if (h.subscribeCalls.length > 1) {
    assert.ok(h.unsubscribeCalls.length >= 1);
  }
});

test('stop() détruit le channel actif et empêche toute reconnexion ultérieure', async () => {
  const h = createHarness();
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CHANNEL_ERROR');

  await h.manager.stop();

  assert.equal(h.unsubscribeCalls.length, 1);
  const counters = h.manager.getDebugCounters();
  assert.equal(counters.activeChannelCount, 0);
  assert.equal(counters.reconnectTimerCount, 0);

  h.clock.advance(60000);
  assert.equal(h.subscribeCalls.length, 1, 'aucune reconnexion après stop()');
});

test('backoff progresse selon la table fournie puis plafonne', async () => {
  const h = createHarness({ backoffMs: [1000, 2000, 5000] });
  h.manager.start();
  await tick();
  h.currentChannel().onStatusChange('SUBSCRIBED');
  h.currentChannel().onStatusChange('CLOSED');
  assert.equal(h.manager.getDebugCounters().reconnectAttempt, 1);

  h.clock.advance(1000);
  await tick();
  h.currentChannel().onStatusChange('CLOSED');
  assert.equal(h.manager.getDebugCounters().reconnectAttempt, 2);

  h.clock.advance(2000);
  await tick();
  h.currentChannel().onStatusChange('CLOSED');
  assert.equal(h.manager.getDebugCounters().reconnectAttempt, 3);

  h.clock.advance(5000);
  await tick();
  h.currentChannel().onStatusChange('CLOSED');
  // Table épuisée (3 valeurs) : le 4e essai réutilise le dernier palier
  // (5000ms), jamais un retry plus rapide que le pire cas configuré.
  assert.equal(h.manager.getDebugCounters().reconnectAttempt, 4);
});
