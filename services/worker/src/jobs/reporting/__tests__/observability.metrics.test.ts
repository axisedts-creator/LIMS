// C6-T33 — worker-side metrics (02-TRD §12 metric table + "Alert rules for C1" T33 rows; metric names fixed by the TRD). ctx.metrics = { inc(name, labels?, by?), set(name, value, labels?), observe() }
// (core/tasklist.ts). ASSUMED (spec gives names/labels only, not the emitting task):
//   - reporting.assemble_report: inc lims_reporting_versions_total { report_kind, family } once per version it creates.
//   - reporting.send_delivery:   inc lims_reporting_deliveries_total { channel, purpose, status } when a delivery reaches `sent` / `failed`; inc lims_reporting_transport_errors_total
//     { provider_kind, retryable } per failed transport call; set gauge lims_reporting_transport_circuit_open to 1 when the breaker refuses a send and back to 0 once it closes. Label values may be
//     strings or numbers/booleans (compared as strings).
//   - cron reporting.sweep_stuck_renders: sets gauge lims_reporting_versions_rendering_oldest_seconds = age in seconds of the oldest `rendering` version of the tenant (rendering_started_at, else created_at),
//     0 when there is none (so the alert clears).
//   - cron reporting.sweep_held_releases: sets lims_reporting_held_oldest_seconds = age of the oldest held `rendered` version (now - rendered_at; 0 when none) and
//     lims_reporting_held_versions { tenant_id } = count of held versions. The sweep still only enqueues (no other side effect).
import '../../../../../api/src/__tests__/setup-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { build as buildAssemble, setup as assembleSetup, PORTAL_ORIGIN } from './assemble.helpers.js';
import { D, deliveryWorld, dRow, makeTransport, NOW as DNOW, transportError, type DWorldOpts } from './delivery.helpers.js';
import { releaseSetup, rendered } from './release.helpers.js';
import { TENANT_A, idN, renderSetup, renderingVersion } from './render.helpers.js';

type Call = { kind: 'inc' | 'set'; name: string; value?: number; labels?: Record<string, unknown> };
function collector() {
  const calls: Call[] = [];
  const metrics = {
    inc: (name: string, labels?: Record<string, unknown>) => { calls.push({ kind: 'inc', name, labels }); },
    set: (name: string, value: number, labels?: Record<string, unknown>) => { calls.push({ kind: 'set', name, value, labels }); },
    observe() {},
  };
  const incs = (name: string) => calls.filter((c) => c.kind === 'inc' && c.name === name);
  const sets = (name: string) => calls.filter((c) => c.kind === 'set' && c.name === name);
  return { calls, metrics, incs, sets, lastSet: (name: string) => sets(name).at(-1)?.value };
}
const str = (o: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, String(v)]));

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('lims_reporting_versions_total{report_kind,family}', () => {
  it('reporting.assemble_report counts the version it creates (final / laboratory)', async () => {
    const s = assembleSetup(); const h = await buildAssemble(s); await s.run(h);
    const v = (s.metrics as any[]).filter((m) => m.name === 'lims_reporting_versions_total');
    expect(v).toHaveLength(1); expect(v[0].labels).toEqual({ report_kind: 'final', family: 'laboratory' });
  });
});

