/**
 * Impression thermique réelle (ESC/POS / StarPRNT) via WebUSB, en
 * plus du dialogue navigateur existant - pas à sa place.
 *
 * Limite réelle et non contournable : WebUSB n'existe que sur les
 * navigateurs Chromium (Chrome, Edge). Safari (donc tout iPhone/iPad)
 * ne l'implémente pas et ne l'implémentera probablement jamais -
 * c'est une position connue d'Apple, pas un simple retard. Sur ces
 * navigateurs, isThermalPrinterSupported() renvoie false et
 * l'impression classique (fenêtre navigateur) reste le seul chemin,
 * exactement comme avant ce module.
 */

export function isThermalPrinterSupported(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return Boolean(nav && 'usb' in nav);
}

/**
 * Construit les octets ESC/POS (ou StarPRNT) d'un ticket de cuisine
 * à partir d'une commande - fonction pure, testable sans imprimante
 * réelle. Reprend le même contenu que le ticket HTML existant
 * (numéro, articles, options viande/sauce/boisson, total, notes).
 */
export function buildReceiptBytes(order, ReceiptPrinterEncoder, options = {}) {
  const items = order.order_items ?? order.items ?? [];
  const money = (cents) => `${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')} EUR`;

  const encoder = new ReceiptPrinterEncoder({
    language: options.language || 'esc-pos',
    codepageMapping: options.codepageMapping || 'epson'
  });

  encoder
    .initialize()
    .codepage('auto')
    .align('center')
    .bold(true)
    .line(options.restaurantName || 'FOODATOI')
    .bold(false)
    .line(order.order_number ?? order.number ?? '—')
    .align('left')
    .rule();

  for (const item of items) {
    const name = item.product_name ?? item.name ?? '';
    const qty = item.quantity ?? 1;
    const lineTotal = item.line_total_cents ?? Math.round((item.price || 0) * qty * 100);

    encoder.bold(true).line(`${qty}x ${name}`).bold(false);

    const opts = [];
    if (item.options?.meat) opts.push(`Viande: ${item.options.meat}`);
    if (item.options?.sauce) opts.push(`Sauce: ${item.options.sauce}`);
    if (item.options?.drink) opts.push(`Boisson: ${item.options.drink}`);
    if (opts.length) {
      encoder.line(opts.join(' - '));
    }

    encoder.align('right').line(money(lineTotal)).align('left');
  }

  encoder.rule();

  if (order.notes) {
    encoder.bold(true).line('NOTE:').bold(false).line(order.notes).rule();
  }

  const totalCents = order.total_cents ?? Math.round((order.total || 0) * 100);

  encoder
    .size(2, 2)
    .bold(true)
    .align('right')
    .line(`TOTAL ${money(totalCents)}`)
    .bold(false)
    .size(1, 1)
    .align('left')
    .newline()
    .newline()
    .cut();

  return encoder.encode();
}

/**
 * Enveloppe fine autour de WebUSBReceiptPrinter : connexion
 * (déclenchée par un clic utilisateur, obligatoire côté navigateur),
 * reconnexion automatique via l'appareil mémorisé, et impression.
 * Pas testable sans matériel réel - ce module se limite à appeler
 * l'API documentée de la bibliothèque, sans logique métier propre
 * au-delà du choix connexion/repli.
 */
export function createThermalPrinterController(WebUSBReceiptPrinter, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  const printer = new WebUSBReceiptPrinter();
  let deviceInfo = null;

  const STORAGE_KEY = 'foodatoi-thermal-printer-device';

  printer.addEventListener('connected', (device) => {
    deviceInfo = device;
    if (storage) {
      storage.setItem(STORAGE_KEY, JSON.stringify(device));
    }
  });

  function tryAutoReconnect() {
    if (!storage) return;
    const saved = storage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        printer.reconnect(JSON.parse(saved));
      } catch (err) {
        // Appareil non retrouvé (débranché, changé) - pas grave,
        // l'utilisateur reconnectera manuellement au besoin, mais on
        // trace quand même (repris par le filet global console.warn).
        console.warn('[FOODATOI] Reconnexion imprimante impossible:', err);
      }
    }
  }

  async function connect() {
    await printer.connect();
    return deviceInfo;
  }

  function isConnected() {
    return Boolean(deviceInfo);
  }

  function getDeviceInfo() {
    return deviceInfo;
  }

  function printBytes(bytes) {
    if (!deviceInfo) {
      throw new Error('PRINTER_NOT_CONNECTED');
    }
    return printer.print(bytes);
  }

  return { connect, tryAutoReconnect, isConnected, getDeviceInfo, printBytes };
}
