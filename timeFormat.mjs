/**
 * Conversion d'heure Europe/Paris <-> UTC, utilisée à
 * la fois pour l'envoi (main.js, via supabaseStore.mjs)
 * et l'affichage (admin.js, adminFeatures.mjs).
 *
 * Auparavant dupliqué à 3 endroits, dont un qui ne
 * convertissait rien du tout : formatPickupTime() dans
 * admin.js extrayait l'heure directement de la chaîne
 * timestamp brute (UTC) par regex, sans tenir compte du
 * fuseau. Résultat juste en hiver par accident (UTC+1 ==
 * décalage attendu un jour sur deux au pire), toujours
 * faux de 2h en été (CEST, UTC+2).
 */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Vérifie si le restaurant est ouvert à l'instant donné
 * (Europe/Paris), selon des horaires au format :
 *
 * { mon: [["11:00","14:30"],["18:30","22:00"]], tue: [...], ... }
 *
 * Un jour absent ou avec un tableau vide = fermé ce jour-là.
 * openingHours null/undefined = pas de restriction (ouvert).
 *
 * Fonction pure : la date/heure "actuelle" est un paramètre,
 * pas Date.now() en dur, pour rester testable.
 */
export function isRestaurantOpen(openingHours, now = new Date()) {
  if (!openingHours) {
    return true;
  }

  const parisParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);

  const hour = parisParts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parisParts.find((p) => p.type === 'minute')?.value ?? '00';
  const nowMinutes = Number(hour) * 60 + Number(minute);

  // en-US 'short' weekday gives e.g. "Mon", "Tue"... map to our lowercase keys.
  const shortWeekday = (
    parisParts.find((p) => p.type === 'weekday')?.value ?? ''
  ).toLowerCase();

  const dayKey = DAY_KEYS.includes(shortWeekday)
    ? shortWeekday
    : shortWeekday.slice(0, 3);

  const ranges = openingHours[dayKey];

  if (!Array.isArray(ranges) || !ranges.length) {
    return false;
  }

  return ranges.some(([start, end]) => {
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return false;
    }
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  });
}

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_LABELS = {
  mon: 'Lundi',
  tue: 'Mardi',
  wed: 'Mercredi',
  thu: 'Jeudi',
  fri: 'Vendredi',
  sat: 'Samedi',
  sun: 'Dimanche'
};

function formatRanges(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) {
    return 'Fermé';
  }
  return ranges.map(([start, end]) => `${start}–${end}`).join(', ');
}

/**
 * Transforme l'objet opening_hours en lignes affichables,
 * en regroupant les jours CONSÉCUTIFS ayant exactement
 * les mêmes horaires (ex: Lundi–Jeudi plutôt que 4 lignes
 * identiques). Retourne [] si aucun horaire configuré.
 */
export function formatOpeningHours(openingHours) {
  if (!openingHours) {
    return [];
  }

  const lines = [];
  let i = 0;

  while (i < DAY_ORDER.length) {
    const rangesText = formatRanges(openingHours[DAY_ORDER[i]]);
    let j = i;

    while (
      j + 1 < DAY_ORDER.length &&
      formatRanges(openingHours[DAY_ORDER[j + 1]]) === rangesText
    ) {
      j++;
    }

    lines.push({
      label:
        i === j
          ? DAY_LABELS[DAY_ORDER[i]]
          : `${DAY_LABELS[DAY_ORDER[i]]}–${DAY_LABELS[DAY_ORDER[j]]}`,
      hours: rangesText
    });

    i = j + 1;
  }

  return lines;
}

/**
 * Convertit une heure HH:mm choisie par le client
 * (Europe/Paris, à la date du jour) en timestamp ISO UTC.
 */
export function parisTimeToIsoDate(time) {
  if (
    !time ||
    !/^\d{2}:\d{2}$/.test(String(time))
  ) {
    return null;
  }

  const [hours, minutes] = String(time)
    .split(':')
    .map(Number);

  if (
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  const now = new Date();

  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();

  /*
   * On part d'une approximation UTC puis on calcule
   * le décalage réel Europe/Paris à cette date.
   */
  const utcGuess = new Date(
    Date.UTC(year, month, day, hours, minutes, 0, 0)
  );

  const parisFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parisParts = parisFormatter.formatToParts(utcGuess);

  const parisHour = Number(
    parisParts.find((part) => part.type === 'hour')?.value ?? 0
  );

  const parisMinute = Number(
    parisParts.find((part) => part.type === 'minute')?.value ?? 0
  );

  const requestedMinutes = hours * 60 + minutes;
  const guessedParisMinutes = parisHour * 60 + parisMinute;
  const offsetMinutes = guessedParisMinutes - requestedMinutes;

  const utcDate = new Date(
    utcGuess.getTime() - offsetMinutes * 60 * 1000
  );

  return utcDate.toISOString();
}

/**
 * Convertit un timestamp Supabase (UTC) en heure locale
 * Europe/Paris pour l'affichage, quel que soit le fuseau
 * du navigateur qui l'affiche.
 */
export function formatPickupTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}
