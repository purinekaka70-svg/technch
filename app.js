const grid = document.querySelector('#planGrid');
const modal = document.querySelector('#purchaseModal');
const fmt = value => `KSh ${Number(value).toLocaleString('en-KE')}`;
const duration = minutes => minutes === 90 ? '1 hour 30 minutes' : minutes >= 1440 ? `${minutes / 1440} days` : minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;
let selected, portalToken = null, portalError = null, portalReady = Promise.resolve(), portalTokenCreatedAt = 0;
let paymentState = 'idle';
let hotspotLoginAttempt = null;
let recoveryMode = false;
const packageCacheKey = 'technchPackageCatalogue';
// Render the current public catalogue immediately while the live API refreshes.
// IDs match the live Firestore plans; the server remains authoritative for checkout.
const fallbackPackages = [
  { id: '1d010ddb-70cf-4337-94d4-3f34c71ba9c6', name: '1 Hour', price_kes: 10, duration_minutes: 60, is_active: true },
  { id: 'e3fed868-a064-4cf4-9f6b-62fed59358ee', name: '1.5 Hours', price_kes: 15, duration_minutes: 90, is_active: true },
  { id: '7651a14d-0a72-4a80-af3b-ff5666edb9e3', name: '4 Hours', price_kes: 20, duration_minutes: 240, is_active: true },
  { id: '8a1b262c-e720-4b79-af60-39d5c4c1e67c', name: '6 Hours', price_kes: 30, duration_minutes: 360, is_active: true },
  { id: 'be9477d3-4943-4d17-840f-cb59bd08bac1', name: '12 Hours', price_kes: 60, duration_minutes: 720, is_active: true, is_popular: true },
  { id: 'aa6a0b6b-3995-45ff-a1b4-f05f2dd335cb', name: '24 Hours', price_kes: 80, duration_minutes: 1440, is_active: true },
  { id: 'bd4c9ad7-803e-421d-83a8-32b7d40d8287', name: 'Weekly', price_kes: 300, duration_minutes: 10080, is_active: true },
  { id: '2446f4cb-c23a-457d-8874-8804c1a60ef8', name: 'Monthly', price_kes: 800, duration_minutes: 43200, is_active: true, is_best_value: true }
];

function readPackageCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(packageCacheKey) || 'null');
    return Array.isArray(cached?.packages) && Date.now() - cached.savedAt < 24 * 60 * 60_000 ? cached.packages : null;
  } catch { return null; }
}

function writePackageCache(packages) {
  try { localStorage.setItem(packageCacheKey, JSON.stringify({ savedAt: Date.now(), packages })); } catch { /* private browsing may disable storage */ }
}

function submitHotspotLogin() {
  if (!hotspotLoginAttempt) return;
  setPaymentStatus('Payment confirmed. Sending this device to the MikroTik sign-in page…', true);
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = hotspotLoginAttempt.url;
  for (const [name, value] of Object.entries({
    username: hotspotLoginAttempt.username,
    password: hotspotLoginAttempt.password,
    dst: `${location.origin}/?connected=1`
  })) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

function setPaymentStatus(message, loading = false, isError = false) {
  document.querySelector('#modalStatusText').textContent = message;
  const status = document.querySelector('#modalStatus');
  status.setAttribute('aria-busy', String(loading));
  status.classList.toggle('error', isError);
  const button = document.querySelector('#modalPay');
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', String(loading));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestPortalContext(endpoint, body) {
  // Do one bounded attempt here. The caller already retries when the customer
  // taps Pay, so an automatic second request only makes a slow captive session
  // wait twice before the customer can act.
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, 15000);
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.portalToken) return result.portalToken;
    throw new Error(result.error || 'The hotspot could not verify this device.');
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Hotspot check timed out. Confirm this phone is still connected to Jamii WiFi, then retry.');
    throw error || new Error('The hotspot could not verify this device. Tap Pay to retry.');
  }
}

function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

