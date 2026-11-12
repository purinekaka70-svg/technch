#!/usr/bin/env node
import fs from 'node:fs';

const configPath = process.env.JIXELS_AGENT_CONFIG || '/etc/technch-mikrotik-agent/config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const apiUrl = config.apiUrl || 'https://technch-yey9.vercel.app/api/mikrotik-agent/commands';
const routerRoot = `${String(config.routerUrl).replace(/\/+$/, '')}/rest`;
const apiHeaders = { Authorization: `Bearer ${config.agentToken}` };
const routerAuth = Buffer.from(`${config.routerUsername}:${config.routerPassword}`).toString('base64');
const routerHeaders = { Authorization: `Basic ${routerAuth}` };
const warningTimes = new Map();

for (const field of ['routerUrl', 'routerUsername', 'routerPassword', 'agentToken']) {
  if (!config[field]) throw new Error(`Missing ${field} in ${configPath}`);
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function router(path, options = {}) {
  return request(`${routerRoot}/${path}`, { ...options, headers: routerHeaders });
}

function normalizeMac(mac) { return String(mac || '').trim().toLowerCase(); }

async function applyCommand(command) {
  const mac = normalizeMac(command.mac_address);
  const users = await router('ip/hotspot/user') || [];
  const user = users.find((item) => item.name === command.hotspot_username);

  if (command.action === 'ALLOW') {
    const hosts = await router('ip/hotspot/host') || [];
    const sameMacHosts = hosts.filter((item) => normalizeMac(item['mac-address']) === mac);
    const host = sameMacHosts.find((item) => item.address === command.client_ip) || (sameMacHosts.length === 1 ? sameMacHosts[0] : null);
    if (host && host.address !== command.client_ip) {
      console.warn(`Client IP changed; applying paid grant to current IP ${host.address} for MAC ${mac}.`);
    }
    if (!host) console.warn(`RouterOS does not list paid MAC ${mac}; provisioning its MAC-locked account for reconnect.`);

    const active = await router('ip/hotspot/active') || [];
    if (active.some((item) => normalizeMac(item['mac-address']) === mac && item.user === command.hotspot_username)) return;

    const newUser = {
      name: command.hotspot_username,
      password: command.hotspot_password,
      'mac-address': mac,
      'limit-uptime': `${command.duration_minutes}m`,
      comment: `Jixels session ${command.session_id}`
    };
    if (user) {
      await router(`ip/hotspot/user/${encodeURIComponent(user['.id'])}`, { method: 'PATCH', body: newUser });
    } else {
      await router('ip/hotspot/user', { method: 'PUT', body: newUser });
    }
    return;
  }

  if (command.action === 'BLOCK') {
    const active = await router('ip/hotspot/active') || [];
    for (const client of active.filter((item) => normalizeMac(item['mac-address']) === mac && item.user === command.hotspot_username)) {
      await router(`ip/hotspot/active/${encodeURIComponent(client['.id'])}`, { method: 'DELETE' });
    }
    if (user) await router(`ip/hotspot/user/${encodeURIComponent(user['.id'])}`, { method: 'DELETE' });
    return;
  }
  throw new Error(`Unsupported router action: ${command.action}`);
}

async function sendHeartbeat(routerOnline) {
  await request(apiUrl, { method: 'POST', headers: apiHeaders, body: { type: 'heartbeat', routerOnline } });
}

async function acknowledge(command, ok, message = '') {
  const permanent = false;
  await request(apiUrl, {
    method: 'POST', headers: { ...apiHeaders, 'Content-Type': 'application/json' },
    body: { commandId: command.id, ok, permanent, message }
  });
}

function warnForCommand(id, message) {
  const last = warningTimes.get(id) || 0;
  if (Date.now() - last >= 60000) {
    console.warn(`Command ${id} is waiting and will retry: ${message}`);
    warningTimes.set(id, Date.now());
  }
}

console.log('Jixels MikroTik Linux agent connected. Press Ctrl+C to stop.');
while (true) {
  let routerOnline = false;
  try {
    await router('system/resource');
    routerOnline = true;
  } catch (error) {
    console.warn(`RouterOS health check failed: ${error.message}`);
  }

  try { await sendHeartbeat(routerOnline); }
  catch (error) { console.warn(`Could not report agent/router health: ${error.message}`); }

  try {
    const feed = await request(apiUrl, { headers: apiHeaders });
    if (routerOnline) {
      for (const command of feed?.commands || []) {
        try {
          await applyCommand(command);
          await acknowledge(command, true);
          warningTimes.delete(command.id);
          console.log(`Applied ${command.action} for ${command.mac_address}.`);
        } catch (error) {
          try { await acknowledge(command, false, error.message); }
          catch (ackError) { console.warn(`Could not report command failure: ${ackError.message}`); }
          warnForCommand(command.id, error.message);
        }
      }
    } else {
      console.warn('RouterOS is unreachable; paid commands remain queued until it reconnects.');
    }
  } catch (error) {
    console.warn(`MikroTik agent poll failed: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 8000));
}