describe('send_delivery metrics', () => {
  async function dsetup(o: DWorldOpts = {}, transports: Record<string, any> = {}) {
    const w = deliveryWorld({ deliveries: [dRow(1)], ...o });
    const m: any = await import('../tasks/send_delivery.js');
    const task = m.createSendDelivery ? m.createSendDelivery({ env: { ...w.env }, transports }) : m.sendDelivery;
    return { w, task };
  }
  it('a sent delivery counts lims_reporting_deliveries_total{channel,purpose,status=sent}', async () => {
    const { w, task } = await dsetup({}, { recording: makeTransport('recording') }); const c = collector();
    await w.run(task, { delivery_id: D(1) }, { metrics: c.metrics });
    expect(c.incs('lims_reporting_deliveries_total').map((x) => str(x.labels))).toContainEqual({ channel: 'whatsapp', purpose: 'report_ready', status: 'sent' });
    expect(c.incs('lims_reporting_transport_errors_total')).toHaveLength(0);
  });
  it('a permanent provider rejection counts deliveries_total{status=failed} and transport_errors_total{provider_kind,retryable=false}', async () => {
    const err = await transportError(false, 'provider_rejected');
    const { w, task } = await dsetup({}, { recording: makeTransport('recording', () => err) }); const c = collector();
    await w.run(task, { delivery_id: D(1) }, { metrics: c.metrics });
    expect(c.incs('lims_reporting_deliveries_total').map((x) => str(x.labels))).toContainEqual({ channel: 'whatsapp', purpose: 'report_ready', status: 'failed' });
    expect(c.incs('lims_reporting_transport_errors_total').map((x) => str(x.labels))).toEqual([{ provider_kind: 'recording', retryable: 'false' }]);
  });
  it('a retryable transport error counts transport_errors_total{retryable=true} and no terminal deliveries_total yet', async () => {
    const err = await transportError(true, 'provider_unavailable');
    const { w, task } = await dsetup({}, { recording: makeTransport('recording', () => err) }); const c = collector();
    await w.run(task, { delivery_id: D(1) }, { metrics: c.metrics });
    expect(c.incs('lims_reporting_transport_errors_total').map((x) => str(x.labels))).toEqual([{ provider_kind: 'recording', retryable: 'true' }]);
    expect(c.incs('lims_reporting_deliveries_total').filter((x) => ['sent', 'failed'].includes(String(x.labels?.['status'])))).toHaveLength(0);
  });
  it('gauge lims_reporting_transport_circuit_open: 1 when the breaker refuses a send (after 10 failures), 0 again after it closes (60 s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(DNOW));
    const err = await transportError(true, 'provider_unavailable'); const rec = makeTransport('recording', () => err);
    const ds = Array.from({ length: 12 }, (_, i) => dRow(i + 1, { idempotency_key: `cb-${i}` }));
    const { w, task } = await dsetup({ deliveries: ds }, { recording: rec }); const c = collector();
    for (let i = 1; i <= 10; i++) await w.run(task, { delivery_id: D(i) }, { metrics: c.metrics });
    expect(c.lastSet('lims_reporting_transport_circuit_open') ?? 0).toBe(0);   // not open yet
    await w.run(task, { delivery_id: D(11) }, { metrics: c.metrics });
    expect(c.lastSet('lims_reporting_transport_circuit_open')).toBe(1);
    w.clock.t = new Date(Date.parse(DNOW) + 61_000).toISOString(); vi.setSystemTime(new Date(w.clock.t));
    await w.run(task, { delivery_id: D(12) }, { metrics: c.metrics });
    expect(c.lastSet('lims_reporting_transport_circuit_open')).toBe(0);
  });
  it('metric labels never carry destination / link / token / delivery id (cardinality + PHI)', async () => {
    const err = await transportError(false, 'provider_rejected');
    const { w, task } = await dsetup({}, { recording: makeTransport('recording', () => err) }); const c = collector();
    await w.run(task, { delivery_id: D(1) }, { metrics: c.metrics });
    const txt = JSON.stringify(c.calls); expect(txt).not.toContain(D(1)); expect(txt).not.toMatch(/\+977|@|\/r\/|destination|token/i);
  });
});