const params = new URLSearchParams(location.search);
const connected = params.get('connected') === '1';
const fas = params.get('fas');
const mikrotikPortal = params.get('gateway') === 'mikrotik';
const clientMac = params.get('clientmac');
const clientIp = params.get('clientip');
if (connected) {
  history.replaceState({}, '', location.pathname);
  const notice = document.createElement('p');
  notice.className = 'connection-success';
  notice.setAttribute('role', 'status');
  notice.textContent = 'You are connected to Jamii WiFi. You can now browse the internet.';
  document.querySelector('main')?.prepend(notice);
}
if (fas) {
  history.replaceState({}, '', location.pathname);
  portalReady = requestPortalContext('/api/opennds/context', { fas })
    .then(value => { portalToken = value; portalTokenCreatedAt = Date.now(); portalError = null; })
    .catch(error => { portalError = error.message; });
} else if (mikrotikPortal) {
  history.replaceState({}, '', location.pathname);
  portalReady = requestPortalContext('/api/mikrotik/context', { clientMac, clientIp })
    .then(value => { portalToken = value; portalTokenCreatedAt = Date.now(); portalError = null; })
    .catch(error => { portalError = error.message; });
}

async function refreshPortalContext() {
  let endpoint, body;
  if (fas) { endpoint = '/api/opennds/context'; body = { fas }; }
  else if (mikrotikPortal) { endpoint = '/api/mikrotik/context'; body = { clientMac, clientIp }; }
  else throw new Error('Reconnect to the hotspot sign-in page before trying again.');
  portalToken = await requestPortalContext(endpoint, body);
  portalTokenCreatedAt = Date.now();
  portalError = null;
}

function openPackage(item) {
  recoveryMode = false;
  document.querySelector('#modalReceiptLabel').hidden = true;
  document.querySelector('#modalPhone').closest('label').firstChild.textContent = 'M-Pesa phone number';
  document.querySelector('.choice').hidden = false;
  selected = item;
  document.querySelectorAll('.plan').forEach(card => card.classList.toggle('selected', card.dataset.packageId === item.id));
  document.querySelector('#modalName').textContent = item.name;
  document.querySelector('#modalPrice').textContent = fmt(item.price_kes);
  document.querySelector('#modalDescription').textContent = `Internet access for ${duration(item.duration_minutes)}`;
  const payButton = document.querySelector('#modalPay');
  if (paymentState === 'login_ready') {
    payButton.disabled = false;
    payButton.textContent = 'Connect to Wi-Fi';
    setPaymentStatus('Payment received. Tap Connect to Wi-Fi to finish signing this device in.');
  } else if (paymentState === 'idle') {
    payButton.disabled = false;
    payButton.textContent = `Pay ${fmt(item.price_kes)}`;
    setPaymentStatus(mikrotikPortal
      ? 'If the hotspot agent is offline, confirmed payment will stay queued until it reconnects. Do not pay twice.'
      : 'Enter your M-Pesa PIN only in the official prompt on your phone. Never share it here.');
  } else {
    payButton.disabled = !['idle', 'failed'].includes(paymentState);
    payButton.textContent = paymentState === 'failed' ? `Try again · ${fmt(item.price_kes)}` : paymentState === 'pending' || paymentState === 'starting' ? 'Payment in progress' : paymentState === 'confirmed' ? 'Payment confirmed' : 'Check payment status';
  }
  modal.showModal();
}

function renderPackages(packages) {
  grid.replaceChildren();
  if (!packages.length) {
    grid.innerHTML = '<p>No internet packages are available right now. Please contact the Wi-Fi administrator.</p>';
    return;
  }
  packages.forEach(item => {
    const card = document.createElement('article');
    card.dataset.packageId = item.id;
    card.tabIndex = 0;
    card.className = `plan ${item.is_popular ? 'popular' : ''} ${item.is_best_value ? 'best' : ''}`;
    const badge = item.is_popular ? 'Popular' : item.is_best_value ? 'Best value' : '';
    card.innerHTML = `${badge ? `<span>${badge}</span>` : ''}<i aria-hidden="true">Wi-Fi</i><h3></h3><b>${fmt(item.price_kes)}</b><p>${duration(item.duration_minutes)}</p><button type="button">Buy Now</button>`;
    card.querySelector('h3').textContent = item.name;
    card.onclick = () => openPackage(item);
    const buyButton = card.querySelector('button');
    buyButton.onclick = event => {
      event.stopPropagation();
      openPackage(item);
    };
    card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPackage(item); } };
    grid.append(card);
  });
}

