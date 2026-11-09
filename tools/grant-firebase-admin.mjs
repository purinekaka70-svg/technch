import { getAuth } from 'firebase-admin/auth';
import { firebaseApp } from '../lib/firebase-admin.js';

const uid = process.env.FIREBASE_ADMIN_UID;
if (!uid) throw new Error('Set FIREBASE_ADMIN_UID to the Firebase Authentication user UID.');
const auth = getAuth(firebaseApp());
const user = await auth.getUser(uid);
await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
console.log(`Granted Technch admin access to Firebase UID ${uid}. Sign out and back in to refresh its claims.`);
