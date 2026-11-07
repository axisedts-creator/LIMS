// C6-T09 — manifest wiring + cron `reporting.sweep_stuck_renders` (02-TRD §9: `*/10 * * * *`, tenantScope per_tenant, max_attempts 5,
// "`rendering` for > 15 min without an active job -> re-enqueue render"; E10). ASSUMED: ../index.js manifest registers task `reporting.render_report_version`
// (max_attempts 5) and `reporting.sweep_stuck_renders` (5) + the crontab entry; the sweep payload is { tenant_id }; it only enqueues the SAME keyed job as
// the assembly / retry-render (`render:<report_version_id>`, payload { tenant_id, report_id, report_version_id }, 5 attempts) so a live job collapses in the queue.
// "for > 15 min" is measured from rendering_started_at, falling back to created_at when it is NULL (a retry-render sets rendering_started_at = now).
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { TENANT_A, VID, idN, renderSetup, renderingVersion, type RS } from './render.helpers.js';
import { TENANT_B } from './assemble.helpers.js';

const TASK = 'reporting.render_report_version'; const SWEEP = 'reporting.sweep_stuck_renders';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const sweep = async (s: RS, payload: any = { tenant_id: TENANT_A }) => { const m = await manifest(); await m.tasks[SWEEP](payload, s.ctx()); };
// NOW in the fake = 2026-11-07T12:00:30Z -> "older than 15 min" = before 11:45:30
const OLD = '2026-11-07T11:30:00.000Z'; const YOUNG = '2026-11-07T11:50:00.000Z';
const v = (n: number, over: Record<string, unknown> = {}) => renderingVersion({ id: idN(0xc000 + n), version_no: n, ...over });

describe('manifest wiring', () => {
  it('registers reporting.render_report_version (5 attempts) and reporting.sweep_stuck_renders (5 attempts); manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks[TASK]).toBe('function'); expect(typeof m.tasks[SWEEP]).toBe('function');
    expect(m.maxAttempts[TASK]).toBe(5); expect(m.maxAttempts[SWEEP] ?? 5).toBe(5);
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('crontab: sweep_stuck_renders every 10 minutes, per_tenant (08 A13 P-6), 5 attempts', async () => {
    const m = await manifest(); const c = (m.crontab as any[]).filter((x) => x.identifier === SWEEP);
    expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ schedule: '*/10 * * * *', tenantScope: 'per_tenant' }); expect(c[0].maxAttempts ?? 5).toBe(5);
  });
  it('earlier tasks are still registered (assemble_report 10 attempts, sweep_assembly, process_input_file)', async () => {
    const m = await manifest();
    for (const t of ['reporting.assemble_report', 'reporting.sweep_assembly', 'reporting.process_input_file']) expect(typeof m.tasks[t]).toBe('function');
    expect(m.maxAttempts['reporting.assemble_report']).toBe(10);
    expect((m.crontab as any[]).some((x) => x.identifier === 'reporting.sweep_assembly')).toBe(true);
  });
});

describe('sweep_stuck_renders', () => {
  it('re-enqueues the keyed render job for `rendering` versions stuck > 15 min (rendering_started_at); younger ones are left alone', async () => {
    const s = renderSetup({ versionOver: { rendering_started_at: OLD }, extraVersions: [v(2, { rendering_started_at: YOUNG })] }); await sweep(s);
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: TASK, jobKey: `render:${VID}`, maxAttempts: 5 });
    expect(s.db.jobs[0]!.payload).toMatchObject({ tenant_id: TENANT_A, report_version_id: VID });
  });
  it('rendering_started_at NULL (render never started, e.g. a lost enqueue) -> falls back to created_at', async () => {
    const s = renderSetup({ versionOver: { rendering_started_at: null, created_at: OLD } }); await sweep(s);
    expect(s.db.jobs.map((j) => j.jobKey)).toEqual([`render:${VID}`]);
  });
  it('a version just put back to `rendering` by retry-render (old created_at, fresh rendering_started_at) is NOT stuck', async () => {
    const s = renderSetup({ versionOver: { created_at: OLD, rendering_started_at: YOUNG } }); await sweep(s); expect(s.db.jobs).toHaveLength(0);
  });
  it('exactly on the 15-minute boundary is not yet "> 15 min"', async () => {
    const s = renderSetup({ versionOver: { rendering_started_at: '2026-11-07T11:45:30.000Z' } }); await sweep(s); expect(s.db.jobs).toHaveLength(0);
  });
  it.each(['rendered', 'render_failed', 'released', 'superseded', 'discarded'])('status %s is never re-enqueued, however old', async (st) => {
    const s = renderSetup({ versionOver: { status: st, rendering_started_at: OLD, created_at: OLD } }); await sweep(s); expect(s.db.jobs).toHaveLength(0);
  });
  it('several stuck versions -> one job each with distinct keys; running twice yields the same keys and never writes a row', async () => {
    const s = renderSetup({ versionOver: { rendering_started_at: OLD }, extraVersions: [v(2, { rendering_started_at: OLD })] }); await sweep(s); await sweep(s);
    expect(new Set(s.db.jobs.map((j) => j.jobKey))).toEqual(new Set([`render:${VID}`, `render:${idN(0xc002)}`])); expect(s.db.writes()).toHaveLength(0);
  });
  it('another tenant\'s stuck version is never enqueued — even with RLS off the statement itself filters by tenant_id', async () => {
    const s = renderSetup({ rls: false, versionOver: { tenant_id: TENANT_B, rendering_started_at: OLD } }); await sweep(s);
    expect(s.db.jobs).toHaveLength(0); expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('payload tenant different from the job tenant, or missing -> no query, no job', async () => {
    const s = renderSetup({ versionOver: { rendering_started_at: OLD } });
    await sweep(s, { tenant_id: TENANT_B }); await sweep(s, {}); await sweep(s, null);
    expect(s.db.jobs).toHaveLength(0); expect(s.db.reportingStmts()).toHaveLength(0);
  });
  it('does not render anything itself (only enqueues): no renderer / storage call', async () => {
    const s = renderSetup({ versionOver: { rendering_started_at: OLD } }); await sweep(s);
    expect(s.renderer.calls).toHaveLength(0); expect(s.store.puts).toHaveLength(0);
  });
});
