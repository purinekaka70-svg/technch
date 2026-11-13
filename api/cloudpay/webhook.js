import { createHmac, timingSafeEqual } from 'node:crypto';
import { firebaseDb } from '../../lib/firebase-db.js';
import { applyCloudPayResult } from '../../lib/cloudpay-result.js';
import { cloudPayPayment, normalizeCloudPayResult } from '../../lib/cloudpay-normalize.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = process.env.CLOUDPAY_WEBHOOK_SECRET || '';
  if (!secret) return res.status(503).send('Webhook is not configured');

  const body = await rawBody(req);
  const signature = String(req.headers['x-cloudpay-signature'] || '');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!/^[a-f0-9]{64}$/i.test(signature)) return res.status(401).send('Invalid signature');
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).send('Invalid signature');

  let event;
  try { event = JSON.parse(body.toString('utf8')); }
  catch { return res.status(400).send('Invalid JSON'); }
  const eventType = String(event.event || req.headers['x-cloudpay-event'] || '');
  const paymentEvents = new Set(['payment.completed', 'payment.failed']);
  if (!paymentEvents.has(eventType)) {
    // CloudPay dashboard connection checks may send a signed test event with
    // no transaction reference. Acknowledge it, but never treat it as payment.
    console.info('CloudPay webhook acknowledged non-payment event', { eventType: eventType || 'unspecified' });
    return res.status(200).send('Acknowledged');
  }
  const payment = cloudPayPayment(event);
  const normalized = {
    ...normalizeCloudPayResult(event),
    event: eventType,
    reference: payment.reference || event.reference,
    channel: payment.channel || event.channel,
    currency: payment.currency || event.currency,
    amount: payment.amount ?? event.amount
  };
  if (!normalized.reference || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(normalized.status)) {
    // Signed connectivity probes can label themselves as payment events while
    // omitting transaction fields. Acknowledge without changing payment state.
    console.info('CloudPay webhook acknowledged event without transaction fields', { eventType, hasReference: Boolean(normalized.reference), status: normalized.status || null });
    return res.status(200).send('Acknowledged; no transaction processed');
  }

  const db = firebaseDb();
  try {
    const result = await applyCloudPayResult(db, normalized);
    if (result === 'not_found') return res.status(503).send('Payment record not ready; retry webhook');
  } catch { return res.status(503).send('Could not record payment result; retry webhook'); }
  return res.status(200).send('Accepted');
}
