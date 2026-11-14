// C16-T01 — worker manifest skeleton (02-TRD §3.3, §7.2, §8.1). Fails now: ../index.js does not exist.
// SEAM: services/worker/src/jobs/engagement/index.ts exports `manifest: WorkerManifest` (like jobs/analytics/index.ts): module 'engagement',
// every §8.1 task id registered (fail-closed stubs are fine at T-01), subscriptions = the six consumed events of §7.2. Cron rows, when present, are per_tenant.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

const TASKS = [
  'engagement.send_login_otp', 'engagement.create_self_patient', 'engagement.backfill_link', 'engagement.fetch_smart_summary',
  'engagement.create_payment_intent', 'engagement.refresh_payment_request', 'engagement.send_booking_message', 'engagement.send_reminder',
  'engagement.sync_bookable_items', 'engagement.sync_booking_centres',
];
const SUBSCRIPTIONS = [
  'billing.balance.changed.v1', 'catalog.changed.v1', 'homecollection.collection.synced.v1', 'lab.specimen.rejected.v1',
  'lab.specimen.status_changed.v1', 'reporting.report.released.v1',
];

describe('C16-T01 worker manifest', () => {
  it('is module engagement and passes the worker manifest validation', () => {
    expect(manifest.module).toBe('engagement');
    expect(() => validateManifests([manifest])).not.toThrow();
  });
  it('registers every §8.1 task', () => {
    for (const t of TASKS) expect(typeof manifest.tasks?.[t], t).toBe('function');
  });
  it('subscribes to exactly the six events of §7.2 (EVENT_CONSUMERS.engagement)', () => {
    expect(Object.keys(manifest.subscriptions ?? {}).sort()).toEqual(SUBSCRIPTIONS);
    for (const h of Object.values(manifest.subscriptions ?? {})) expect(typeof h).toBe('function');
  });
  it('every cron row is per_tenant and names a registered task (TRD §8.2, 08 A13 P-6)', () => {
    for (const c of manifest.crontab ?? []) {
      expect(c.tenantScope, c.identifier).toBe('per_tenant');
      expect(typeof manifest.tasks?.[c.identifier], c.identifier).toBe('function');
    }
  });
});