async function loadPackages() {
  const cachedPackages = readPackageCache() || fallbackPackages;
  if (cachedPackages) renderPackages(cachedPackages);
  else grid.innerHTML = '<p role="status" aria-live="polite">Loading packages…</p>';
  try {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchWithTimeout('/api/packages', { headers: { Accept: 'application/json' } }, 8000);
        if (!response.ok) {
          const error = new Error(response.status === 429 ? 'The package service is busy.' : 'Packages could not be loaded.');
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
        } else {
          const packages = await response.json();
          writePackageCache(packages);
          renderPackages(packages);
          return;
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (cachedPackages) return;
    throw lastError || new Error('Packages could not be loaded.');
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Loading packages timed out. Check your connection and try again.' : error.message || 'Packages could not be loaded. Check your connection and try again.';
    grid.replaceChildren();
    const notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', loadPackages);
    grid.append(notice, retry);
  }
}

document.querySelector('.close').addEventListener('click', () => modal.close());
loadPackages();

const paymentForm = document.querySelector('#paymentForm');
const payButton = document.querySelector('#modalPay');
async function restorePaidAccess(event) {
  event.preventDefault();
  const phone = normalizeKenyanPhone(document.querySelector('#modalPhone').value);
  const receipt = document.querySelector('#modalReceipt').value.trim();
  if (!phone) {
    setPaymentStatus('Enter the phone number used for the M-Pesa payment.', false, true);
    document.querySelector('#modalPhone').focus();
    return;
  }
  if (!receipt) {
    setPaymentStatus('Enter the M-Pesa receipt from the payment confirmation message.', false, true);
    document.querySelector('#modalReceipt').focus();
    return;
  }
  if (!mikrotikPortal) {
    setPaymentStatus('Reopen this page from the Jamii WiFi sign-in screen on the paid device, then choose Restore access.', false, true);
    return;
  }
  payButton.disabled = true;
  payButton.textContent = 'Checking payment…';
  setPaymentStatus('Verifying the payment and this connected device…', true);
  try {
    await portalReady;
    if (portalError) throw new Error(portalError);
  if (!portalToken) throw new Error('Reconnect to Jamii WiFi and reopen its sign-in page on this device.');
    const response = await fetchWithTimeout('/api/payments/recover-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalToken, phone, receipt })
    }, 15000);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not restore this paid access.');
    hotspotLoginAttempt = result.mikrotikLogin;
    paymentState = 'login_ready';
    payButton.disabled = false;
    payButton.textContent = 'Connect to Wi-Fi';
    setPaymentStatus('Payment verified. Tap Connect to Wi-Fi to sign this device in.');
  } catch (error) {
    payButton.disabled = false;
    payButton.textContent = 'Try restore access';
    setPaymentStatus(`${error.message} Do not pay again.`, false, true);
  }
}

