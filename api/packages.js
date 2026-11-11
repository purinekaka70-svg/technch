import { firebaseDb } from '../lib/firebase-db.js';
import { requireAdmin } from '../lib/admin-auth.js';
import { assertPackage } from '../lib/packages.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return res.status(405).end();
  const db = firebaseDb();
  if (req.method === 'GET') {
    const admin = req.headers.authorization && await requireAdmin(req, res);
    if (req.headers.authorization && !admin) return;
    const { data, error } = await db.from('wifi_packages').select('*').order('display_order');
    if (error) return res.status(503).json({ error: 'The Firestore package catalogue is unavailable.' });
    if (!admin) res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return res.status(200).json(admin ? data : data.filter(item => item.is_active));
  }
  if (!await requireAdmin(req, res)) return;

  if (req.method === 'POST') {
    let values;
    try { values = assertPackage(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const { data, error } = await db.from('wifi_packages').insert(values).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'PATCH') {
    let id, values;
    try {
      ({ id, ...values } = req.body || {});
      if (!uuidPattern.test(String(id || ''))) return res.status(400).json({ error: 'A valid package ID is required.' });
      values = assertPackage(values);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    const { data, error } = await db.from('wifi_packages').update(values).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  const id = String(req.query?.id || req.body?.id || '');
  if (!uuidPattern.test(id)) return res.status(400).json({ error: 'A valid package ID is required.' });
  const [payments, sessions] = await Promise.all([
    db.from('payments').select('id', { count: 'exact', head: true }).eq('package_id', id),
    db.from('wifi_sessions').select('id', { count: 'exact', head: true }).eq('package_id', id)
  ]);
  if (payments.error || sessions.error) return res.status(500).json({ error: 'Could not check this package history.' });
  if ((payments.count || 0) + (sessions.count || 0) > 0) return res.status(409).json({ error: 'This package has payment or session history and cannot be deleted. Disable it to preserve billing records.' });
  const { data, error } = await db.from('wifi_packages').delete().eq('id', id).select('id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not delete the package from Firestore.' });
  if (!data) return res.status(404).json({ error: 'Package not found.' });
  return res.status(200).json({ deleted: true, id });
}
