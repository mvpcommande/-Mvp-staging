import test from 'node:test';
import assert from 'node:assert/strict';
import { parisTimeToIsoDate, formatPickupTime, isRestaurantOpen, formatOpeningHours } from './timeFormat.mjs';

test('parisTimeToIsoDate + formatPickupTime round-trip back to the same wall-clock time', () => {
  for (const time of ['00:15', '09:00', '12:30', '19:30', '21:30', '23:45']) {
    const iso = parisTimeToIsoDate(time);
    assert.equal(formatPickupTime(iso), time);
  }
});

test('formatPickupTime converts a raw Postgres UTC timestamp to Europe/Paris, not a naive substring', () => {
  // This is the exact regression the broken admin.js implementation had:
  // it returned '19:30' (the raw UTC digits) for a pickup that was
  // actually 21:30 Paris time (CEST, UTC+2 in August).
  assert.equal(formatPickupTime('2026-08-24 19:30:00+00'), '21:30');
  assert.equal(formatPickupTime('2026-08-24T19:30:00+00:00'), '21:30');
});

test('formatPickupTime handles missing/invalid values', () => {
  assert.equal(formatPickupTime(null), '—');
  assert.equal(formatPickupTime(''), '—');
  assert.equal(formatPickupTime('not-a-date'), '—');
});

test('parisTimeToIsoDate rejects malformed input', () => {
  assert.equal(parisTimeToIsoDate('25:00'), null);
  assert.equal(parisTimeToIsoDate('9:00'), null);
  assert.equal(parisTimeToIsoDate(''), null);
  assert.equal(parisTimeToIsoDate(null), null);
});

test('parisTimeToIsoDate with an explicit future date lands on that date, not today', () => {
  const iso = parisTimeToIsoDate('19:00', '2026-09-04');
  const parisDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(iso));
  assert.equal(parisDate, '2026-09-04');
  assert.equal(formatPickupTime(iso), '19:00');
});

test('parisTimeToIsoDate rejects a malformed date string', () => {
  assert.equal(parisTimeToIsoDate('19:00', '04-09-2026'), null);
  assert.equal(parisTimeToIsoDate('19:00', 'not-a-date'), null);
});

test('parisTimeToIsoDate with no date argument still defaults to today (backward compatible)', () => {
  const withoutDate = parisTimeToIsoDate('14:00');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const withExplicitToday = parisTimeToIsoDate('14:00', todayStr);
  // Les deux tombent sur le même jour Europe/Paris (peut différer de
  // quelques millisecondes de construction, donc on compare le jour
  // affiché plutôt que la chaîne ISO exacte).
  assert.equal(formatPickupTime(withoutDate), formatPickupTime(withExplicitToday));
});

test('isRestaurantOpen returns true when no hours are configured (no restriction)', () => {
  assert.equal(isRestaurantOpen(null), true);
  assert.equal(isRestaurantOpen(undefined), true);
});

test('isRestaurantOpen respects per-day ranges in Europe/Paris time', () => {
  const hours = { mon: [['11:00', '14:30'], ['18:30', '22:00']] };
  // 2026-08-24 is a Monday. 19:33 UTC = 21:33 Paris (CEST) -> within the evening range.
  assert.equal(isRestaurantOpen(hours, new Date('2026-08-24T19:33:00Z')), true);
  // 15:00 UTC = 17:00 Paris -> between lunch and dinner, closed.
  assert.equal(isRestaurantOpen(hours, new Date('2026-08-24T15:00:00Z')), false);
});

test('isRestaurantOpen treats a missing/empty day as closed', () => {
  const hours = { mon: [['11:00', '22:00']] };
  // 2026-08-25 is a Tuesday, not in `hours` at all.
  assert.equal(isRestaurantOpen(hours, new Date('2026-08-25T12:00:00Z')), false);
});

test('formatOpeningHours merges consecutive identical days, matching real Caz Food hours', () => {
  const hours = {
    mon: [['11:30', '14:00'], ['18:30', '22:00']],
    tue: [['11:30', '14:00'], ['18:30', '22:00']],
    wed: [['11:30', '14:00'], ['18:30', '22:00']],
    thu: [['11:30', '14:00'], ['18:30', '22:00']],
    fri: [['18:30', '22:00']],
    sat: [['12:00', '14:00'], ['18:30', '22:00']],
    sun: [['18:30', '22:00']]
  };

  const lines = formatOpeningHours(hours);

  assert.deepEqual(lines, [
    { label: 'Lundi–Jeudi', hours: '11:30–14:00, 18:30–22:00' },
    { label: 'Vendredi', hours: '18:30–22:00' },
    { label: 'Samedi', hours: '12:00–14:00, 18:30–22:00' },
    { label: 'Dimanche', hours: '18:30–22:00' }
  ]);
});

test('formatOpeningHours returns an empty array when nothing is configured', () => {
  assert.deepEqual(formatOpeningHours(null), []);
});

test('formatOpeningHours marks a day with no ranges as Fermé', () => {
  const hours = {
    mon: [],
    tue: [['11:30', '14:00']],
    wed: [['11:30', '14:00']],
    thu: [['11:30', '14:00']],
    fri: [['11:30', '14:00']],
    sat: [['11:30', '14:00']],
    sun: [['11:30', '14:00']]
  };

  assert.deepEqual(formatOpeningHours(hours), [
    { label: 'Lundi', hours: 'Fermé' },
    { label: 'Mardi–Dimanche', hours: '11:30–14:00' }
  ]);
});
