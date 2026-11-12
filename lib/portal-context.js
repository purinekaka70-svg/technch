export function isPortalContextUsable(context, now = Date.now()) {
  if (!context || context.consumed_at != null) return false;
  const expiresAt = Date.parse(context.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt > now;
}
