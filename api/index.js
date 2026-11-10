const handlers = {
  '/api/device': './device.js',
  '/api/packages': './packages.js',
  '/api/pay': './pay.js',
  '/api/admin/cloudpay-health': './admin/cloudpay-health.js',
  '/api/admin/dashboard': './admin/dashboard.js',
  '/api/admin/login': './admin/login.js',
  '/api/admin/routers': './admin/routers.js',
  '/api/cloudpay/webhook': './cloudpay/webhook.js',
  '/api/cron/expire-sessions': './cron/expire-sessions.js',
  '/api/mikrotik/context': './mikrotik/context.js',
  '/api/mikrotik-agent/commands': './mikrotik-agent/commands.js',
  '/api/mpesa/callback': './mpesa/callback.js',
  '/api/mpesa/initiate': './mpesa/initiate.js',
  '/api/opennds/context': './opennds/context.js',
  '/api/opennds/fas': './opennds/fas.js',
  '/api/opennds/status': './opennds/status.js',
  '/api/payments/initiate': './payments/initiate.js',
  '/api/payments/recover-login': './payments/recover-login.js',
  '/api/payments/status': './payments/status.js',
  '/api/tyrax-agent/commands': './tyrax-agent/commands.js'
};

export default async function handler(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
  const modulePath = handlers[pathname];
  if (!modulePath) return res.status(404).json({ error: 'Not found' });
  const module = await import(modulePath);
  return module.default(req, res);
}
