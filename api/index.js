import device from './device.js';
import packages from './packages.js';
import pay from './pay.js';
import cloudPayHealth from './admin/cloudpay-health.js';
import adminDashboard from './admin/dashboard.js';
import adminLogin from './admin/login.js';
import adminRouters from './admin/routers.js';
import expireSessions from './cron/expire-sessions.js';
import mikrotikContext from './mikrotik/context.js';
import mikrotikCommands from './mikrotik-agent/commands.js';
import mpesaCallback from './mpesa/callback.js';
import mpesaInitiate from './mpesa/initiate.js';
import openNdsContext from './opennds/context.js';
import openNdsFas from './opennds/fas.js';
import openNdsStatus from './opennds/status.js';
import paymentInitiate from './payments/initiate.js';
import paymentRecovery from './payments/recover-login.js';
import paymentStatus from './payments/status.js';
import tyraxCommands from './tyrax-agent/commands.js';

const handlers = {
  '/api/device': device,
  '/api/packages': packages,
  '/api/pay': pay,
  '/api/admin/cloudpay-health': cloudPayHealth,
  '/api/admin/dashboard': adminDashboard,
  '/api/admin/login': adminLogin,
  '/api/admin/routers': adminRouters,
  '/api/cron/expire-sessions': expireSessions,
  '/api/mikrotik/context': mikrotikContext,
  '/api/mikrotik-agent/commands': mikrotikCommands,
  '/api/mpesa/callback': mpesaCallback,
  '/api/mpesa/initiate': mpesaInitiate,
  '/api/opennds/context': openNdsContext,
  '/api/opennds/fas': openNdsFas,
  '/api/opennds/status': openNdsStatus,
  '/api/payments/initiate': paymentInitiate,
  '/api/payments/recover-login': paymentRecovery,
  '/api/payments/status': paymentStatus,
  '/api/tyrax-agent/commands': tyraxCommands
};

export default async function handler(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.searchParams.get('path') || requestUrl.pathname;
  const endpoint = handlers[pathname];
  if (!endpoint) return res.status(404).json({ error: 'Not found' });
  return endpoint(req, res);
}
