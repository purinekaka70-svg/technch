import { createHash } from 'node:crypto';
import { firebaseDb } from '../../lib/firebase-db.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId, mikrotikHotspotLoginUrl, mikrotikLoginCredentials } from '../../lib/gateway.js';
import { cloudPayBase, cloudPayToken } from '../../lib/cloudpay-api.js';
import { applyCloudPayResult } from '../../lib/cloudpay-result.js';
import { cloudPayPayment, cloudPayReceipt, cloudPayReceipts, cloudPayStatus, normalizeCloudPayResult } from '../../lib/cloudpay-normalize.js';

const kenyaPhone = value => String(value || '').replace(/\D/g, '').replace(/^0/, '254');
const normalizeReceipt = value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const paymentReceipts = payment => [...new Set([
  normalizeReceipt(payment.mpesa_receipt_number),
  ...cloudPayReceipts(payment.raw_callback)
].filter(Boolean))];

function transactionRows(value, rows = []) {
  if (Array.isArray(value)) {
    for (const item of value) transactionRows(item, rows);
    return rows;
  }
  if (!value || typeof value !== 'object') return rows;
  const payment = cloudPayPayment(value);
  if (payment && typeof payment === 'object' && !Array.isArray(payment)
    && payment.amount != null && cloudPayReceipt(payment)
    && (payment.reference || payment.transactionId || payment.id)) rows.push(payment);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') transactionRows(child, rows);
  }
  return rows;
}

