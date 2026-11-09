import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseApp } from '../lib/firebase-admin.js';

const packages = [
  ['1 Hour', '1-hour', 10, 60, 'Unlimited Wi-Fi for 1 hour', false, false],
  ['1.5 Hours', '1-5-hours', 15, 90, 'Unlimited Wi-Fi for 1 hour 30 minutes', false, false],
  ['4 Hours', '4-hours', 20, 240, 'Unlimited Wi-Fi for 4 hours', false, false],
  ['6 Hours', '6-hours', 30, 360, 'Unlimited Wi-Fi for 6 hours', false, false],
  ['12 Hours', '12-hours', 60, 720, 'Unlimited Wi-Fi for 12 hours', true, false],
  ['24 Hours', '24-hours', 80, 1440, 'Unlimited Wi-Fi for 24 hours', false, false],
  ['Weekly', 'weekly', 300, 10080, 'Unlimited Wi-Fi for 7 days', false, false],
  ['Monthly', 'monthly', 800, 43200, 'Unlimited Wi-Fi for 30 days', false, true]
];
const db = getFirestore(firebaseApp());
const existing = await db.collection('wifi_packages').get();
const slugs = new Set(existing.docs.map(doc => doc.data().slug));
const batch = db.batch();
let created = 0;
for (const [index, [name, slug, price_kes, duration_minutes, description, is_popular, is_best_value]] of packages.entries()) {
  if (slugs.has(slug)) continue;
  const ref = db.collection('wifi_packages').doc(randomUUID());
  batch.set(ref, { id: ref.id, name, slug, price_kes, duration_minutes, description, is_active: true, is_popular, is_best_value, display_order: index + 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  created++;
}
if (created) await batch.commit();
console.log(`Added ${created} starter packages to Firestore; existing packages were kept.`);
