import { getAuth } from 'firebase-admin/auth';
import { firebaseApp } from '../../lib/firebase-admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { idToken } = req.body || {};
  if (typeof idToken !== 'string' || !idToken) return res.status(400).json({ error: 'A Firebase sign-in token is required' });
  try {
    const decoded = await getAuth(firebaseApp()).verifyIdToken(idToken, true);
    if (decoded.admin !== true) return res.status(403).json({ error: 'This account is not an administrator' });
    const accessToken = await getAuth(firebaseApp()).createCustomToken(decoded.uid, { technchAdmin: true });
    return res.status(200).json({ accessToken });
  } catch {
    return res.status(401).json({ error: 'Firebase sign-in could not be verified' });
  }
}
