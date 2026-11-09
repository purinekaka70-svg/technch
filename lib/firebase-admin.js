import { getApps, initializeApp, cert } from 'firebase-admin/app';

let app;
export function firebaseApp() {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) { app = existing; return app; }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin is not configured');
  app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return app;
}
