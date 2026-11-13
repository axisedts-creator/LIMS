// C10 T-01 — worker manifest CI check (06-IMPLEMENTATION-PLAN row T-01; 02-TRD §8.2, §9). Fails now: ../index.js and ../cron.js do not exist.
// SEAMS: services/worker/src/jobs/micro/index.ts exports `manifest: WorkerManifest` (module 'micro'); cron.ts exports `cron` (CronEntry[], TRD §9 "crontab lives in cron.ts")
// and index.ts uses it as `crontab`. TRD §8.2 literal sets no maxAttempts/taskOptions: not pinned. Handlers are fail-closed stubs at T-01 (throw, never silently ack).
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { validateManifests } from '../../../core/manifest.js';
import { cron } from '../cron.js';
import { manifest } from '../index.js';
import { breakpointImportValidate } from '../tasks/micro.breakpoint_import_validate.js';

const TASKS = ['micro.breakpoint_import_validate', 'micro.reconcile_chain_status', 'micro.refresh_metrics', 'micro.purge_instrument_records'];
const CRON: Record<string, string> = {
  'micro.reconcile_chain_status': '17 2 * * *',
  'micro.refresh_metrics': '*/5 * * * *',
  'micro.purge_instrument_records': '43 3 * * *',
};
const SUBSCRIPTIONS = ['instruments.result.received.v1', 'lab.specimen.status_changed.v1'];

describe('C10-T01 worker manifest (micro)', () => {
  it('is module micro and passes the build-time manifest checks (validateManifests)', () => {
    expect(manifest.module).toBe('micro');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('subscriptions = TRD §8.2 = EVENT_CONSUMERS.micro, each with a handler; C10 consumes none of its own (produces nothing)', () => {
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    expect(subs).toEqual(SUBSCRIPTIONS);
    expect(subs).toEqual([...(EVENT_CONSUMERS.micro ?? [])].sort());
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) {
      expect(typeof h, type).toBe('function');
      expect(type.startsWith('micro.'), type).toBe(false);
    }
  });

  it('declares exactly the 4 TRD §8.2/§9 tasks, all micro.* with a handler', () => {
    expect(Object.keys(manifest.tasks ?? {}).sort()).toEqual([...TASKS].sort());
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(id).toMatch(/^micro\.[a-z0-9_]+$/);
      expect(typeof h, id).toBe('function');
    }
  });

  it('crontab (cron.ts) = the three TRD §9 rows, all per_tenant (08 A13 P-6), and is the manifest crontab; the import validator is enqueued, never cron-driven', () => {
    expect(manifest.crontab).toBe(cron);
    expect(cron.map((c) => c.identifier).sort()).toEqual(Object.keys(CRON).sort());
    for (const c of cron) {
      expect(c.schedule.trim().split(/\s+/).join(' '), c.identifier).toBe(CRON[c.identifier]);
      expect(c.tenantScope, c.identifier).toBe('per_tenant');
    }
    expect(cron.map((c) => c.identifier)).not.toContain('micro.breakpoint_import_validate');
  });

  it('T-12 registers the real breakpoint import validator (not a stub)', () => {
    expect(manifest.tasks!['micro.breakpoint_import_validate']).toBe(breakpointImportValidate);
  });

  it('every other handler is a fail-closed stub: it throws (retry / dead-letter), never resolves as if done', async () => {
    const ctx = {} as any;
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      if (id === 'micro.breakpoint_import_validate') continue;
      await expect(h({ tenant_id: 't' }, ctx), id).rejects.toThrow();
    }
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) await expect((h as any)({ type }, ctx), type).rejects.toThrow();
  });

  it('the built task list registers every task per_tenant, the three crons with their schedule, and one consumer per subscription', async () => {
    const s = await setup([manifest]);
    for (const id of TASKS) expect(s.entry(id), id).toMatchObject({ module: 'micro', kind: 'task', scope: 'per_tenant' });
    for (const [id, match] of Object.entries(CRON)) expect(s.built.cronItems.find((x: any) => x.identifier === id)?.match, id).toBe(match);
    for (const type of SUBSCRIPTIONS) expect(s.entry(`evt.micro.${type}`), type).toMatchObject({ module: 'micro', kind: 'consumer', scope: 'per_tenant' });
  });

  // Adversarial: the CI check must actually bite.
  it('validateManifests rejects a drifted manifest: extra subscription, foreign task id, cron on an undeclared task', () => {
    const h = async () => undefined;
    expect(() => validateManifests([{ ...manifest, subscriptions: { ...manifest.subscriptions, 'catalog.changed.v1': h } }])).toThrow('catalog.changed.v1');
    expect(() => validateManifests([{ ...manifest, tasks: { ...manifest.tasks, 'lab.steal': h } }])).toThrow('lab.steal');
    expect(() => validateManifests([{ ...manifest, crontab: [...(manifest.crontab ?? []), { identifier: 'micro.nope', schedule: '* * * * *', tenantScope: 'per_tenant' }] }]))
      .toThrow('micro.nope');
  });
});
