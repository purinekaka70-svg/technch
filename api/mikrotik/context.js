import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { firebaseDb } from '../../lib/firebase-db.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId, normalizeHotspotLoginUrl } from '../../lib/gateway.js';

function privateIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isMikrotikAgentMode() || !isGatewayConfigured()) {
    console.error('MikroTik portal context rejected: gateway configuration incomplete', { mode: isMikrotikAgentMode(), gatewayIdConfigured: Boolean(mikrotikGatewayId()) });
    return res.status(503).json({ error: 'The MikroTik gateway identity is not configured.' });
  }
  const macAddress = String(req.body?.clientMac || '').toLowerCase();
  const clientIp = String(req.body?.clientIp || '');
  const requestedLoginUrl = String(req.body?.hotspotLoginUrl || '').trim();
  const hotspotLoginUrl = requestedLoginUrl
    ? normalizeHotspotLoginUrl(requestedLoginUrl)
    : normalizeHotspotLoginUrl(process.env.MIKROTIK_HOTSPOT_LOGIN_URL);
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(macAddress) || !privateIpv4(clientIp)) return res.status(400).json({ error: 'The hotspot could not identify this connected device.' });
  if (!hotspotLoginUrl) return res.status(503).json({ error: 'The hotspot did not provide a valid local sign-in URL. Refresh the Wi-Fi sign-in page or contact the Wi-Fi administrator.' });

  const portalToken = randomBytes(32).toString('hex');
  const gatewayId = mikrotikGatewayId();
  const { error } = await firebaseDb().from('mikrotik_portal_contexts').insert({
    token_hash: createHash('sha256').update(portalToken).digest('hex'), gateway_id: gatewayId,
    mac_address: macAddress, client_ip: clientIp, hotspot_login_url: hotspotLoginUrl, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    consumed_at: null
  });
  if (error) {
    console.error('MikroTik portal context insert failed', { code: error.code, message: error.message, gatewayId });
    return res.status(500).json({ error: 'Could not start this hotspot checkout. Reconnect and try again.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ portalToken });
}
