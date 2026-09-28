/**
 * Bloc 5.4 : gestionnaire de connexion Realtime pour le comptoir.
 *
 * Isolé de admin.js (DOM, Supabase réel) pour rester testable par
 * node --test avec des dépendances injectées (channel/timers factices) :
 * c'est le seul moyen de dérouler de façon déterministe des séquences
 * CLOSED/CHANNEL_ERROR rapprochées, un offline/online, ou une reprise
 * de premier plan, sans navigateur ni réseau réel.
 *
 * Garantit un seul invariant central, prouvé par les tests :
 * au plus UN channel actif et UNE reconnexion planifiée à la fois,
 * quel que soit l'enchaînement d'événements reçus.
 */

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const DEFAULT_POLL_INTERVAL_MS = 12000;
const DROPPED_STATUSES = new Set(['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']);

export function createRealtimeConnectionManager({
  subscribe,
  unsubscribe,
  setAuth,
  onMessage,
  onStatusChange,
  onPoll,
  isActive,
  backoffMs = DEFAULT_BACKOFF_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  jitterMs = 300,
  now = Date.now,
  random = Math.random,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  let channel = null;
  let generation = 0;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectInProgress = false;
  let pollTimer = null;
  let status = 'connecting';
  let lastEventAt = null;
  let stopped = true;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatusChange?.(next);
    if (next === 'live') {
      stopPolling();
    } else if (next === 'reconnecting') {
      startPolling();
    } else if (next === 'offline') {
      stopPolling();
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setIntervalFn(() => {
      if (isActive()) onPoll?.();
    }, pollIntervalMs);
  }

  function stopPolling() {
    if (pollTimer) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    // Garde single-flight : une reconnexion déjà programmée (timer) ou
    // déjà en cours d'exécution (connect()) rend tout nouvel appel
    // no-op. C'est ce qui empêche N CLOSED/CHANNEL_ERROR rapprochés de
    // produire N reconnexions concurrentes.
    if (reconnectTimer || reconnectInProgress || stopped) return;
    const base = backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)];
    reconnectAttempt += 1;
    const delay = base + Math.floor(random() * jitterMs);
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      if (isActive() && !stopped) connect();
    }, delay);
  }

  async function connect() {
    if (stopped) return;
    const myGeneration = ++generation;
    reconnectInProgress = true;
    setStatus('connecting');

    if (channel) {
      const stale = channel;
      channel = null;
      await unsubscribe(stale);
    }

    // Une génération plus récente a déjà pris le relais pendant l'await
    // ci-dessus (health check, retour online, reconnexion planifiée qui
    // s'est déclenchée entre-temps...) : on abandonne cette tentative
    // devenue obsolète plutôt que de créer un channel en trop.
    if (myGeneration !== generation || stopped) {
      reconnectInProgress = false;
      return;
    }

    await setAuth?.();

    if (myGeneration !== generation || stopped) {
      reconnectInProgress = false;
      return;
    }

    channel = subscribe(
      (payload) => {
        if (myGeneration !== generation) return; // callback d'un ancien channel
        lastEventAt = now();
        onMessage?.(payload);
      },
      (channelStatus) => {
        if (myGeneration !== generation) return; // idem
        if (channelStatus === 'SUBSCRIBED') {
          reconnectInProgress = false;
          reconnectAttempt = 0;
          clearReconnectTimer();
          setStatus('live');
          return;
        }
        if (DROPPED_STATUSES.has(channelStatus) && isActive()) {
          reconnectInProgress = false;
          setStatus('reconnecting');
          scheduleReconnect();
        }
      }
    );
  }

  function start() {
    stopped = false;
    connect();
  }

  async function stop() {
    stopped = true;
    clearReconnectTimer();
    stopPolling();
    reconnectInProgress = false;
    generation += 1; // invalide tout callback d'un channel encore en vol
    if (channel) {
      const current = channel;
      channel = null;
      await unsubscribe(current);
    }
  }

  function healthCheck() {
    if (stopped || !isActive()) return;
    if (status !== 'live') {
      clearReconnectTimer();
      reconnectAttempt = 0;
      if (!reconnectInProgress) connect();
    }
    // status === 'live' : channel jugé sain sur la base de notre propre
    // état (SUBSCRIBED reçu, jamais redescendu depuis) -- on ne le
    // recrée pas. Un éventuel événement manqué pendant une suspension
    // silencieuse (iOS) reste rattrapable par admin.js via son propre
    // rafraîchissement léger sur ce même événement de premier plan.
  }

  function handleOffline() {
    clearReconnectTimer();
    stopPolling();
    setStatus('offline');
  }

  function handleOnline() {
    if (stopped || !isActive()) return;
    clearReconnectTimer();
    reconnectAttempt = 0;
    if (!reconnectInProgress) connect();
  }

  function getStatus() {
    return status;
  }

  function getDebugCounters() {
    return {
      activeChannelCount: channel ? 1 : 0,
      reconnectTimerCount: reconnectTimer ? 1 : 0,
      pollingActive: pollTimer !== null,
      reconnectAttempt,
      lastEventAt
    };
  }

  return {
    start,
    stop,
    healthCheck,
    handleOffline,
    handleOnline,
    getStatus,
    getDebugCounters
  };
}
