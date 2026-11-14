// HC-T16 crontab of the homecollection worker (02-TRD §10 "Crontab entries live in cron.ts", REQ-ARCH-042; 08 A13 P-6 every entry per_tenant; P-15 times are Asia/Kathmandu = UTC+05:45; core manifest rule: 5 UTC fields).
// Pure unit test: no database. The task handlers must exist and the manifest the module will ship must pass the core build-time validation.
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - cron.ts exports `crontab` (readonly CronEntry[], as payments/cron.ts); identifiers are the four task names of TRD §10; maxAttempts 5 (the Retries column).
//  - UTC conversion of the [CONV] local times: sweep 00:20 -> '35 18 * * *'; overdue every 30 min -> '*/30 * * * *'; purge_locations 02:40 -> '55 20 * * *';
//    purge_retention 1st 03:10 local = 21:25 UTC on the LAST day of the previous month, which 5 cron fields cannot say exactly: pinned only to minute 25, hour 21 and a day-of-month field that is not '*'
//    (a monthly cadence; the run is idempotent). Month field must be '*'.
import { describe, expect, it } from 'vitest';
import { validateManifests, type CronEntry, type WorkerManifest } from '../../../core/manifest.js';
import { crontab } from '../cron.js';
import { flagOverdueHandovers } from '../tasks/flag_overdue_handovers.js';
import { purgeLocations } from '../tasks/purge_locations.js';
import { purgeRetention } from '../tasks/purge_retention.js';
import { sweepMissedVisits } from '../tasks/sweep_missed_visits.js';

const IDS = ['homecollection.sweep_missed_visits', 'homecollection.flag_overdue_handovers', 'homecollection.purge_locations', 'homecollection.purge_retention'] as const;
const by = (id: string): CronEntry => crontab.find((c) => c.identifier === id) as CronEntry;

describe('crontab (TRD §10)', () => {
  it('declares exactly the four housekeeping tasks, each once', () => {
    expect([...crontab.map((c) => c.identifier)].sort()).toEqual([...IDS].sort());
  });
  it('every entry is per_tenant (08 A13 P-6) with 5 attempts', () => {
    for (const c of crontab) { expect(c.tenantScope, c.identifier).toBe('per_tenant'); expect(c.maxAttempts, c.identifier).toBe(5); }
  });
  it('schedules (UTC fields for the Asia/Kathmandu times of TRD §10)', () => {
    expect(by(IDS[0]).schedule.trim()).toBe('35 18 * * *');       // 00:20 Kathmandu
    expect(by(IDS[1]).schedule.trim()).toBe('*/30 * * * *');      // every 30 minutes
    expect(by(IDS[2]).schedule.trim()).toBe('55 20 * * *');       // 02:40 Kathmandu
    const f = by(IDS[3]).schedule.trim().split(/\s+/);            // 1st 03:10 Kathmandu = 21:25 UTC the day before
    expect(f).toHaveLength(5);
    expect([f[0], f[1], f[3]]).toEqual(['25', '21', '*']);
    expect(f[2]).not.toBe('*');
  });
  it('the manifest the module ships passes the core build-time validation (task namespace, 5 UTC fields, declared tasks)', () => {
    const mf: WorkerManifest = {
      module: 'homecollection',
      tasks: { [IDS[0]]: sweepMissedVisits, [IDS[1]]: flagOverdueHandovers, [IDS[2]]: purgeLocations, [IDS[3]]: purgeRetention },
      crontab,
    };
    expect(() => validateManifests([mf])).not.toThrow();
  });
  it('the four handlers are functions taking (payload, ctx)', () => {
    for (const h of [sweepMissedVisits, flagOverdueHandovers, purgeLocations, purgeRetention]) { expect(typeof h).toBe('function'); expect(h.length).toBe(2); }
  });
});
