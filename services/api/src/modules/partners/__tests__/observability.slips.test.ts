// C13 T23 — Observability. Part 4/4: access-slip metrics — lims_partners_access_slips_total{outcome} (requested | issued | failed | expired | downloaded) and lims_partners_access_slip_issue_seconds (histogram).
// Spec: 02-TRD §13 metric table (outcomes verbatim), 08 A2.1 / A5.x (slip lifecycle: R4 request -> task issue_access_slip -> R6 download; purge_access_slips expires), 01-PRD US-09.x, 07-SECURITY (no URL / token / ids in labels).
// World: access-slip.world.ts (API handlers R4/R6, worker tasks). SEAM (same as report.service.ts): ctx.metrics.inc(name, labels?, by?) / ctx.metrics.observe(name, value, labels?).
// SEAM emission points: requested = R4 202 (once per accepted request; a 403 / 404 / replay emits nothing); issued = task finished state `issued`; failed = task finished state `failed` (business error, task resolves; a transient
//   error that makes the task throw for the queue retry is NOT a failure yet); expired = purge flips an `issued` row to `expired` (one inc per row or one inc with by = n: the SUM of `by` is checked); downloaded = R6 200.
//   issue_seconds = ONE observe(value, no labels) per issued slip, value = seconds from the row's created_at (the request) to the job's ctx.now(). LD-140 does not apply (backend).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest as workerManifest } from '../../../../../worker/src/jobs/partners/index.js';
import { manifest } from '../index.js';
import { issuedSlip, LINK, leaksIn, makePorts, makeSlipCtx, makeSlipJob, makeStorage, makeWorld14, P, RPT, SL, seed14, slipById, T_A, TOKEN, type World } from './access-slip.world.js';

const SLIPS = 'lims_partners_access_slips_total', ISSUE_S = 'lims_partners_access_slip_issue_seconds';
type Rec = { name: string; labels: Record<string, unknown>; value?: number; by?: number };
function spy() {
  const incs: Rec[] = [], obs: Rec[] = [];
  return { incs, obs, inc: (name: string, labels: Record<string, unknown> = {}, by = 1) => { incs.push({ name, labels, by }); }, set() {}, observe: (name: string, value: number, labels: Record<string, unknown> = {}) => { obs.push({ name, labels, value }); } };
}
type Spy = ReturnType<typeof spy>;
const outcomes = (m: Spy) => m.incs.filter((x) => x.name === SLIPS).flatMap((x) => Array.from({ length: x.by ?? 1 }, () => x.labels));
const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
const issueTask = workerManifest.tasks!['partners.issue_access_slip']!;
const purgeTask = workerManifest.tasks!['partners.purge_access_slips']!;

