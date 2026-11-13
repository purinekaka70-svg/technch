import test from 'node:test';
import assert from 'node:assert/strict';
import { isPortalContextUsable, portalContextSelect } from '../lib/portal-context.js';

const now = Date.parse('2026-11-12T10:00:00.000Z');

test('portal checkout selects expiration for both gateway types', () => {
  assert.match(portalContextSelect(true), /expires_at/);
  assert.match(portalContextSelect(false), /expires_at/);
});

test('a portal context with a missing consumed_at field is still usable', () => {
  assert.equal(isPortalContextUsable({ expires_at: '2026-11-12T10:30:00.000Z' }, now), true);
});

test('a consumed or expired portal context cannot start payment', () => {
  assert.equal(isPortalContextUsable({ consumed_at: '2026-11-12T09:59:00.000Z', expires_at: '2026-11-12T10:30:00.000Z' }, now), false);
  assert.equal(isPortalContextUsable({ consumed_at: null, expires_at: '2026-11-12T09:59:00.000Z' }, now), false);
});
