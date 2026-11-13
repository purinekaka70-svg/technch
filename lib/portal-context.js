export function portalContextSelect(isMikrotik) {
  return isMikrotik
    ? 'id,mac_address,client_ip,gateway_id,consumed_at,expires_at'
    : 'id,mac_address,consumed_at,expires_at';
}

export function isPortalContextUsable(context, now = Date.now()) {
  if (!context || context.consumed_at != null) return false;
  const expiresAt = Date.parse(context.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt > now;
}