// ---------------------------------------------------------------------------------------------------------------- API side
function api(o: { enabled?: boolean | null } = {}) {
  const w: World = makeWorld14(); const st = makeStorage(); seed14(w, st, o.enabled === undefined ? {} : { enabled: o.enabled });
  const r = makeSlipCtx(w, 'adminX', H, st); const m = spy(); r.ctx.metrics = m;
  return { w, st, m, run: r.run };
}
describe('T23 access_slips_total — API side (R4 request, R6 download)', () => {
  it('R4 issuePatientAccessSlip 202 -> exactly one {outcome:"requested"}', async () => {
    const s = api();
    const res = await s.run('issuePatientAccessSlip', { params: { report_id: RPT.b }, headers: { 'idempotency-key': 'key-0001' }, body: {} });
    expect(res.status).toBe(202);
    expect(outcomes(s.m)).toEqual([{ outcome: 'requested' }]);
  });

  it('R4 refused (feature flag off 403, unknown report 404) emits nothing', async () => {
    const off = api({ enabled: false });
    await expect(off.run('issuePatientAccessSlip', { params: { report_id: RPT.b }, headers: { 'idempotency-key': 'key-0001' }, body: {} })).rejects.toBeInstanceOf(LimsError);
    expect(outcomes(off.m)).toEqual([]);
    const on = api();
    await expect(on.run('issuePatientAccessSlip', { params: { report_id: RPT.unknown }, headers: { 'idempotency-key': 'key-0002' }, body: {} })).rejects.toBeInstanceOf(LimsError);
    expect(outcomes(on.m)).toEqual([]);
  });

  it('R6 downloadPatientAccessSlip 200 -> one {outcome:"downloaded"} per download; an unknown slip (404) emits nothing', async () => {
    const s = api();
    expect((await s.run('downloadPatientAccessSlip', { params: { report_id: RPT.b, access_slip_id: SL.issued } })).status).toBe(200);
    expect((await s.run('downloadPatientAccessSlip', { params: { report_id: RPT.b, access_slip_id: SL.issued } })).status).toBe(200);
    expect(outcomes(s.m)).toEqual([{ outcome: 'downloaded' }, { outcome: 'downloaded' }]);
    await expect(s.run('downloadPatientAccessSlip', { params: { report_id: RPT.b, access_slip_id: SL.b } })).rejects.toBeInstanceOf(LimsError); // tenant B's slip
    expect(outcomes(s.m)).toHaveLength(2);
  });

  it('R5 getPatientAccessSlip (poll) is a read: no metric', async () => {
    const s = api(); await s.run('getPatientAccessSlip', { params: { report_id: RPT.b, access_slip_id: SL.req } });
    expect(outcomes(s.m)).toEqual([]);
  });

  it('labels: only `outcome`, no slip / report / user ids, no URL or token', async () => {
    const s = api(); await s.run('issuePatientAccessSlip', { params: { report_id: RPT.b }, headers: { 'idempotency-key': 'key-0001' }, body: {} });
    for (const x of s.m.incs.filter((i) => i.name === SLIPS)) expect(Object.keys(x.labels)).toEqual(['outcome']);
    expect(JSON.stringify(s.m.incs)).not.toMatch(/01940e00|portal\.invalid/); expect(leaksIn([s.m.incs, s.m.obs])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- worker side
function setup() { const w: World = makeWorld14(); const st = makeStorage(); seed14(w, st); return { w, st, ports: makePorts(w) }; }
type S = ReturnType<typeof setup>;
async function job(s: S, handler: (p: any, c: any) => Promise<unknown>, payload: unknown, over: { now?: string; attempt?: number } = {}) {
  const jc = makeSlipJob(s.w, s.st, s.ports, over); const m = spy(); jc.ctx.metrics = m; const snap = s.w.snapshot(); let threw: any;
  try { await handler(payload, jc.ctx); } catch (e) { threw = e; s.w.restore(snap); }
  return { threw, m, logs: jc.logs };
}
const issue = (s: S, slip: string, over: { now?: string } = {}) => job(s, issueTask, { tenant_id: T_A, access_slip_id: slip }, over);

describe('T23 access_slips_total + access_slip_issue_seconds — task partners.issue_access_slip', () => {
  it('success -> {outcome:"issued"} once and ONE issue_seconds observation = request -> issued (created_at 05:59:00Z, job now 06:00:00Z => 60 s), no labels', async () => {
    const s = setup(); const r = await issue(s, SL.req, { now: '2026-11-13T06:00:00.000Z' });
    expect(r.threw).toBeUndefined(); expect(slipById(s.w, SL.req)!['state']).toBe('issued');
    expect(outcomes(r.m)).toEqual([{ outcome: 'issued' }]);
    const o = r.m.obs.filter((x) => x.name === ISSUE_S);
    expect(o).toHaveLength(1); expect(o[0]!.labels).toEqual({});
    expect(o[0]!.value!).toBeGreaterThanOrEqual(59); expect(o[0]!.value!).toBeLessThanOrEqual(61);
  });

  it.each(['reporting.report_not_released', 'reporting.report_superseded'])('business error %s from the port -> state failed -> {outcome:"failed"} once, no issue_seconds; the replay of a failed slip emits nothing more', async (code) => {
    const s = setup(); s.ports.ctl.issueErr = new LimsError(code as never);
    const r = await issue(s, SL.req);
    expect(r.threw).toBeUndefined(); expect(slipById(s.w, SL.req)!['state']).toBe('failed');
    expect(outcomes(r.m)).toEqual([{ outcome: 'failed' }]);
    expect(r.m.obs.filter((x) => x.name === ISSUE_S)).toEqual([]);
    const again = await issue(s, SL.req); expect(outcomes(again.m)).toEqual([]);
  });

  it.each(['reporting.template_invalid', 'common.payload_too_large'])('render business error %s -> failed', async (code) => {
    const s = setup(); s.ports.ctl.renderErr = new LimsError(code as never);
    const r = await issue(s, SL.req); expect(r.threw).toBeUndefined();
    expect(outcomes(r.m)).toEqual([{ outcome: 'failed' }]);
  });

  it('transient render error (reporting.render_unavailable): the task throws for the queue retry, the slip is NOT counted failed / issued yet; the retry then counts issued once', async () => {
    const s = setup(); s.ports.ctl.renderErr = () => new LimsError('reporting.render_unavailable');
    const first = await issue(s, SL.req); expect(first.threw).toBeDefined();
    expect(outcomes(first.m)).toEqual([]); expect(first.m.obs.filter((x) => x.name === ISSUE_S)).toEqual([]);
    const second = await job(s, issueTask, { tenant_id: T_A, access_slip_id: SL.req }, { attempt: 2 });
    expect(second.threw).toBeUndefined(); expect(outcomes(second.m)).toEqual([{ outcome: 'issued' }]);
  });

  it('an already issued slip (redelivered job) is a no-op: no second `issued`, no issue_seconds', async () => {
    const s = setup(); await issue(s, SL.req);
    const again = await issue(s, SL.req);
    expect(outcomes(again.m)).toEqual([]); expect(again.m.obs).toEqual([]);
  });

  it('08 A2.1 / ST: the portal URL and token never reach a metric label or value', async () => {
    const s = setup(); const r = await issue(s, SL.req);
    expect(leaksIn([r.m.incs, r.m.obs])).toEqual([]); expect(JSON.stringify([r.m.incs, r.m.obs])).not.toContain(TOKEN);
    for (const x of r.m.incs.filter((i) => i.name === SLIPS)) expect(Object.keys(x.labels)).toEqual(['outcome']);
  });
});

describe('T23 access_slips_total — task partners.purge_access_slips', () => {
  const old = (s: S, sid: string, link: string, expires: string, extra: Record<string, unknown> = {}) =>
    issuedSlip(s.w, s.st, { id: sid, partner_id: P.x, link_id: link, link_expires_at: new Date(expires), ...extra });

  it('two issued slips past link_expires_at -> two {outcome:"expired"} (sum of `by` = 2); a still valid one and an already expired one add nothing', async () => {
    const s = setup(); old(s, SL.old1, LINK.old1, '2026-11-01T06:00:00Z'); old(s, SL.old2, LINK.old2, '2026-11-10T06:00:00Z'); old(s, SL.fresh, LINK.fresh, '2026-12-05T06:00:00Z');
    const r = await job(s, purgeTask, { tenant_id: T_A });
    expect(r.threw).toBeUndefined();
    expect(slipById(s.w, SL.old1)!['state']).toBe('expired'); expect(slipById(s.w, SL.old2)!['state']).toBe('expired'); expect(slipById(s.w, SL.fresh)!['state']).toBe('issued');
    expect(outcomes(r.m)).toEqual([{ outcome: 'expired' }, { outcome: 'expired' }]);
    const again = await job(s, purgeTask, { tenant_id: T_A }); expect(outcomes(again.m)).toEqual([]);
  });

  it('nothing to purge -> no metric', async () => {
    const s = setup(); const r = await job(s, purgeTask, { tenant_id: T_A });
    expect(outcomes(r.m)).toEqual([]);
  });
});
