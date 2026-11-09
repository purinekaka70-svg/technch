import { requireAdmin } from '../../lib/admin-auth.js';
import { cloudPayBase, cloudPayToken } from '../../lib/cloudpay-api.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!await requireAdmin(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');
  const environment = String(process.env.CLOUDPAY_ENV || '').trim().toLowerCase();
  if (!cloudPayBase()) {
    return res.status(503).json({ authenticated: false, environment: environment || null, error: 'CloudPay environment is not set to production or sandbox.' });
  }
  try {
    await cloudPayToken();
    return res.status(200).json({ authenticated: true, environment });
  } catch (error) {
    return res.status(502).json({ authenticated: false, environment, error: error.message || 'CloudPay OAuth check failed.' });
  }
}
