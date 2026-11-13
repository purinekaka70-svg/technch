import { createHash } from 'node:crypto';
import { firebaseDb } from '../../lib/firebase-db.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId, mikrotikLoginCredentials } from '../../lib/gateway.js';
import { cloudPayBase, cloudPayToken } from '../../lib/cloudpay-api.js';
import { applyCloudPayResult } from '../../lib/cloudpay-result.js';
import { cloudPayPayment, cloudPayReceipt, cloudPayStatus, normalizeCloudPayResult } from '../../lib/cloudpay-normalize.js';

const kenyaPhone = value => String(value || '').replace(/\D/g, '').replace(/^0/, '254');

async function reconcilePayments(db, phone, macAddress) {
  const { data: candidates, error } = await db.from('payments').select('id,checkout_request_id,status,mpesa_receipt_number')
    .eq('phone', phone).eq('mac_address', macAddress).in('status', ['PENDING', 'SUCCESS', 'FAILED']).limit(50);
  const candidatesNeedingLookup = (candidates || []).filter(payment => payment.status !== 'SUCCESS' || !payment.mpesa_receipt_number);
  if (error || !candidatesNeedingLookup.length) return;
  const base = cloudPayBase();
  if (!base) return;
  let token;
  try { token = await cloudPayToken(); }
  catch { return; }

  for (const payment of candidatesNeedingLookup) {
    if (!payment.checkout_request_id) continue;
    try {
      const response = await fetch(`${base}/payments/status/${encodeURIComponent(payment.checkout_request_id)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
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
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isMikrotikAgentMode() || !isGatewayConfigured()) return res.status(503).json({ error: 'MikroTik access recovery is not configured.' });
  const { portalToken, phone, receipt } = req.body || {};
  if (!/^[a-f0-9]{64}$/.test(portalToken || '')) return res.status(400).json({ error: 'Reopen the sign-in page from Technch- HOTSPOT before restoring access.' });
  const normalizedPhone = kenyaPhone(phone);
  const normalizedReceipt = String(receipt || '').trim().toUpperCase();
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
  await reconcilePayments(db, normalizedPhone, currentContext.mac_address);

  const { data: successfulPayments, error: paymentError } = await db.from('payments')
    .select('id,mikrotik_portal_context_id,mpesa_receipt_number,raw_callback').eq('status', 'SUCCESS')
    .eq('phone', normalizedPhone).limit(100);
  if (paymentError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
  const payment = (successfulPayments || []).find(item =>
    String(item.mpesa_receipt_number || cloudPayReceipt(item.raw_callback) || '').trim().toUpperCase() === normalizedReceipt
  ) || null;
  if (!payment) {
    const { data: stillPending, error: pendingError } = await db.from('payments').select('id')
      .eq('status', 'PENDING').eq('phone', normalizedPhone).eq('mac_address', currentContext.mac_address).limit(1);
    if (pendingError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
    if (stillPending?.length) return res.status(409).json({ error: 'CloudPay has not confirmed this payment yet. Do not pay again; wait briefly, then tap Restore access again.' });
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
    mikrotikLogin: { url: paidContext.hotspot_login_url || currentContext.hotspot_login_url || process.env.MIKROTIK_HOTSPOT_LOGIN_URL, ...mikrotikLoginCredentials(session.id) }
  });
}
