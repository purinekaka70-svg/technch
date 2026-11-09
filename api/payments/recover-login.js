import { createHash } from 'node:crypto';
import { firebaseDb } from '../../lib/firebase-db.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId, mikrotikLoginCredentials } from '../../lib/gateway.js';

const kenyaPhone = value => String(value || '').replace(/\D/g, '').replace(/^0/, '254');

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
    .select('gateway_id,mac_address').eq('token_hash', tokenHash).eq('gateway_id', mikrotikGatewayId())
    .gt('expires_at', new Date().toISOString()).maybeSingle();
  if (contextError) return res.status(503).json({ error: 'Could not verify this hotspot device. Reopen its sign-in page and try again.' });
  if (!currentContext) return res.status(400).json({ error: 'Reconnect to Technch- HOTSPOT and reopen its sign-in page on this same device.' });

  const { data: payment, error: paymentError } = await db.from('payments')
    .select('id,mikrotik_portal_context_id').eq('status', 'SUCCESS').eq('phone', normalizedPhone)
    .eq('mpesa_receipt_number', normalizedReceipt).maybeSingle();
  if (paymentError) return res.status(503).json({ error: 'Could not verify the payment right now. Try again shortly.' });
  if (!payment) return res.status(404).json({ error: 'Payment not found for this phone and receipt. Check the M-Pesa message; do not pay again.' });

  const { data: paidContext, error: paidContextError } = await db.from('mikrotik_portal_contexts')
    .select('gateway_id,mac_address').eq('id', payment.mikrotik_portal_context_id).maybeSingle();
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
    mikrotikLogin: { url: process.env.MIKROTIK_HOTSPOT_LOGIN_URL, ...mikrotikLoginCredentials(session.id) }
  });
}
