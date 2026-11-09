import { timingSafeEqual } from 'node:crypto';
import { firebaseDb } from '../../lib/firebase-db.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId } from '../../lib/gateway.js';

function authorized(req) {
  const expected = process.env.MIKROTIK_AGENT_TOKEN || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(provided)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export default async function handler(req, res) {
  if (!isMikrotikAgentMode() || !isGatewayConfigured() || !authorized(req)) return res.status(401).json({ error: 'Unauthorized MikroTik agent' });
  const db = firebaseDb();
  if (req.method === 'GET') {
    const now = new Date().toISOString();
    const { error: heartbeatError } = await db.from('mikrotik_agent_status').upsert({ id: 1, last_seen_at: now }, { onConflict: 'id' });
    if (heartbeatError) {
      console.error('MikroTik agent heartbeat failed', { code: heartbeatError.code, message: heartbeatError.message });
      return res.status(500).json({ error: 'Could not record MikroTik agent heartbeat' });
    }
    const gatewayId = mikrotikGatewayId();
    const { data, error } = await db.from('mikrotik_router_commands').select('id,session_id,gateway_id,mac_address,client_ip,action,duration_minutes,hotspot_username,hotspot_password,attempts').eq('status', 'PENDING').eq('gateway_id', gatewayId).order('created_at').limit(20);
    if (error) {
      console.error('MikroTik agent command lookup failed', { code: error.code, message: error.message, gatewayId });
      return res.status(500).json({ error: 'Could not load MikroTik commands' });
    }
    console.info('MikroTik agent poll completed', { gatewayId, pendingCommands: data.length });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ commands: data });
  }
  if (req.method === 'POST') {
    const { type, routerOnline, commandId, ok, permanent = false, message = '' } = req.body || {};
    if (type === 'heartbeat' && typeof routerOnline === 'boolean') {
      const now = new Date().toISOString();
      const { error } = await db.from('mikrotik_agent_status').upsert({
        id: 1,
        last_seen_at: now,
        router_last_seen_at: routerOnline ? now : null
      }, { onConflict: 'id' });
      if (error) {
        console.error('MikroTik agent health update failed', { code: error.code, message: error.message });
        return res.status(500).json({ error: 'Could not record MikroTik health' });
      }
      return res.status(200).json({ received: true });
    }
    if (!/^[0-9a-f-]{36}$/i.test(commandId || '') || typeof ok !== 'boolean') return res.status(400).json({ error: 'Invalid command acknowledgement' });
    const { data: command, error } = await db.from('mikrotik_router_commands').select('id,session_id,attempts').eq('id', commandId).eq('status', 'PENDING').maybeSingle();
    if (error || !command) return res.status(404).json({ error: 'Pending MikroTik command not found' });
    if (!ok) {
      // Older local agents mark a missing HotSpot host as permanent. A paid
      // grant must remain queued until that same MAC reconnects; never discard
      // an ALLOW just because the client temporarily left the host table.
      const staleHotspotClient = /STALE_CLIENT_CONTEXT|CLIENT_NOT_ON_HOTSPOT|no longer sees?.*(?:client|mac)|HotSpot host table/i.test(String(message));
      if (permanent && !staleHotspotClient) {
        const { error: commandError } = await db.from('mikrotik_router_commands').update({
          status: 'CANCELLED', attempts: command.attempts + 1,
          last_error: String(message).slice(0, 500), hotspot_password: null
        }).eq('id', command.id).eq('status', 'PENDING');
        if (commandError) return res.status(500).json({ error: 'Could not stop stale MikroTik command' });
        const { error: sessionError } = await db.from('wifi_sessions').update({ session_status: 'GATEWAY_FAILED' }).eq('id', command.session_id).eq('session_status', 'WAITING_GATEWAY');
        if (sessionError) return res.status(500).json({ error: 'Could not mark paid session for recovery' });
        return res.status(200).json({ received: true, retry: false });
      }
      const { error: updateError } = await db.from('mikrotik_router_commands').update({ attempts: command.attempts + 1, last_error: String(message).slice(0, 500) }).eq('id', command.id).eq('status', 'PENDING');
      if (updateError) return res.status(500).json({ error: 'Could not record MikroTik command failure' });
      return res.status(202).json({ received: true, retry: true });
    }
    const { data: completed, error: completionError } = await db.rpc('complete_mikrotik_router_command', { p_command_id: command.id });
    if (completionError || !completed) return res.status(500).json({ error: 'Could not finish MikroTik command; it will retry' });
    return res.status(200).json({ received: true });
  }
  return res.status(405).end();
}