async function reconcilePayments(db, phone, macAddress, receipt) {
  const { data: candidates, error } = await db.from('payments').select('id,phone,checkout_request_id,status,mpesa_receipt_number,amount_kes')
    .eq('mac_address', macAddress).in('status', ['PENDING', 'SUCCESS', 'FAILED']).limit(50);
  if (error) return true;
  const candidatesNeedingLookup = (candidates || []).filter(payment =>
    kenyaPhone(payment.phone) === phone && (payment.status !== 'SUCCESS' || !payment.mpesa_receipt_number)
  );
  if (!candidatesNeedingLookup.length) return false;
  const base = cloudPayBase();
  if (!base) return true;
  let token;
  try { token = await cloudPayToken(); }
  catch { return true; }
  let providerUnavailable = false;

  for (const payment of candidatesNeedingLookup.filter(item => item.checkout_request_id)) {
    try {
      const response = await fetch(`${base}/payments/status/${encodeURIComponent(payment.checkout_request_id)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) { providerUnavailable = true; continue; }
      const result = await response.json();
      const providerResult = cloudPayPayment(result);
      const status = cloudPayStatus(providerResult.status);
      if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) continue;
      await applyCloudPayResult(db, {
        ...normalizeCloudPayResult(result, payment.checkout_request_id),
        status,
        event: status === 'COMPLETED' ? 'payment.completed' : 'payment.failed',
        channel: providerResult.channel || 'MPESA',
        currency: providerResult.currency || 'KES'
      }, { trustedStatusLookup: true });
    } catch {
      // Keep recovery safe when CloudPay is unavailable; never infer payment from the user's receipt alone.
      providerUnavailable = true;
    }
  }

  // If the STK request timed out after CloudPay accepted it, we may have no
  // CloudPay reference saved locally. Recover only from CloudPay's authenticated
  // transaction list and require an exact receipt, phone, amount, and completed status.
  if (candidatesNeedingLookup.some(payment => !payment.checkout_request_id)) {
    try {
      const response = await fetch(`${base}/transactions`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return true;
      const result = await response.json();
      const transactions = transactionRows(result);
      for (const payment of candidatesNeedingLookup.filter(item => !item.checkout_request_id)) {
        const transaction = transactions.find(item => {
          const status = cloudPayStatus(item.status);
          const txReceipt = cloudPayReceipt(item);
          const txPhone = kenyaPhone(item.phone || item.phoneNumber || item.msisdn || item.mobileNumber);
          const channel = String(item.channel || item.paymentMethod || item.method || '').toUpperCase();
          const currency = String(item.currency || 'KES').toUpperCase();
          return status === 'COMPLETED' && txReceipt === receipt && txPhone === phone
            && Number(item.amount) === Number(payment.amount_kes)
            && (!channel || channel.includes('MPESA')) && currency === 'KES';
        });
        if (!transaction) continue;
        const reference = String(transaction.reference || transaction.transactionId || transaction.id || `receipt:${receipt}`);
        const { error: saveError } = await db.from('payments').update({ checkout_request_id: reference })
          .eq('id', payment.id).in('status', ['PENDING', 'FAILED', 'SUCCESS']);
        if (saveError) continue;
        await applyCloudPayResult(db, {
          ...transaction,
          reference,
          status: 'COMPLETED',
          event: 'payment.completed',
          channel: transaction.channel || 'MPESA',
          currency: transaction.currency || 'KES',
          receipt
        }, { trustedStatusLookup: true });
      }
    } catch {
      // The regular status lookup remains available if CloudPay's list endpoint is unavailable.
      providerUnavailable = true;
    }
  }
  return providerUnavailable;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isMikrotikAgentMode() || !isGatewayConfigured()) return res.status(503).json({ error: 'MikroTik access recovery is not configured.' });
  const { portalToken, phone, receipt } = req.body || {};
  if (!/^[a-f0-9]{64}$/.test(portalToken || '')) return res.status(400).json({ error: 'Reopen the sign-in page from Technch- HOTSPOT before restoring access.' });
  const normalizedPhone = kenyaPhone(phone);
  const normalizedReceipt = normalizeReceipt(receipt);
  if (!/^(?:254(?:1|7)\d{8})$/.test(normalizedPhone) || !/^[A-Z0-9]{6,20}$/.test(normalizedReceipt)) {
    return res.status(400).json({ error: 'Enter the M-Pesa phone number and receipt exactly as shown in the payment message.' });
  }

  const db = firebaseDb();
  const tokenHash = createHash('sha256').update(portalToken).digest('hex');
  const { data: currentContext, error: contextError } = await db.from('mikrotik_portal_contexts')
    .select('gateway_id,mac_address,hotspot_login_url').eq('token_hash', tokenHash).eq('gateway_id', mikrotikGatewayId())
    .gt('expires_at', new Date().toISOString()).maybeSingle();
  if (contextError) return res.status(503).json({ error: 'Could not verify this hotspot device. Reopen its sign-in page and try again.' });
  if (!currentContext) return res.status(400).json({ error: 'Reconnect to Technch- HOTSPOT and reopen its sign-in page on this same device.' });

  // A webhook can be delayed or missed. Ask CloudPay about this customer's
  // pending transactions on this exact device before declaring their receipt unknown.
  const providerUnavailable = await reconcilePayments(db, normalizedPhone, currentContext.mac_address, normalizedReceipt);

  const paymentFields = 'id,phone,mikrotik_portal_context_id,mpesa_receipt_number,raw_callback';
  const { data: receiptMatches, error: receiptError } = await db.from('payments').select(paymentFields)
    .eq('status', 'SUCCESS').eq('mpesa_receipt_number', normalizedReceipt).limit(20);
  if (receiptError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
  let payment = (receiptMatches || []).find(item => kenyaPhone(item.phone) === normalizedPhone
    && paymentReceipts(item).includes(normalizedReceipt)) || null;
  if (!payment) {
    const { data: successfulPayments, error: paymentError } = await db.from('payments').select(paymentFields)
      .eq('status', 'SUCCESS').eq('phone', normalizedPhone).limit(100);
    if (paymentError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
    payment = (successfulPayments || []).find(item => kenyaPhone(item.phone) === normalizedPhone
      && paymentReceipts(item).includes(normalizedReceipt)) || null;
  }
  // Older records may have stored the phone with a leading zero or country
  // prefix formatting, and some callbacks put the receipt in a nested field.
  // Search a bounded recent success window, then still require exact normalized
  // phone + receipt and validate the original gateway/device below.
  if (!payment) {
    const { data: recentPayments, error: recentError } = await db.from('payments')
      .select(paymentFields).eq('status', 'SUCCESS').order('created_at', { ascending: false }).limit(500);
    if (recentError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
    payment = (recentPayments || []).find(item => kenyaPhone(item.phone) === normalizedPhone
      && paymentReceipts(item).includes(normalizedReceipt)) || null;
  }
  if (!payment) {
    const { data: stillPending, error: pendingError } = await db.from('payments').select('id')
      .eq('status', 'PENDING').eq('phone', normalizedPhone).eq('mac_address', currentContext.mac_address).limit(1);
    if (pendingError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
    if (stillPending?.length) return res.status(409).json({ error: 'CloudPay has not confirmed this payment yet. Do not pay again; wait briefly, then tap Restore access again.' });
    if (providerUnavailable) return res.status(503).json({ error: 'CloudPay could not be reached to verify this receipt. Do not pay again; wait a moment and tap Restore access again.' });
    return res.status(404).json({ error: 'No confirmed payment matches this phone number and M-Pesa receipt on this device. Check the receipt and phone number; do not pay again.' });
  }

  const { data: paidContext, error: paidContextError } = await db.from('mikrotik_portal_contexts')
    .select('gateway_id,mac_address,hotspot_login_url').eq('id', payment.mikrotik_portal_context_id).maybeSingle();
  if (paidContextError) return res.status(503).json({ error: 'Could not verify which hotspot device made this payment.' });
  if (!paidContext || paidContext.gateway_id !== currentContext.gateway_id || paidContext.mac_address !== currentContext.mac_address) {
    return res.status(404).json({ error: 'That payment belongs to a different device. Reopen the sign-in page on the device that made the payment.' });
  }

  const { data: session, error: sessionError } = await db.from('wifi_sessions')
    .select('id,session_status,expiry_time').eq('payment_id', payment.id).maybeSingle();
  if (sessionError) return res.status(503).json({ error: 'Could not load the paid hotspot session.' });
  if (!session) return res.status(409).json({ error: 'Payment is confirmed but hotspot access is still being prepared. Do not pay again; retry shortly.' });
  if (session.session_status !== 'ACTIVE' || Date.parse(session.expiry_time) <= Date.now()) {
    return res.status(409).json({ error: 'Payment is confirmed but this session is not currently active. Do not pay again; contact Wi-Fi support with your M-Pesa receipt.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    success: true,
    mikrotikLogin: { url: mikrotikHotspotLoginUrl(paidContext.hotspot_login_url || currentContext.hotspot_login_url), ...mikrotikLoginCredentials(session.id) }
  });
}
