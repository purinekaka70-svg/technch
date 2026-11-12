import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Pay form posts a normalized phone after hotspot verification and shows STK feedback', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const cards = [];
  const makeElement = () => ({
    textContent: '', value: '', disabled: false, attributes: {}, dataset: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { listeners.set(this.id || name, callback); },
    scrollIntoView() {}, focus() {}, closest() { return { firstChild: { textContent: '' } }; }
  });
  const grid = { replaceChildren() { cards.length = 0; }, append(card) { cards.push(card); }, innerHTML: '' };
  const modal = { showModal() {}, close() {} };
  const elements = new Map([
    ['#planGrid', grid], ['#purchaseModal', modal], ['#modalName', makeElement()],
    ['#modalReceiptLabel', makeElement()], ['.choice', Object.assign(makeElement(), { firstChild: { textContent: '' } })],
    ['#modalPrice', makeElement()], ['#modalDescription', makeElement()], ['#modalPhone', makeElement()],
    ['#modalPay', Object.assign(makeElement(), { id: 'modalPay' })],
    ['#modalStatus', makeElement()], ['#modalStatusText', makeElement()],
    ['#paymentForm', Object.assign(makeElement(), { id: 'paymentForm' })], ['.close', makeElement()]
  ]);
  const requests = [];
  let packageAttempts = 0;
  let contextAttempts = 0;
  let testNow = 0;
  const document = {
    querySelector(selector) { return elements.get(selector) || null; },
    querySelectorAll(selector) { return selector === '.plan' ? cards : []; },
    createElement(tag) {
      if (tag !== 'article') throw new Error(`Unexpected element ${tag}`);
      return { dataset: {}, classList: { toggle() {} }, querySelector: () => makeElement() };
    },
    body: { append() {} }
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (url === '/api/packages') {
      packageAttempts++;
      if (packageAttempts === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => [{ id: 'package-10', name: '1 Hour', price_kes: 10, duration_minutes: 60 }] };
    }
    if (url === '/api/mikrotik/context') {
      contextAttempts++;
      if (contextAttempts === 1) return { ok: false, status: 503, json: async () => ({ error: 'temporary failure' }) };
      return { ok: true, json: async () => ({ portalToken: 'a'.repeat(64) }) };
    }
    if (url === '/api/pay') return { ok: true, status: 202, json: async () => ({ success: true, checkoutRequestId: 'checkout-1', statusToken: 'b'.repeat(64) }) };
    if (String(url).startsWith('/api/payments/status')) return { ok: true, json: async () => ({ status: 'PENDING' }) };
    throw new Error(`Unexpected request: ${url}`);
  };

  runInNewContext(source, {
    document, fetch, location: { search: '?gateway=mikrotik&clientmac=aa:bb:cc:dd:ee:ff&clientip=192.0.2.1', origin: 'https://example.test', pathname: '/' },
    history: { replaceState() {} }, URLSearchParams, Date: { now: () => (testNow += 60_000) }, setTimeout: (callback, delay) => setTimeout(callback, delay === 3000 ? 0 : delay), clearTimeout, AbortController,
    encodeURIComponent, console
  });
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(cards.length, 1);
  cards[0].onclick();
  elements.get('#modalPhone').value = '0115613332';
  const submit = listeners.get('paymentForm');
  assert.equal(typeof submit, 'function');

  const pending = submit({ preventDefault() {} });
  assert.equal(elements.get('#modalPay').textContent, 'Checking device...');
  assert.equal(elements.get('#modalPay').disabled, true);
  assert.match(elements.get('#modalStatusText').textContent, /Verifying the connected Wi-Fi device/);
  await pending;

  assert.deepEqual(new Set(requests.map(request => request.url)), new Set(['/api/packages', '/api/mikrotik/context', '/api/pay', `/api/payments/status?token=${'b'.repeat(64)}`]));
  assert.equal(packageAttempts, 2, 'package fetch retries a transient server failure');
  assert.equal(contextAttempts, 2, 'hotspot verification retries a transient server failure');
  const payRequest = requests.find(request => request.url === '/api/pay');
  assert.equal(payRequest.options.method, 'POST');
  assert.deepEqual(JSON.parse(payRequest.options.body), { packageId: 'package-10', phone: '254115613332', portalToken: 'a'.repeat(64), packageName: '1 Hour' });
  assert.match(elements.get('#modalStatusText').textContent, /Check your phone for STK Push - Enter PIN|still being confirmed/);
  assert.equal(elements.get('#modalPay').textContent, 'Payment submitted');
  assert.equal(elements.get('#modalPay').disabled, true);
});
