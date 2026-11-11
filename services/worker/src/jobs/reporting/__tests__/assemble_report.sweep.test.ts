// C6-T08 — manifest wiring + cron `reporting.sweep_assembly` (02-TRD §9: `*/5 * * * *`, tenantScope per_tenant, "reports with needs_assembly older
// than 2 min -> enqueue assembly", max_attempts 5; covers lost debounce races). ASSUMED: ../index.js manifest registers the tasks
// `reporting.assemble_report` (max_attempts 10) and `reporting.sweep_assembly` (5) and the crontab entry (cron.ts feeds the manifest);
// the sweep task payload is { tenant_id }; it only enqueues (same keyed job as the consumers: `assemble:<report_id>`, payload { tenant_id, report_id }, 10 attempts).
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { LAB, NARR, TENANT_A, TENANT_B, idN, setup, type Setup } from './assemble.helpers.js';

const ID = 'reporting.sweep_assembly';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const sweep = async (s: Setup, payload: any = { tenant_id: TENANT_A }) => { const m = await manifest(); await m.tasks[ID](payload, s.ctx()); };
// NOW in the fake = 2026-11-07T12:00:30Z -> "older than 2 min" = needs_assembly_since < 11:58:30
const arm = (s: Setup, since: Record<string, string | null>) => {
  for (const r of s.db.store['reporting.reports']!) if (r['id'] in since) Object.assign(r, { needs_assembly: since[r['id']] !== null, needs_assembly_since: since[r['id']] });
};

describe('manifest wiring', () => {
  it('registers reporting.assemble_report (10 attempts) and reporting.sweep_assembly (5 attempts); manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks['reporting.assemble_report']).toBe('function'); expect(typeof m.tasks[ID]).toBe('function');
    expect(m.maxAttempts['reporting.assemble_report']).toBe(10); expect((m.maxAttempts[ID] ?? 5)).toBe(5);
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('crontab has the sweep: every 5 minutes, per_tenant (08 A13 P-6)', async () => {
    const m = await manifest(); const c = (m.crontab as any[]).filter((x) => x.identifier === ID);
    expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ schedule: '*/5 * * * *', tenantScope: 'per_tenant' }); expect(c[0].maxAttempts ?? 5).toBe(5);
  });
  it('earlier tasks/consumers are still registered (process_input_file, ready_for_report subscription)', async () => {
    const m = await manifest(); expect(typeof m.tasks['reporting.process_input_file']).toBe('function'); expect(typeof m.subscriptions['lab.order.ready_for_report.v1']).toBe('function');
  });
});

describe('sweep_assembly', () => {
  it('enqueues the keyed assembly job for reports armed more than 2 min ago; younger and un-armed reports are left alone', async () => {
    const s = setup(); arm(s, { [LAB]: '2026-11-07T11:57:00.000Z', [NARR]: '2026-11-07T11:59:00.000Z' });
    await sweep(s);
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'reporting.assemble_report', jobKey: `assemble:${LAB}`, maxAttempts: 10 }); expect(s.db.jobs[0]!.payload).toEqual({ tenant_id: TENANT_A, report_id: LAB });
  });
  it('needs_assembly = false is never enqueued, however old the timestamp is', async () => {
    const s = setup(); arm(s, { [LAB]: null, [NARR]: null }); await sweep(s); expect(s.db.jobs).toHaveLength(0);
  });
  it('exactly on the 2-minute boundary is not yet "older than 2 min"', async () => {
    const s = setup(); arm(s, { [LAB]: '2026-11-07T11:58:30.000Z', [NARR]: null }); await sweep(s); expect(s.db.jobs).toHaveLength(0);
  });
  it('both reports old -> one job per report, distinct keys', async () => {
    const s = setup(); arm(s, { [LAB]: '2026-11-07T11:50:00.000Z', [NARR]: '2026-11-07T11:50:00.000Z' }); await sweep(s);
    expect(s.db.jobs.map((j) => j.jobKey).sort()).toEqual([`assemble:${LAB}`, `assemble:${NARR}`].sort());
  });
  it('running twice yields the same key (the queue keeps one job) and never writes a report row', async () => {
    const s = setup(); arm(s, { [LAB]: '2026-11-07T11:50:00.000Z', [NARR]: null }); await sweep(s); await sweep(s);
    expect(new Set(s.db.jobs.map((j) => j.jobKey))).toEqual(new Set([`assemble:${LAB}`])); expect(s.db.writes()).toHaveLength(0);
  });
  it('another tenant\'s armed report is never enqueued — even with RLS off the statement itself filters by tenant_id', async () => {
    const s = setup({ rls: false }); arm(s, { [LAB]: null, [NARR]: null });
    s.db.store['reporting.reports']!.push({ ...s.db.store['reporting.reports']![0]!, id: idN(0xb0b), tenant_id: TENANT_B, needs_assembly: true, needs_assembly_since: '2026-11-07T11:00:00.000Z' });
    await sweep(s); expect(s.db.jobs).toHaveLength(0);
    expect(s.db.reportingStmts().every((x) => /\btenant_id\b/i.test(x.text))).toBe(true);
  });
  it('payload tenant different from the job tenant, or missing -> no query, no job', async () => {
    const s = setup(); arm(s, { [LAB]: '2026-11-07T11:00:00.000Z' });
    await sweep(s, { tenant_id: TENANT_B }); await sweep(s, {}); expect(s.db.jobs).toHaveLength(0); expect(s.db.reportingStmts()).toHaveLength(0);
  });
});
