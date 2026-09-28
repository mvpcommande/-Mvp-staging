import test from 'node:test';
import assert from 'node:assert/strict';
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import {
  isThermalPrinterSupported,
  buildReceiptBytes,
  createThermalPrinterController
} from './thermalPrinter.mjs';

test('isThermalPrinterSupported reflects navigator.usb presence', () => {
  assert.equal(isThermalPrinterSupported({ usb: {} }), true);
  assert.equal(isThermalPrinterSupported({}), false);
  assert.equal(isThermalPrinterSupported(null), false);
});

test('buildReceiptBytes produces a real, non-empty ESC/POS byte stream', () => {
  const order = {
    order_number: 'FA-1',
    total_cents: 890,
    order_items: [{ product_name: 'Tacos', quantity: 1, options: {}, line_total_cents: 890 }]
  };

  const bytes = buildReceiptBytes(order, ReceiptPrinterEncoder);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 20);
});

test('buildReceiptBytes includes order number, product names, options and total', () => {
  const order = {
    order_number: 'FA-260901-XYZ',
    notes: 'Sans oignons',
    total_cents: 2450,
    order_items: [
      { product_name: 'Menu Kebab', quantity: 1, options: { meat: 'Agneau', sauce: 'Blanche' }, line_total_cents: 1050 },
      { product_name: 'Frites', quantity: 2, options: {}, line_total_cents: 1400 }
    ]
  };

  const bytes = buildReceiptBytes(order, ReceiptPrinterEncoder, { restaurantName: 'CAZ FOOD' });
  const text = Buffer.from(bytes).toString('latin1');

  assert.match(text, /FA-260901-XYZ/);
  assert.match(text, /CAZ FOOD/);
  assert.match(text, /Menu Kebab/);
  assert.match(text, /Frites/);
  assert.match(text, /Agneau/);
  assert.match(text, /Sans oignons/);
  assert.match(text, /24,50/);
});

test('buildReceiptBytes handles an order with no notes and no options gracefully', () => {
  const order = {
    order_number: 'FA-2',
    total_cents: 500,
    order_items: [{ product_name: 'Boisson', quantity: 1, options: {}, line_total_cents: 500 }]
  };

  assert.doesNotThrow(() => buildReceiptBytes(order, ReceiptPrinterEncoder));
});

test('createThermalPrinterController: printBytes throws clearly when nothing is connected', () => {
  class FakeWebUSBReceiptPrinter {
    addEventListener() {}
  }

  const controller = createThermalPrinterController(FakeWebUSBReceiptPrinter, null);
  assert.equal(controller.isConnected(), false);
  assert.throws(() => controller.printBytes(new Uint8Array([1, 2, 3])), /PRINTER_NOT_CONNECTED/);
});

test('createThermalPrinterController: connect() stores device info and enables printing', async () => {
  let connectedHandler;
  let printedBytes = null;

  class FakeWebUSBReceiptPrinter {
    addEventListener(event, handler) {
      if (event === 'connected') connectedHandler = handler;
    }
    async connect() {
      connectedHandler({ manufacturerName: 'Epson', productName: 'TM-T20', serialNumber: '123', language: 'esc-pos' });
    }
    print(bytes) {
      printedBytes = bytes;
    }
  }

  const fakeStorage = (() => {
    const store = {};
    return {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = v; }
    };
  })();

  const controller = createThermalPrinterController(FakeWebUSBReceiptPrinter, fakeStorage);
  await controller.connect();

  assert.equal(controller.isConnected(), true);
  assert.equal(controller.getDeviceInfo().manufacturerName, 'Epson');
  assert.equal(JSON.parse(fakeStorage.getItem('foodatoi-thermal-printer-device')).serialNumber, '123');

  controller.printBytes(new Uint8Array([9, 9]));
  assert.deepEqual(Array.from(printedBytes), [9, 9]);
});
