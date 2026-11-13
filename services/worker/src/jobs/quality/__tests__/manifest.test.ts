// C9 T-01 — worker manifest (06-IMPLEMENTATION-PLAN row T-01; 02-TRD §10.3; C0 TRD §7.2).
// done_when: "worker registers quality.reprocess_pending_observations as a no-op" (so #12 can enqueue it before T-11 replaces it).
// Expects ../index.ts to `export const manifest: WorkerManifest` (module 'quality'; SEAM: export name `manifest`, like analytics/smartreport).
// At T-01 the manifest holds ONLY that task: the other five tasks, five subscriptions and four crons of TRD §10.3 arrive with T-07/T-09/T-11/T-12/T-17/T-19
// (those tasks widen EXPECTED below; tester-owned). Whatever IS declared must satisfy the build-time checks and the TRD literal (attempts 5).
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

const REPROCESS = 'quality.reprocess_pending_observations';
/** T-01: exactly this task. Later tasks append their ids here. */
const EXPECTED_TASKS = [REPROCESS];
/** TRD §10.3 / manifest literal: the complete C9 task set (a T-01 task list may only be a subset). */
const TRD_TASKS = ['quality.sync_qc_observations', 'quality.close_stale_runs', REPROCESS, 'quality.tat_sweep', 'quality.tat_refresh_order', 'quality.purge_tat_items'];
const TRD_SUBSCRIPTIONS = ['instruments.qc.received.v1', 'instruments.result.received.v1', 'lab.result.verified.v1', 'lab.specimen.status_changed.v1', 'reporting.report.released.v1'];
const TRD_CRON = { 'quality.sync_qc_observations': '* * * * *', 'quality.close_stale_runs': '* * * * *', 'quality.tat_sweep': '* * * * *', 'quality.purge_tat_items': '40 2 * * *' };

const ctx = (tx: unknown = new Proxy({}, { get() { throw new Error('ctx.tx touched by the T-01 no-op'); } })) =>
  ({ tenantId: '01a1a98a-ac40-7000-8000-00000000c9a1', tx, attempt: 1, maxAttempts: 5, jobId: '1', requestId: '01a1a98a-ac40-7000-8000-000000090001',
    log: { info() {}, warn() {}, error() {} }, now: () => '2026-11-12T03:00:00.000Z' }) as any;

describe('C9 T-01 worker manifest (quality)', () => {
  it('is module quality and passes the build-time manifest checks (validateManifests)', () => {
    expect(manifest.module).toBe('quality');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('declares exactly the T-01 task set, every id quality.* in the TRD §10.3 list, each with a handler', () => {
    expect(Object.keys(manifest.tasks ?? {}).sort()).toEqual([...EXPECTED_TASKS].sort());
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(TRD_TASKS, id).toContain(id);
      expect(id).toMatch(/^quality\.[a-z0-9_]+$/);
      expect(typeof h, id).toBe('function');
    }
  });

  it('quality.reprocess_pending_observations is registered with max attempts 5 (TRD §10.3 / manifest literal)', () => {
    expect(manifest.maxAttempts?.[REPROCESS]).toBe(5);
    for (const id of Object.keys(manifest.maxAttempts ?? {})) expect(Object.keys(manifest.tasks ?? {}), `maxAttempts for ${id}`).toContain(id);
  });

  it('the registered handler is a no-op: resolves undefined for a valid and for an empty / hostile payload, never touches ctx.tx, never throws', async () => {
    const h = manifest.tasks![REPROCESS]!;
    const payloads: any[] = [
      { tenant_id: '01a1a98a-ac40-7000-8000-00000000c9a1', instrument_id: '01a1a98a-ac40-7000-8000-00000000c9a2' },
      { tenant_id: '01a1a98a-ac40-7000-8000-00000000c9a1', plan_id: '01a1a98a-ac40-7000-8000-00000000c9a3' },
      {}, { instrument_id: "x'; DROP TABLE quality.settings;--" }, { tenant_id: 42, plan_id: null },
    ];
    for (const p of payloads) await expect(h(p, ctx()), JSON.stringify(p)).resolves.toBeUndefined();
  });

  it('subscriptions, when declared, are only TRD §10.2 events, each also in EVENT_CONSUMERS.quality, each with a handler; no own events', () => {
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) {
      expect(TRD_SUBSCRIPTIONS, type).toContain(type);
      expect([...(EVENT_CONSUMERS.quality ?? [])], type).toContain(type);
      expect(typeof h, type).toBe('function');
      expect(type.startsWith('quality.'), `${type}: C9 never consumes its own event`).toBe(false);
    }
  });

  it('crontab, when declared, only holds TRD §10.3 entries (schedule + per_tenant scope verbatim); the reprocess task is enqueued, never scheduled', () => {
    for (const c of manifest.crontab ?? []) {
      expect(TRD_CRON, c.identifier).toHaveProperty(c.identifier);
      expect(c.schedule).toBe((TRD_CRON as any)[c.identifier]);
      expect(c.tenantScope).toBe('per_tenant');
    }
    expect((manifest.crontab ?? []).map((c) => c.identifier)).not.toContain(REPROCESS);
  });

  it('declares no systemPermissions (they live once, in the API ModuleManifest)', () => {
    expect((manifest as any).systemPermissions).toBeUndefined();
  });

  it('the built task list registers the reprocess task for the quality module, scoped per tenant, and no cron for it', async () => {
    const s = await setup([manifest]);
    expect(s.entry(REPROCESS)).toMatchObject({ module: 'quality', kind: 'task', scope: 'per_tenant' });
    expect(s.built.cronItems.filter((x: any) => x.identifier === REPROCESS)).toEqual([]);
  });
});
