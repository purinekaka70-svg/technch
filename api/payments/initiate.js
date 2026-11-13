import { firebaseDb } from '../../lib/firebase-db.js';
import { isGatewayConfigured, isMikrotikAgentMode, isTyraxAgentMode, mikrotikGatewayId } from '../../lib/gateway.js';
import { cloudPayBase, cloudPayToken } from '../../lib/cloudpay-api.js';
import { isPortalContextUsable } from '../../lib/portal-context.js';
import { createHash, randomBytes } from 'node:crypto';

const kenyaPhone = phone => String(phone || '').replace(/\D/g, '').replace(/^0/, '254');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { packageId, phone, portalToken } = req.body || {};
  if (!isGatewayConfigured()) return res.status(503).json({ error: 'Wi-Fi access activation is not configured for this router yet. Please contact the Wi-Fi administrator.' });
  if (isTyraxAgentMode()) return res.status(503).json({ error: 'Phone-only device identification requires the openNDS captive portal. The TYRAX router agent cannot identify a device from a phone number.' });
  if (!/^[a-f0-9]{64}$/.test(portalToken || '')) return res.status(400).json({ error: 'Join the hotspot and open its captive portal before purchasing. The connected device is identified automatically.' });
  if (!/^(?:254(?:1|7)\d{8})$/.test(kenyaPhone(phone))) return res.status(400).json({ error: 'Enter a valid Kenyan M-Pesa phone number' });
  if (!packageId) return res.status(400).json({ error: 'Select an available Wi-Fi package' });

  const db = firebaseDb();
  const tokenHash = createHash('sha256').update(portalToken).digest('hex');
  const contextTable = isMikrotikAgentMode() ? 'mikrotik_portal_contexts' : 'opennds_portal_contexts';
  const contextFields = isMikrotikAgentMode() ? 'id,mac_address,client_ip,gateway_id,consumed_at' : 'id,mac_address,consumed_at';
  const { data: context, error: contextError } = await db.from(contextTable).select(`${contextFields},expires_at`).eq('token_hash', tokenHash).maybeSingle();
  if (contextError) {
    console.error('Portal context lookup failed', { code: contextError.code, message: contextError.message });
    return res.status(503).json({ error: 'Hotspot session could not be verified. Please reconnect and try again.' });
  }
  // Firestore distinguishes a missing field from an explicit null. Older
  // portal records may omit consumed_at, so check consumption in JS instead
  // of filtering with Firestore's exact-null query.
  if (!context) return res.status(400).json({ error: 'Hotspot session could not be found. Reopen the Wi-Fi portal and try again.' });
  if (context.consumed_at != null) return res.status(409).json({ error: 'This checkout has already been used. Check your phone for the payment result before trying again.' });
  if (!isPortalContextUsable(context)) return res.status(400).json({ code: 'PORTAL_CONTEXT_EXPIRED', paymentStarted: false, error: 'The hotspot checkout session expired. Refreshing this device…' });
  if (isMikrotikAgentMode()) {
    const gatewayId = mikrotikGatewayId();
    if (!gatewayId || context.gateway_id !== gatewayId) {
      console.error('MikroTik payment rejected: portal gateway identity mismatch', { configuredGatewayId: gatewayId, contextGatewayId: context.gateway_id });
      return res.status(403).json({ error: 'This hotspot session belongs to a different or unconfigured gateway. Reopen the hotspot sign-in page.' });
    }
    const { data: gateway, error: gatewayError } = await db.from('mikrotik_gateways').select('gateway_id').eq('gateway_id', gatewayId).maybeSingle();
    if (gatewayError || !gateway) {
      console.error('MikroTik payment rejected: configured gateway is not registered', { gatewayId, code: gatewayError?.code, message: gatewayError?.message });
      return res.status(503).json({ error: 'The MikroTik gateway is not registered. Please contact the Wi-Fi administrator.' });
    }
  }
  if (!cloudPayBase()) return res.status(503).json({ success: false, error: 'CloudPay mode is not configured. Set CLOUDPAY_ENV explicitly to production or sandbox.' });
  if (!process.env.CLOUDPAY_CONSUMER_KEY || !process.env.CLOUDPAY_CONSUMER_SECRET || !process.env.CLOUDPAY_WEBHOOK_SECRET) return res.status(503).json({ success: false, error: 'CloudPay is not configured yet. Set CLOUDPAY_CONSUMER_KEY, CLOUDPAY_CONSUMER_SECRET, and CLOUDPAY_WEBHOOK_SECRET in Vercel.' });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(packageId))) return res.status(400).json({ error: 'Selected package is unavailable' });
  const { data: plan, error: planError } = await db.from('wifi_packages').select('*').eq('id', packageId).maybeSingle();
  if (planError) return res.status(503).json({ error: 'The package catalogue is temporarily unavailable. Please try again.' });
  if (!plan || !plan.is_active) return res.status(400).json({ error: 'Selected package is unavailable' });

  const statusToken = randomBytes(32).toString('hex');
  const pendingRow = {
    checkout_request_id: null,
    phone: kenyaPhone(phone), package_id: plan.id, amount_kes: plan.price_kes,
    mac_address: context.mac_address, status_token: statusToken, status: 'PENDING',
    [isMikrotikAgentMode() ? 'mikrotik_portal_context_id' : 'portal_context_id']: context.id
  };
  const { data: payment, error: insertError } = await db.from('payments').insert(pendingRow).select('id').single();
  if (insertError) {
    console.error('CloudPay pending payment insert failed', insertError);
    return res.status(500).json({ success: false, error: 'Could not save a pending payment record. Please try again.' });
  }
  try {
    const accessToken = await cloudPayToken();
    // M-Pesa's account reference is limited to 12 characters and the
    // transaction description to 13. Longer values can be rejected before
    // Safaricom sends the customer's STK prompt.
    const transactionReference = `JX${randomBytes(5).toString('hex').toUpperCase()}`;
    const response = await fetch(`${cloudPayBase()}/payments/mpesa/stkpush`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: kenyaPhone(phone), amount: plan.price_kes, transactionReference, description: 'WiFi access' }),
      signal: AbortSignal.timeout(15000)
    });
    let result = {};
    try { result = await response.json(); } catch { /* retain provider HTTP status for a clear error */ }
    const reference = result.data?.reference || result.reference;
    if (!response.ok || result.status !== 'success' || !reference) {
      // A provider 5xx or malformed 2xx can happen after Safaricom accepted
      // the STK request. Keep that payment reconcilable and never tell the
      // customer to start another charge until its status is known.
      const definitelyRejected = !response.ok && response.status < 500;
      await db.from('payments').update({ status: definitelyRejected ? 'FAILED' : 'PENDING', raw_callback: result }).eq('id', payment.id).eq('status', 'PENDING');
      return res.status(502).json({ success: false, retryable: definitelyRejected, paymentStarted: !definitelyRejected, error: result.message || result.error || `CloudPay could not confirm whether the M-Pesa prompt started (${response.status}).` });
    }
    const { error: updateError } = await db.from('payments').update({ checkout_request_id: reference }).eq('id', payment.id).eq('status', 'PENDING');
    if (updateError) {
      console.error('CloudPay reference update failed', updateError);
      return res.status(500).json({ success: false, error: 'CloudPay accepted the payment request, but its reference could not be saved. Check your phone before retrying.' });
    }
    await db.from(contextTable).update({ consumed_at: new Date().toISOString(), payment_id: payment.id }).eq('id', context.id);
    return res.status(202).json({ success: true, checkoutRequestId: reference, statusToken, status: 'PENDING', message: 'STK sent. Check your phone and enter your M-Pesa PIN.' });
  } catch (error) {
    console.error('CloudPay STK request failed', error);
    const oauthFailure = /CloudPay (?:rejected the consumer credentials|OAuth|is not configured|authentication)/i.test(error.message || '');
    await db.from('payments').update({ status: oauthFailure ? 'FAILED' : 'PENDING', raw_callback: { error: error.message || 'CloudPay request failed' } }).eq('id', payment.id).eq('status', 'PENDING');
    return res.status(502).json({ success: false, retryable: oauthFailure, paymentStarted: !oauthFailure, error: error.message || 'Could not connect to CloudPay.' });
  }
}
