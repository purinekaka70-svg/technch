import { expiryFrom } from './packages.js';
import { isMikrotikAgentMode, queueMikrotikRouterCommand, queueOpenNdsAuth } from './gateway.js';
import { normalizeCloudPayResult } from './cloudpay-normalize.js';

async function activate(db, payment, payload) {
  const start = payment.confirmed_at ? new Date(payment.confirmed_at) : new Date();
  const expiry = expiryFrom(payment.wifi_packages, start);
  const receipt = payload.receipt || null;
  if (payment.status !== 'SUCCESS') {
    // A request timeout or delayed provider response may have been recorded as
    // FAILED before CloudPay later confirms that M-Pesa actually completed it.
    const { error } = await db.from('payments').update({ status: 'SUCCESS', mpesa_receipt_number: receipt, raw_callback: payload, confirmed_at: start.toISOString() }).eq('id', payment.id).in('status', ['PENDING', 'FAILED']);
    if (error) throw error;
  } else if (payment.status === 'SUCCESS' && receipt && !payment.mpesa_receipt_number) {
    const { error } = await db.from('payments').update({ mpesa_receipt_number: receipt, raw_callback: payload }).eq('id', payment.id).eq('status', 'SUCCESS');
    if (error) throw error;
  }

  let { data: session } = await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle();
  if (!session) {
    const queuedForMikrotik = Boolean(payment.mikrotik_portal_context_id);
    const { data, error } = await db.from('wifi_sessions').insert({
      payment_id: payment.id, phone: payment.phone, package_id: payment.package_id,
      mac_address: payment.mac_address,
      // A queued MikroTik purchase starts its paid duration when the agent
      // actually applies access, not while the agent is offline.
      start_time: queuedForMikrotik ? null : start.toISOString(),
      expiry_time: queuedForMikrotik ? null : expiry.toISOString(),
      session_status: 'WAITING_GATEWAY'
    }).select().single();
    if (error) session = (await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle()).data;
    else session = data;
  }
  if (!session) throw new Error('Could not create or load the paid Wi-Fi session');
  if (['ACTIVE', 'EXPIRED', 'REVOKED'].includes(session.session_status)) return;
  if (session.session_status === 'GATEWAY_FAILED') {
    const { error } = await db.from('wifi_sessions').update({ session_status: 'WAITING_GATEWAY' }).eq('id', session.id).eq('session_status', 'GATEWAY_FAILED');
    if (error) throw error;
  }

  try {
    let grant;
    if (payment.mikrotik_portal_context_id) {
      if (!isMikrotikAgentMode()) throw new Error('MikroTik agent mode is not configured');
      const { data: context } = await db.from('mikrotik_portal_contexts').select('gateway_id,mac_address,client_ip').eq('id', payment.mikrotik_portal_context_id).single();
      if (!context) throw new Error('Missing MikroTik hotspot context');
      grant = await queueMikrotikRouterCommand({ sessionId: session.id, gatewayId: context.gateway_id, macAddress: context.mac_address, clientIp: context.client_ip, action: 'ALLOW', durationMinutes: payment.wifi_packages.duration_minutes });
    } else {
      const { data: context } = await db.from('opennds_portal_contexts').select('hid').eq('id', payment.portal_context_id).single();
      if (!context) throw new Error('Missing openNDS gateway context');
      grant = await queueOpenNdsAuth({ sessionId: session.id, hid: context.hid, durationMinutes: payment.wifi_packages.duration_minutes });
    }
    const { error } = await db.from('wifi_sessions').update({ gateway_reference: grant.gatewayReference }).eq('id', session.id);
    if (error) throw error;
  } catch (error) {
    await db.from('wifi_sessions').update({ session_status: 'GATEWAY_FAILED' }).eq('id', session.id).eq('session_status', 'WAITING_GATEWAY');
    throw error;
  }
}

export async function applyCloudPayResult(db, event, { trustedStatusLookup = false } = {}) {
  event = normalizeCloudPayResult(event);
  const { data: payment, error: lookupError } = await db.from('payments').select('*, wifi_packages(*)').eq('checkout_request_id', event.reference).maybeSingle();
  if (lookupError) throw new Error('Could not load payment record');
  if (!payment) return 'not_found';
  const completed = event.status === 'COMPLETED';
  const failed = event.status === 'FAILED' || event.status === 'CANCELLED';
  if (payment.status === 'FAILED' && !completed) return 'processed';
  if (!completed && !failed) return 'pending';
  const expectedEvent = completed ? 'payment.completed' : 'payment.failed';
  if (!trustedStatusLookup && (event.event !== expectedEvent || event.channel !== 'MPESA' || event.currency !== 'KES' || Number(event.amount) !== Number(payment.amount_kes))) {
    throw new Error('Payment details did not match');
  }
  if (trustedStatusLookup && event.amount !== undefined && Number(event.amount) !== Number(payment.amount_kes)) throw new Error('Payment amount did not match');

  if (failed) {
    if (payment.status !== 'PENDING') return 'processed';
    const { error } = await db.from('payments').update({ status: 'FAILED', raw_callback: event }).eq('id', payment.id).eq('status', 'PENDING');
    if (error) throw error;
    return 'processed';
  }

  await activate(db, payment, event);
  return 'processed';
}
