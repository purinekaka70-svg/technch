import { getAuth } from 'firebase-admin/auth';
import { firebaseApp } from './firebase-admin.js';

export async function requireAdmin(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'Sign in required' }); return null; }

  let decoded;
  try {
    decoded = await getAuth(firebaseApp()).verifyIdToken(token, true);
  } catch {
    res.status(401).json({ error: 'Your session has expired' });
    return null;
  }
  if (decoded.technchAdmin !== true) {
    res.status(403).json({ error: 'This account is not an administrator' });
    return null;
  }
  return decoded;
}