describe('gauge lims_reporting_versions_rendering_oldest_seconds (cron reporting.sweep_stuck_renders)', () => {
  const SWEEP = 'reporting.sweep_stuck_renders';
  async function sweep(s: ReturnType<typeof renderSetup>, c: ReturnType<typeof collector>) {
    const ctx = s.ctx(); ctx.metrics = c.metrics; const now = Date.parse(ctx.now());
    await ((await import('../index.js')).manifest as any).tasks[SWEEP]({ tenant_id: TENANT_A }, ctx); return now;
  }
  it('= age of the oldest `rendering` version in seconds (older than the 900 s alert threshold here)', async () => {
    const OLD = '2026-11-07T11:30:00.000Z'; const YOUNG = '2026-11-07T11:50:00.000Z';
    const s = renderSetup({ versionOver: { rendering_started_at: OLD }, extraVersions: [renderingVersion({ id: idN(0xc002), version_no: 2, rendering_started_at: YOUNG })] }); const c = collector();
    const now = await sweep(s, c);
    expect(Math.abs((c.lastSet('lims_reporting_versions_rendering_oldest_seconds') ?? -1) - (now - Date.parse(OLD)) / 1000)).toBeLessThanOrEqual(1);
  });
  it('falls back to created_at when rendering_started_at is NULL', async () => {
    const OLD = '2026-11-07T11:00:00.000Z'; const s = renderSetup({ versionOver: { rendering_started_at: null, created_at: OLD } }); const c = collector();
    const now = await sweep(s, c);
    expect(Math.abs((c.lastSet('lims_reporting_versions_rendering_oldest_seconds') ?? -1) - (now - Date.parse(OLD)) / 1000)).toBeLessThanOrEqual(1);
  });
  it('is set to 0 when nothing is rendering, so a cleared alert resolves', async () => {
    const s = renderSetup({ versionOver: { status: 'rendered' } }); const c = collector(); await sweep(s, c);
    expect(c.lastSet('lims_reporting_versions_rendering_oldest_seconds')).toBe(0);
  });
});

describe('gauges lims_reporting_held_oldest_seconds + lims_reporting_held_versions{tenant_id} (cron reporting.sweep_held_releases)', () => {
  async function sweep(s: ReturnType<typeof releaseSetup>, c: ReturnType<typeof collector>) {
    const ctx = s.jobCtx({ metrics: c.metrics }); const now = Date.parse(ctx.now());
    await (await import('../cron.js')).sweepHeldReleases({ tenant_id: TENANT_A }, ctx); return now;
  }
  const heldAt = (n: number, iso: string, over: Record<string, unknown> = {}) => rendered(n, { held_basis: 'due_outstanding', held_checked_at: '2026-11-07T11:56:00.000Z', rendered_at: iso, ...over });
  it('oldest = now - rendered_at of the oldest held version (8 days > the 7-day alert threshold); count = held versions of the tenant', async () => {
    const eight = '2026-10-30T00:00:00.000Z'; const one = '2026-11-06T00:00:00.000Z';
    const s = releaseSetup({ versions: [heldAt(1, eight), heldAt(2, one, { held_basis: 'no_invoice' })] }); const c = collector(); const now = await sweep(s, c);
    expect(Math.abs((c.lastSet('lims_reporting_held_oldest_seconds') ?? -1) - (now - Date.parse(eight)) / 1000)).toBeLessThanOrEqual(1);
    expect(c.sets('lims_reporting_held_versions').at(-1)).toMatchObject({ value: 2, labels: { tenant_id: TENANT_A } });
  });
  it('released / superseded versions are not counted; none held -> both gauges 0', async () => {
    const s = releaseSetup({ versions: [rendered(1)] }); const c = collector(); await sweep(s, c);
    expect(c.lastSet('lims_reporting_held_oldest_seconds')).toBe(0);
    expect(c.sets('lims_reporting_held_versions').at(-1)).toMatchObject({ value: 0, labels: { tenant_id: TENANT_A } });
  });
  it('still only enqueues: the metric is additive (one release job per held version)', async () => {
    const s = releaseSetup({ versions: [heldAt(1, '2026-10-30T00:00:00.000Z')] }); const c = collector(); await sweep(s, c);
    expect(s.jobs('reporting.release_if_eligible')).toHaveLength(1);
  });
});
