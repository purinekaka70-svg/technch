import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const output = resolve(root, 'public');
const publicEntries = [
  'index.html', 'admin.html', 'app.js', 'admin.js', 'styles.css',
  'refinements.css', 'tamu-green.css', 'admin.css', 'admin-login.css',
  'admin.webmanifest', 'sw.js', 'assets'
];

await mkdir(output, { recursive: true });
for (const entry of publicEntries) {
  await cp(resolve(root, entry), resolve(output, entry), { recursive: true, force: true });
}
