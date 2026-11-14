// C13 T14 — access slip spine: R4 (partner request) -> the job R4 enqueued -> worker partners.issue_access_slip (system actor) -> R5 poll -> R6 download -> purge -> R5 / R6 (06-IMPLEMENTATION-PLAN row T14; 03-APP-FLOW §5.5).
// Integration across the API handlers and the worker tasks on ONE in-memory world + ONE storage fake (access-slip.world.ts). ACs: US-09.2 – US-09.6. Security: ST12 (the planted URL SLIPTOKEN exists only in the RenderPort input
// and inside the stored PDF), ST12a (no SmartReportPort / ReportingPort call under partner claims). Unit-level cases live in access-slip.test.ts (API) and the worker access-slip.test.ts.
// SEAMS: as those files; the job is taken from the world's queue exactly as R4 enqueued it and run through the worker manifest (manifest.tasks[job.identifier]), so identifier and payload only have to agree between R4 and the task.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest as worker } from '../../../../../worker/src/jobs/partners/index.js';
import { manifest } from '../index.js';
import { EXPIRES, leaksIn, makePorts, makeSlipCtx, makeStorage, makeWorld14, RPT, runSlipJob, seed14, slipById, slipPath, slips, T_A, TOKEN, urlOf, worldLeaks } from './access-slip.world.js';

const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
afterEach(() => vi.unstubAllGlobals());

describe('access slip, end to end (R4 -> worker -> R5 -> R6 -> purge)', () => {
  it('request, issue, poll, download, expire: every step answers as specified and the link never leaves the render input and the PDF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch must not be called'); }));
    const w = makeWorld14(); const st = makeStorage(); seed14(w, st); const ports = makePorts(w);
    const partner = makeSlipCtx(w, 'adminX', H, st);

    // R4: 202, state requested, nothing secret, one job, no port call
    const r4 = await partner.run('issuePatientAccessSlip', { params: { report_id: RPT.b }, headers: { 'idempotency-key': 'k-e2e-1' }, body: {} });
    expect(r4.status).toBe(202);
    expect(r4.body).toMatchObject({ report_id: RPT.b, version_no: 1, state: 'requested' });
    const slip = r4.body.id as string;
    expect(partner.denied).toEqual([]);
    expect(w.jobs).toHaveLength(1);

    // R5 before the worker ran: still requested (the UI shows the spinner), and R6 has no file yet
    const poll = (op = 'getPatientAccessSlip') => partner.run(op, { params: { report_id: RPT.b, access_slip_id: slip } });
    expect((await poll()).body).toMatchObject({ id: slip, state: 'requested' });
    await expect(poll('downloadPatientAccessSlip')).rejects.toMatchObject({ code: 'common.not_found', statusCode: 404 });

    // the worker runs the job exactly as enqueued (system actor)
    const job = w.jobs[0]!;
    const task = worker.tasks![job.identifier]; expect(typeof task, job.identifier).toBe('function');
    const out = await runSlipJob(w, task!, job.payload, st, ports);
    expect(out.threw).toBeUndefined();
    expect(ports.issue).toHaveLength(1); expect(ports.issue[0]!.actorType).toBe('system');
    expect(ports.render).toHaveLength(1); expect(ports.render[0]!.input.data.portalUrl).toBe(urlOf(1));

    // R5: issued, with the link expiry but not the link
    const r5 = await poll();
    expect(r5.body).toMatchObject({ id: slip, report_id: RPT.b, version_no: 1, state: 'issued' });
    expect(new Date(r5.body.link_expires_at).toISOString()).toBe(EXPIRES);
    expect(Object.keys(r5.body).some((k) => /url|token|link_id|file|hash|sha/i.test(k))).toBe(false);

    // R6: the PDF that was stored, no-store, access log row; a second download logs a second row
    const r6 = await poll('downloadPatientAccessSlip');
    expect(r6.status).toBe(200);
    expect(Buffer.from(r6.body).equals(Buffer.from(st.get(slipPath(slip))!))).toBe(true);
    expect(Buffer.from(r6.body).toString('latin1')).toContain(urlOf(1)); // the PDF carries the link by design
    await poll('downloadPatientAccessSlip');
    expect(w.audit.filter((e) => e.action === 'report.access_slip' && e.entityId === slip && e.outcome === 'allowed')).toHaveLength(2);

    // ST12: the planted token is in no column, queue row, SQL, access-log row, log or response (R6 body excepted)
    expect(worldLeaks(w)).toEqual([]);
    expect(leaksIn([r4, r5, { status: r6.status, headers: r6.headers }, partner.logs, out.logs, out.metrics, JSON.stringify(r4.body)])).toEqual([]);
    const holders = [...st.objects.entries()].filter(([, v]) => Buffer.from(v).toString('latin1').includes(TOKEN)).map(([k]) => k);
    expect(holders).toContain(`partners-slips|${slipPath(slip)}`);
    expect(partner.denied).toEqual([]); // ST12a: no port was touched under partner claims in R4, R5, R6

    // purge after the link expired (time passes: the link expiry is moved into the past)
    slipById(w, slip)!['link_expires_at'] = new Date('2026-11-05T06:00:00Z');
    const purged = await runSlipJob(w, worker.tasks!['partners.purge_access_slips']!, { tenant_id: T_A }, st, ports);
    expect(purged.threw).toBeUndefined();
    expect(st.has(slipPath(slip))).toBe(false);
    expect((await poll()).body).toMatchObject({ id: slip, state: 'expired' });
    await expect(poll('downloadPatientAccessSlip')).rejects.toMatchObject({ code: 'common.not_found', statusCode: 404 });
    expect(slips(w).filter((r) => r['id'] === slip)).toHaveLength(1);
    expect(worldLeaks(w)).toEqual([]);
  });

  it('a superseded report: the worker records failed + reporting.report_superseded, R5 shows it, R6 has no file', async () => {
    const w = makeWorld14(); const st = makeStorage(); seed14(w, st); const ports = makePorts(w);
    ports.ctl.issueErr = new LimsError('reporting.report_superseded');
    const partner = makeSlipCtx(w, 'adminX', H, st);
    const r4 = await partner.run('issuePatientAccessSlip', { params: { report_id: RPT.b }, body: {} });
    const job = w.jobs[0]!;
    const out = await runSlipJob(w, worker.tasks![job.identifier]!, job.payload, st, ports);
    expect(out.threw).toBeUndefined();
    const r5 = await partner.run('getPatientAccessSlip', { params: { report_id: RPT.b, access_slip_id: r4.body.id } });
    expect(r5.body).toMatchObject({ state: 'failed', failure_code: 'reporting.report_superseded' });
    await expect(partner.run('downloadPatientAccessSlip', { params: { report_id: RPT.b, access_slip_id: r4.body.id } })).rejects.toMatchObject({ code: 'common.not_found' });
    expect(st.calls).toHaveLength(0);
  });
});
