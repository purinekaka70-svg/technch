import { getApps, initializeApp, applicationDefault, cert } from 'firebase-admin/app';

let app;
export function firebaseApp() {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) { app = existing; return app; }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId) throw new Error('Firebase Admin project ID is not configured');
  const credential = clientEmail && privateKey
    ? cert({ projectId, clientEmail, privateKey })
    : applicationDefault();
  app = initializeApp({ credential, projectId });
  return app;
}