const handlePaymentSubmit = async event => {
  event.preventDefault();
  if (hotspotLoginAttempt) {
    submitHotspotLogin();
    return;
  }
  if (recoveryMode) {
    await restorePaidAccess(event);
    return;
  }
  console.log('Pay clicked');
  if (paymentState !== 'idle') {
    setPaymentStatus(paymentState === 'pending' || paymentState === 'starting' || paymentState === 'verifying'
      ? 'A payment request is already being processed. Check your phone and wait for its result.'
      : 'This checkout attempt has already been used. Reopen the hotspot sign-in page to try again.');
    return;
  }
  paymentState = 'verifying';
  payButton.disabled = true;
  payButton.textContent = 'Checking device...';
  setPaymentStatus('Verifying the connected Wi-Fi device...', true);
  const phone = normalizeKenyanPhone(document.querySelector('#modalPhone').value);
  console.log('Phone normalized', phone || '(invalid)');
  const restorePayButton = message => {
    paymentState = 'idle';
    setPaymentStatus(message, false, true);
    payButton.textContent = selected ? `Pay ${fmt(selected.price_kes)}` : 'Choose a package';
    payButton.disabled = false;
    document.querySelector('#modalStatus').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  if (!selected) { restorePayButton('Select an internet package before paying.'); return; }
  if (!phone) {
    restorePayButton('Enter a valid Kenyan M-Pesa number, starting with 01 or 07.');
    document.querySelector('#modalPhone').focus();
    return;
  }
  // Reuse the context already fetched while the page loaded. Refresh only if
  // that request failed or the 30-minute context is close to expiry.
  await portalReady;
  if (portalError || !portalToken || Date.now() - portalTokenCreatedAt > 25 * 60_000) {
    setPaymentStatus('Refreshing this device’s hotspot session…', true);
    try { await refreshPortalContext(); }
    catch (error) { restorePayButton(error.message || portalError || 'Could not refresh the hotspot session. Reopen the Wi-Fi sign-in page and try again.'); return; }
  }
  if (!portalToken) { restorePayButton('Join Jamii WiFi and open its sign-in page to buy access for this device.'); return; }
  paymentState = 'starting';
  payButton.textContent = 'Sending STK...';
  setPaymentStatus('Sending STK...', true);
  try {
    console.log('Calling /api/pay');
    const response = await fetchWithTimeout('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: selected.id, phone, portalToken, packageName: selected.name }) }, 35000);
    let result = {};
    try { result = await response.json(); } catch { /* preserve the HTTP result for safe retry handling */ }
    console.log('API response', { status: response.status, ok: response.ok, body: result });
    if (!response.ok) {
      const message = result.error || 'Could not start payment.';
      const definitelyNotStarted = result.paymentStarted === false || result.retryable === true || /CloudPay authentication failed|CloudPay rejected the consumer credentials|CloudPay OAuth failed|CloudPay OAuth response did not include an access token/i.test(message);
      if (response.status < 500 || response.status === 503 || definitelyNotStarted) {
        if (definitelyNotStarted) {
          try { await refreshPortalContext(); }
          catch (error) {
            restorePayButton(`${message} No payment prompt was started. Reopen the hotspot sign-in page before retrying.`);
            payButton.disabled = true;
            return;
          }
        }
        restorePayButton(definitelyNotStarted ? `${message}. No M-Pesa prompt was started. Correct the CloudPay credentials or tap Pay to retry.` : message);
        return;
      }
      paymentState = 'uncertain';
      payButton.textContent = 'Check payment status';
      setPaymentStatus(`${message} Check your phone before trying again. Do not submit another payment until you know whether this request started.`, false, true);
      return;
    }
    paymentState = 'pending';
    payButton.textContent = 'Payment in progress';
    console.log('STK sent', result.checkoutRequestId);
    setPaymentStatus('Check your phone for STK Push - Enter PIN', true);
    // The gateway recovery job runs every five minutes; leave time for its
    // next retry and the local MikroTik agent poll before stopping checkout.
    const deadline = Date.now() + 8 * 60_000;
    let paymentConfirmed = false;
    let lastActivationNotice = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      let check;
      try { check = await fetchWithTimeout(`/api/payments/status?token=${encodeURIComponent(result.statusToken)}`, { cache: 'no-store' }, 10000); }
      catch { continue; }
      if (!check.ok) continue;
      const state = await check.json();
      if (state.status === 'FAILED') {
        paymentState = 'failed';
        payButton.disabled = true;
        payButton.textContent = 'Refreshing checkout…';
        setPaymentStatus(`${state.failureMessage || 'CloudPay reported that the payment was cancelled or declined.'} Refreshing this device’s checkout so you can retry or choose another package…`, true, true);
        try {
          await refreshPortalContext();
          paymentState = 'idle';
          payButton.disabled = false;
          payButton.textContent = selected ? `Try again · ${fmt(selected.price_kes)}` : 'Try again';
          setPaymentStatus(`${state.failureMessage || 'Payment was not completed.'} You can try again or choose another package.`, false, true);
        } catch (error) {
          paymentState = 'idle';
          payButton.disabled = true;
          payButton.textContent = 'Reconnect to retry';
          setPaymentStatus(`${error.message} Reopen the hotspot sign-in page, or contact support if you were charged.`, false, true);
        }
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE' && state.mikrotikLogin) {
        hotspotLoginAttempt = state.mikrotikLogin;
        paymentState = 'login_ready';
        payButton.disabled = false;
        payButton.textContent = 'Connect to Wi-Fi';
        setPaymentStatus('Payment received. Tap Connect to Wi-Fi to finish signing this device in.');
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE') {
        paymentState = 'confirmed';
        payButton.textContent = 'Payment confirmed';
        setPaymentStatus('Payment confirmed. Your Wi-Fi is now active.');
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'GATEWAY_FAILED') {
        paymentConfirmed = true;
        if (Date.now() - lastActivationNotice >= 15000) {
          setPaymentStatus('Payment is confirmed, but the hotspot has not granted access yet. Keep this page open and reconnect this device to Jamii WiFi if needed. The agent will retry automatically; do not pay again.', true, true);
          lastActivationNotice = Date.now();
        }
        continue;
      }
      if (state.status === 'SUCCESS') {
        paymentConfirmed = true;
        if (state.session === 'WAITING_GATEWAY') {
          const now = Date.now();
          if (now - lastActivationNotice >= 15000) {
          setPaymentStatus('Payment confirmed. Your Wi-Fi access is queued and will activate when the hotspot agent reconnects. Keep your M-Pesa receipt; do not pay again.', true);
            lastActivationNotice = now;
          }
        } else {
          setPaymentStatus('Payment confirmed. Connecting your device to Wi-Fi...', true);
        }
      }
    }
    if (paymentState === 'pending') {
      paymentState = paymentConfirmed ? 'activation_pending' : 'timeout';
      payButton.textContent = paymentConfirmed ? 'Payment received' : 'Payment submitted';
      setPaymentStatus(paymentConfirmed
        ? 'Payment confirmed. Your Wi-Fi access is still queued for the hotspot agent. Keep your M-Pesa receipt; do not pay again.'
        : 'This payment is still being confirmed. Do not submit another payment. If Wi-Fi does not activate, contact support with your M-Pesa message.', false, true);
    }
  } catch (error) {
    paymentState = 'uncertain';
    payButton.textContent = 'Check payment status';
    setPaymentStatus('We could not confirm whether the payment request started. Check your phone and do not submit another payment until you know its status.', false, true);
  } finally {
    payButton.disabled = !['idle', 'failed', 'login_ready'].includes(paymentState);
  }
};

// Some captive portal webviews swallow the form's submit event on a button tap.
// Handle the tap itself and cancel its default submit; keep submit for keyboard users.
paymentForm.addEventListener('submit', handlePaymentSubmit);
payButton.addEventListener('click', event => {
  event.preventDefault();
  handlePaymentSubmit(event);
});

document.querySelector('#changePackage')?.addEventListener('click', () => {
  if (paymentState !== 'idle') {
    setPaymentStatus('Wait for the current payment result before changing packages.', true);
    return;
  }
  modal.close();
  document.querySelector('#planGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.querySelector('#restoreAccess')?.addEventListener('click', () => {
  recoveryMode = true;
  paymentState = 'idle';
  hotspotLoginAttempt = null;
  selected = null;
  document.querySelector('#modalName').textContent = 'Restore paid Wi-Fi access';
  document.querySelector('#modalPrice').textContent = 'No new payment';
  document.querySelector('#modalDescription').textContent = 'Enter the M-Pesa phone number and receipt for this same device.';
  document.querySelector('.choice').hidden = true;
  document.querySelector('#modalPhone').closest('label').firstChild.textContent = 'M-Pesa phone number';
  document.querySelector('#modalReceiptLabel').hidden = false;
  payButton.disabled = false;
  payButton.textContent = 'Restore access';
  setPaymentStatus(mikrotikPortal ? 'Restore the payment made for this connected device; no new charge will be started.' : 'Open this page from the Jamii WiFi sign-in screen on the paid device first.');
  modal.showModal();
});
const supportPhone = '0114 562309';
const supportDigits = '254114562309';
const supportLink = document.querySelector('.whatsapp-support');
const callLink = document.querySelector('.support-call');
if (supportLink) {
  supportLink.href = `https://wa.me/${supportDigits}?text=Hello%2C%20I%20need%20help%20with%20Jamii%20WiFi.`;
  supportLink.setAttribute('aria-label', `Chat with Jamii WiFi support on WhatsApp at ${supportPhone}`);
  const phoneText = supportLink.querySelector('span');
  if (phoneText) phoneText.textContent = supportPhone;
}
if (callLink) {
  callLink.href = `tel:+${supportDigits}`;
  callLink.setAttribute('aria-label', `Call Jamii WiFi support at ${supportPhone}`);
  callLink.lastChild.textContent = `Call support: ${supportPhone}`;
}
