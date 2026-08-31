const transitions = {
  NEW: ['ACCEPTED'],
  ACCEPTED: ['PREPARING'],
  PREPARING: ['READY'],
  READY: []
};

export function transitionOrder(current, next) {
  if (!transitions[current]?.includes(next)) {
    throw new Error(`Transition invalide: ${current} -> ${next}`);
  }
  return next;
}

export function nextStatus(current) {
  return { NEW: 'ACCEPTED', ACCEPTED: 'PREPARING', PREPARING: 'READY' }[current] ?? null;
}
