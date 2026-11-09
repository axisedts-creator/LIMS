// T-26 (C3) cron wiring: 02-TRD §10 (schedules, max_attempts), 08 A13 P-6 (all three `tenantScope: 'per_tenant'`), REQ-ARCH-042 (entries live in cron.ts).
// Under test: services/worker/src/jobs/catalog/cron.ts exporting `crontab: readonly CronEntry[]` (same shape as billing/cron.ts) and the three tasks'
//   identifiers + handlers: EXPIRE_IMPORTS / expireImports, PURGE_FILES / purgeFiles, GLOBAL_RELEASE_FANOUT / globalReleaseFanout.
// Not covered: catalog/index.ts (the WorkerManifest assembly belongs to the manifest task, not T-26).
import { describe, expect, it } from 'vitest';
import { validateManifests, type WorkerManifest } from '../../../../core/manifest.js';
import { crontab } from '../../cron.js';
import { EXPIRE_IMPORTS, expireImports } from '../../tasks/catalog.expire_imports.js';
import { GLOBAL_RELEASE_FANOUT, globalReleaseFanout } from '../../tasks/catalog.global_release_fanout.js';
import { PURGE_FILES, purgeFiles } from '../../tasks/catalog.purge_files.js';

const entry = (id: string) => crontab.find((c) => c.identifier === id);

describe('catalog crontab (T-26)', () => {
  it('task identifiers are the TRD §10 names', () => {
    expect([EXPIRE_IMPORTS, PURGE_FILES, GLOBAL_RELEASE_FANOUT]).toEqual(['catalog.expire_imports', 'catalog.purge_files', 'catalog.global_release_fanout']);
  });

  it('declares exactly the three tasks, each once', () => {
    expect(crontab.map((c) => c.identifier).sort()).toEqual(['catalog.expire_imports', 'catalog.global_release_fanout', 'catalog.purge_files']);
  });

  it('every entry is tenantScope per_tenant (08 A13 P-6) — never platform', () => {
    for (const c of crontab) expect(c.tenantScope, c.identifier).toBe('per_tenant');
  });

  it('schedules (UTC) and max attempts per TRD §10', () => {
    expect(entry(EXPIRE_IMPORTS)).toMatchObject({ schedule: '5 * * * *', maxAttempts: 1 });
    expect(entry(PURGE_FILES)).toMatchObject({ schedule: '20 21 * * *', maxAttempts: 1 });          // 03:05 Asia/Kathmandu
    expect(entry(GLOBAL_RELEASE_FANOUT)).toMatchObject({ schedule: '*/10 * * * *', maxAttempts: 3 });  // AC-19.5: within 15 min
  });

  it('the crontab is immutable', () => {
    expect(Object.isFrozen(crontab)).toBe(true);
    for (const c of crontab) expect(Object.isFrozen(c), c.identifier).toBe(true);
  });

  it('passes the core manifest validation together with the three handlers', () => {
    const manifest: WorkerManifest = {
      module: 'catalog',
      tasks: { [EXPIRE_IMPORTS]: expireImports, [PURGE_FILES]: purgeFiles, [GLOBAL_RELEASE_FANOUT]: globalReleaseFanout },
      subscriptions: {},
      crontab,
    };
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('handlers are functions', () => {
    for (const h of [expireImports, purgeFiles, globalReleaseFanout]) expect(typeof h).toBe('function');
  });
});
