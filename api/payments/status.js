import { firebaseDb } from '../../lib/firebase-db.js';
import { cloudPayBase, cloudPayToken } from '../../lib/cloudpay-api.js';
import { applyCloudPayResult } from '../../lib/cloudpay-result.js';
import { cloudPayPayment, cloudPayStatus, normalizeCloudPayResult } from '../../lib/cloudpay-normalize.js';
import { isMikrotikAgentMode, mikrotikLoginCredentials } from '../../lib/gateway.js';

const failureMessages = {
  '1': 'M-Pesa declined the payment because the wallet balance was insufficient.',
  '1032': 'The M-Pesa prompt was cancelled or timed out. Request a new prompt and approve it on the phone.',
  '1037': 'M-Pesa could not reach the phone. Check that it has network coverage, then request a new prompt.',
  '2001': 'M-Pesa rejected the PIN. Request a new prompt and enter the correct PIN.'
};

function paymentFailureMessage(rawCallback) {
  const code = String(rawCallback?.resultCode ?? rawCallback?.data?.resultCode ?? '');
  return failureMessages[code] || 'CloudPay reported that the payment did not complete. You can try again or choose another package.';
}

async function reconcileWithCloudPay(reference) {
  const base = cloudPayBase();
  if (!base) return;
  try {
    const token = await cloudPayToken();
    const response = await fetch(`${base}/payments/status/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return;
    const result = await response.json();
    const providerResult = cloudPayPayment(result);
    const status = cloudPayStatus(providerResult.status);
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) return;
    await applyCloudPayResult(firebaseDb(), {
      ...normalizeCloudPayResult(result, reference),
      status,
      event: status === 'COMPLETED' ? 'payment.completed' : 'payment.failed',
      channel: providerResult.channel || 'MPESA',
      currency: providerResult.currency || 'KES'
    }, { trustedStatusLookup: true });
  } catch {
    // A temporary provider outage must not turn an unverified payment into success.
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const token = String(req.query?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid checkout reference' });
  const db = firebaseDb();
  let { data, error } = await db.from('payments').select('id,status,checkout_request_id,raw_callback,mikrotik_portal_context_id').eq('status_token', token).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not read payment status' });
  if (!data) return res.status(404).json({ error: 'Payment not found' });
  if (data.status === 'PENDING') {
    await reconcileWithCloudPay(data.checkout_request_id);
    ({ data, error } = await db.from('payments').select('id,status,raw_callback,mikrotik_portal_context_id').eq('status_token', token).maybeSingle());
    if (error) return res.status(500).json({ error: 'Could not read payment status' });
  }
  const { data: session } = await db.from('wifi_sessions').select('id,session_status,expiry_time').eq('payment_id', data.id).maybeSingle();
  const result = { status: data.status, session: session?.session_status || null, expiresAt: session?.expiry_time || null };
  if (data.status === 'FAILED') result.failureMessage = paymentFailureMessage(data.raw_callback);
  if (isMikrotikAgentMode() && data.mikrotik_portal_context_id && session?.session_status === 'ACTIVE') {
    const { data: context } = await db.from('mikrotik_portal_contexts').select('hotspot_login_url').eq('id', data.mikrotik_portal_context_id).maybeSingle();
    result.mikrotikLogin = { url: context?.hotspot_login_url || process.env.MIKROTIK_HOTSPOT_LOGIN_URL, ...mikrotikLoginCredentials(session.id) };
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}
