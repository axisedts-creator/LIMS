// C13 T23 — Observability. Part 2/4: metric SPIES on manifest transitions (M1/M8/M9/M10, SI3), line conversion (task partners.convert_manifest_line) and the partner-inactive rejection (partnerContext).
// Spec: 02-TRD §13 metric table (lims_partners_manifests_total{transition}, lims_partners_line_conversions_total{outcome,failure_code}, lims_partners_conversion_duration_seconds, lims_partners_partner_inactive_rejections_total),
//       §3/§6.3 line states, 03-APP-FLOW §2.1/§2.2, 07-SECURITY (no PHI / ids in labels, REQ-SEC-045/133), 01-PRD US-04.x / US-06.x / US-02.6.
// LD-140 (UI only) does not apply: backend task.
// SEAM (the request ctx has no `metrics` yet; same seam as report.service.ts / tracking-api.test.ts): ctx.metrics.inc(name, labels?, by?) / ctx.metrics.observe(name, value, labels?). The world ctx is given a recording spy.
// SEAM label vocabulary: manifests_total transition = the manifest state reached (created | submitted | withdrawn | discarded | received | partially_received), emitted ONCE per successful transition, never on a rejected one
//       (a request rolled back by the pipeline must not count). line_conversions_total outcome converted | replayed (port answered replayed:true) | failed_business (line conversion_failed, failure_code = the error code) |
//       failed_infra (the task throws for retry). conversion_duration_seconds: one observe(seconds >= 0, no labels) per attempt that reached the port and finished (converted / replayed / failed_business).
//       partner_inactive_rejections_total: inc(name) with no labels, once per 403 partners.partner_inactive.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { convertManifestLine } from '../../../../../worker/src/jobs/partners/tasks/partners.convert_manifest_line.js';
import { createManifest } from '../handlers/createManifest.js';
import { discardManifest } from '../handlers/discardManifest.js';
import { receiveManifest } from '../handlers/receiveManifest.js';
import { submitManifest } from '../handlers/submitManifest.js';
import { withdrawManifest } from '../handlers/withdrawManifest.js';
import { partnerContext } from '../service/partner-context.service.js';
import { BR, CE, id, M, makeCtx9, makeFrontdesk, makeJobCtx, makeStaffCtx, makeWorld9, makeWorld10, markerPort, OR, P, PT, RF, release, releaseLocks, STAFF_ID, SYS, T_A, USERS, type Row, type World10 } from './conversion.world.js';

type Rec = { name: string; labels: Record<string, unknown>; value?: number; by?: number };
function spy() {
  const incs: Rec[] = [], sets: Rec[] = [], obs: Rec[] = [];
  return {
    incs, sets, obs,
    inc: (name: string, labels: Record<string, unknown> = {}, by = 1) => { incs.push({ name, labels, by }); },
    set: (name: string, value: number, labels: Record<string, unknown> = {}) => { sets.push({ name, labels, value }); },
    observe: (name: string, value: number, labels: Record<string, unknown> = {}) => { obs.push({ name, labels, value }); },
  };
}
type Spy = ReturnType<typeof spy>;
const labelsOf = (s: Spy, name: string) => s.incs.filter((x) => x.name === name).map((x) => x.labels);
const MF = 'lims_partners_manifests_total', LC = 'lims_partners_line_conversions_total', DUR = 'lims_partners_conversion_duration_seconds', INACTIVE = 'lims_partners_partner_inactive_rejections_total';
const allPartners = (s: Spy) => [...s.incs, ...s.sets, ...s.obs].filter((x) => x.name.startsWith('lims_partners_'));

const IFM = (v: number) => ({ 'if-match': `"${v}"` });
const req = (o: { manifest_id?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  ({ params: { ...(o.manifest_id ? { manifest_id: o.manifest_id } : {}) }, query: {}, headers: o.headers ?? {}, body: o.body });
type Out = { status: number; body: any };
const callP = (h: (r: any, c: any) => Promise<unknown>, ctx: any, r: unknown) => (h(r, ctx) as Promise<Out>).finally(() => releaseLocks(ctx.tx));
const callS = (h: (r: any, c: any) => Promise<unknown>, ctx: any, r: unknown) => (h(r, ctx) as Promise<Out>).finally(() => release(ctx));
const rejects = async (p: Promise<unknown>, code: string) => { const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x); expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe(code); };

/** partner-side ctx with the metrics spy (partner x1 on a fresh T08/T09 world). */
const partnerCtx = (w = makeWorld9()) => { const r = makeCtx9(w); const m = spy(); r.ctx.metrics = m; return { w, ctx: r.ctx, m }; };
const GOOD_LINE: Row = { patient_full_name: 'Synthetic Patient Good', patient_sex: 'male', patient_birth_on: '1990-05-17', patient_age_years: null, patient_phone_e164: '+15555550142', partner_sample_ref: 'SYN-A',
  collected_at: new Date('2026-11-12T09:30:00Z'), referrer_id: RF.x1, priority: 'urgent', consent_sms: true, consent_share_with_referrer: true, orderable_ids: [OR.glu, OR.cbc, OR.tsh],
  orderables_snapshot: [{ orderable_id: OR.glu, kind: 'test', code: 'GLU', name: 'Glucose Fasting' }, { orderable_id: OR.cbc, kind: 'panel', code: 'CBC', name: 'Complete Blood Count' }, { orderable_id: OR.tsh, kind: 'test', code: 'TSH', name: 'Thyroid Stimulating Hormone' }] };

describe('T23 manifests_total{transition}: once per successful transition, nothing on a rejected one', () => {
  it('createManifest (M1) -> created', async () => {
    const { ctx, m } = partnerCtx();
    expect((await callP(createManifest, ctx, req({ body: {} }))).status).toBe(201);
    expect(labelsOf(m, MF)).toEqual([{ transition: 'created' }]);
  });

  it('discardManifest (M10) -> discarded; a second discard (409) emits nothing more', async () => {
    const { w, ctx, m } = partnerCtx();
    expect((await callP(discardManifest, ctx, req({ manifest_id: M.x1, headers: IFM(3) }))).status).toBe(200);
    expect(labelsOf(m, MF)).toEqual([{ transition: 'discarded' }]);
    await rejects(callP(discardManifest, makeCtx9(w).ctx, req({ manifest_id: M.x1, headers: IFM(4) })), 'partners.manifest_invalid_transition');
    expect(labelsOf(m, MF)).toHaveLength(1);
  });

  it('submitManifest (M8) -> submitted, ONE emission however many lines; a 0-line submit (422) emits nothing', async () => {
    const { w, ctx, m } = partnerCtx();
    const ok = w.mkManifest({ version: 5 }); w.mkLine(ok['id'], GOOD_LINE); w.mkLine(ok['id'], { ...GOOD_LINE, partner_sample_ref: 'SYN-B' }); ok['line_count'] = 2;
    expect((await callP(submitManifest, ctx, req({ manifest_id: ok['id'], headers: IFM(5), body: {} }))).status).toBe(200);
    expect(labelsOf(m, MF)).toEqual([{ transition: 'submitted' }]);
    const empty = w.mkManifest({ version: 5 }); empty['line_count'] = 0;
    const c2 = partnerCtx(w); await rejects(callP(submitManifest, c2.ctx, req({ manifest_id: empty['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid');
    expect(labelsOf(c2.m, MF)).toEqual([]);
  });

  it('withdrawManifest (M9) -> withdrawn; withdrawing again (409) emits nothing', async () => {
    const { w, ctx, m } = partnerCtx();
    const mf = w.mkManifest({ state: 'submitted', version: 4, line_count: 1, submitted_by: USERS.x1.actor }); w.mkLine(mf['id'], { state: 'submitted', partner_sample_ref: 'SYN-W0' });
    expect((await callP(withdrawManifest, ctx, req({ manifest_id: mf['id'], headers: IFM(4), body: { reason_code: 'entered_in_error' } }))).status).toBe(200);
    expect(labelsOf(m, MF)).toEqual([{ transition: 'withdrawn' }]);
    const c2 = partnerCtx(w); await rejects(callP(withdrawManifest, c2.ctx, req({ manifest_id: mf['id'], headers: IFM(5), body: { reason_code: 'entered_in_error' } })), 'partners.manifest_invalid_transition');
    expect(labelsOf(c2.m, MF)).toEqual([]);
  });

  describe('receiveManifest (SI3): the state the receipt leaves the manifest in', () => {
    const recv = () => {
      const w = makeWorld10(); const m = w.mkManifest({ state: 'submitted', version: 4, line_count: 4, submitted_by: USERS.x1.actor });
      const ls = [1, 2, 3, 4].map((i) => w.mkLine(m['id'], { state: 'submitted', partner_sample_ref: `SYN-R${i}`, patient_full_name: `Synthetic Patient R${i}` }));
      const s = makeStaffCtx(w, { centres: [CE.a1] }); const sp = spy(); s.ctx.metrics = sp;
      return { w, m, ls, ctx: s.ctx, sp };
    };
    const lines = (ls: Row[], n: number) => ({ lines: ls.slice(0, n).map((l) => ({ line_id: l['id'], outcome: 'received' })) });

    it('3 of 4 lines received -> partially_received', async () => {
      const { m, ls, ctx, sp } = recv();
      expect((await callS(receiveManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: lines(ls, 3) }))).body.state).toBe('partially_received');
      expect(labelsOf(sp, MF)).toEqual([{ transition: 'partially_received' }]);
    });
    it('all 4 lines received -> received', async () => {
      const { m, ls, ctx, sp } = recv();
      expect((await callS(receiveManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: lines(ls, 4) }))).body.state).toBe('received');
      expect(labelsOf(sp, MF)).toEqual([{ transition: 'received' }]);
    });
    it('a refused receipt (stale If-Match 409) emits nothing', async () => {
      const { m, ls, ctx, sp } = recv();
      await rejects(callS(receiveManifest, ctx, req({ manifest_id: m['id'], headers: IFM(1), body: lines(ls, 1) })), 'common.version_conflict');
      expect(labelsOf(sp, MF)).toEqual([]);
    });
  });

  it('labels: only `transition`, only the TRD vocabulary, no ids / names', async () => {
    const { ctx, m } = partnerCtx(); await callP(createManifest, ctx, req({ body: { notes: 'Synthetic box note' } }));
    expect(allPartners(m).length).toBeGreaterThan(0);
    for (const r of allPartners(m)) { expect(Object.keys(r.labels)).toEqual(['transition']); expect(['created', 'submitted', 'withdrawn', 'discarded', 'received', 'partially_received']).toContain(r.labels['transition']); }
    expect(JSON.stringify(allPartners(m))).not.toContain('Synthetic');
  });
});

// ---------------------------------------------------------------------------------------------------------------- conversion
const NOW = '2026-11-13T00:00:00.000Z';
function conv(lineOver: Row = {}) {
  const w: World10 = makeWorld10(); const fd = makeFrontdesk({}); const port = markerPort(fd, []);
  const mf = w.mkManifest({ state: 'partially_received', version: 5, line_count: 1, submitted_by: USERS.x1.actor });
  const l = w.mkLine(mf['id'], { state: 'converting', conversion_attempt: 1, sample_received_at: new Date('2026-11-12T10:00:00Z'), received_by: STAFF_ID, partner_sample_ref: 'SYN-1', patient_full_name: 'Synthetic Patient Zed', ...lineOver });
  const run = async (over: { port?: unknown } = {}) => {
    const jc = makeJobCtx(w, { port: over.port ?? port }); const m = spy(); jc.ctx.metrics = m;
    let threw: any; try { await convertManifestLine({ tenant_id: T_A, line_id: l['id'], attempt: 1 }, jc.ctx); } catch (e) { threw = e; } finally { release(jc.ctx); }
    return { threw, m, logs: jc.logs };
  };
  return { w, fd, l, run, line: () => w.lines.find((x) => x['id'] === l['id'])! };
}
const durations = (m: Spy) => m.obs.filter((x) => x.name === DUR);

describe('T23 line_conversions_total{outcome,failure_code} + conversion_duration_seconds (task partners.convert_manifest_line)', () => {
  it('success -> outcome converted, one duration observation (>= 0 seconds, no labels)', async () => {
    const s = conv(); const r = await s.run();
    expect(r.threw).toBeUndefined(); expect(s.line()['state']).toBe('converted');
    expect(labelsOf(r.m, LC)).toEqual([expect.objectContaining({ outcome: 'converted' })]);
    expect(durations(r.m)).toHaveLength(1);
    expect(Number.isFinite(durations(r.m)[0]!.value)).toBe(true); expect(durations(r.m)[0]!.value!).toBeGreaterThanOrEqual(0); expect(durations(r.m)[0]!.labels).toEqual({});
  });

  it('port replays an earlier committed call (replayed:true) -> outcome replayed, not converted', async () => {
    const s = conv(); const sysCtx = { tenantId: T_A, actor: { type: 'system', id: SYS }, now: () => NOW, tx: {} };
    await s.fd.createOrderFromBooking(sysCtx, { source: 'partner_manifest', sourceRefId: s.l['id'], partnerId: P.x, patient: { patientId: PT }, branchId: BR.a1, centreId: CE.a1, orderableIds: [OR.glu], priority: 'routine',
      confirmImmediately: true, idempotencyKey: `partners:${s.l['id']}:v1` });
    const r = await s.run();
    expect(r.threw).toBeUndefined(); expect(s.line()['state']).toBe('converted');
    expect(labelsOf(r.m, LC)).toEqual([expect.objectContaining({ outcome: 'replayed' })]);
  });

  it.each(['frontdesk.patient_duplicate_suspected', 'catalog.no_price', 'catalog.test_inactive', 'frontdesk.consent_required'])('business failure %s -> failed_business with failure_code = the code (task resolves)', async (code) => {
    const s = conv(); s.fd.failNext('createOrderFromBooking', code);
    const r = await s.run();
    expect(r.threw).toBeUndefined(); expect(s.line()['state']).toBe('conversion_failed');
    expect(labelsOf(r.m, LC)).toEqual([{ outcome: 'failed_business', failure_code: code }]);
    expect(durations(r.m)).toHaveLength(1);
  });

  it.each(['common.dependency_unavailable', 'common.internal'])('infrastructure failure %s -> failed_infra (the task still throws for the queue retry)', async (code) => {
    const s = conv(); s.fd.failNext('createOrderFromBooking', code);
    const r = await s.run();
    expect((r.threw as any)?.code).toBe(code);
    expect(labelsOf(r.m, LC)).toEqual([expect.objectContaining({ outcome: 'failed_infra' })]);
    const fc = labelsOf(r.m, LC)[0]!['failure_code']; if (fc !== undefined) expect(fc).toMatch(/^[a-z_]+\.[a-z_]+$/); // bounded: an errors.yaml code, never a message
  });

  it('a connection error (plain Error) is failed_infra and the label carries no error message / host', async () => {
    const s = conv(); const down = Object.assign(new Error('ECONNRESET db-host-7.internal'), { code: 'ECONNRESET' });
    const r = await s.run({ port: { async createOrderFromBooking() { throw down; } } });
    expect(r.threw).toBe(down);
    expect(labelsOf(r.m, LC)).toEqual([expect.objectContaining({ outcome: 'failed_infra' })]);
    expect(JSON.stringify(labelsOf(r.m, LC))).not.toMatch(/db-host|ECONNRESET/);
  });

  it('labels: only outcome / failure_code; no ids, no patient / partner data, even for a line with synthetic PHI', async () => {
    const s = conv({ patient_phone_e164: '+15555550177', partner_sample_ref: 'SYN-REF-77' }); const r = await s.run();
    expect(r.m.incs.length).toBeGreaterThan(0);
    for (const x of [...r.m.incs, ...r.m.obs, ...r.m.sets]) {
      expect(['outcome', 'failure_code']).toEqual(expect.arrayContaining(Object.keys(x.labels)));
      expect(JSON.stringify(x)).not.toMatch(/Synthetic Patient|\+1555555|SYN-REF|SYN-1\b|01940e00/);
    }
  });

  it('a delivery that does nothing (line already converted, unknown line) emits no conversion metric', async () => {
    const s = conv({ state: 'converted', order_id: id(7301), registration_no: '0001SY000301', converted_at: new Date('2026-11-12T01:00:00Z') });
    const r = await s.run(); expect(r.threw).toBeUndefined();
    expect(labelsOf(r.m, LC)).toEqual([]); expect(durations(r.m)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- partner inactive
function inactiveTx(rows: Row[]) {
  const tx: any = { startedAt: new Date(), operation: {}, savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    async query(text: string) {
      if (/\bFROM\s+partners\.partner_users\b/i.test(text)) return { rows };
      if (/\bFROM\s+partners\.settings\b/i.test(text)) return { rows: [] };
      if (/^\s*UPDATE\b/i.test(text)) return { rows: [] };
      throw new Error(`unexpected SQL in partner context: ${text}`);
    } };
  return tx;
}
const userRow = (over: Row = {}): Row => ({ partner_user_id: id(20), partner_id: P.x, partner_role: 'partner_admin', user_status: 'active', partner_status: 'active', display_name: 'Synthetic User', partner_code: 'SYN-X',
  partner_name: 'Synthetic Partner X', conversion_mode: 'on_receipt', access_slip_enabled: null, include_default_price_list: null, ...over });
const pctx = (rows: Row[], m: Spy): any => ({ tenantId: T_A, actor: { type: 'partner', id: id(20), membershipId: id(30) }, requestId: id(99), tx: inactiveTx(rows), now: () => NOW, metrics: m,
  log: { info() {}, warn() {}, error() {}, debug() {} }, core: {}, ports: {} });

describe('T23 partner_inactive_rejections_total (no labels): once per 403 partners.partner_inactive (US-02.6, AB8/AB9)', () => {
  it('suspended partner -> 403 partners.partner_inactive, counter +1', async () => {
    const m = spy(); await rejects(partnerContext.require(pctx([userRow({ partner_status: 'suspended' })], m)), 'partners.partner_inactive');
    expect(m.incs.filter((x) => x.name === INACTIVE)).toEqual([{ name: INACTIVE, labels: {}, by: 1 }]);
  });
  it('deactivated user (RLS hides the row) -> 403 partners.partner_inactive, counter +1', async () => {
    const m = spy(); await rejects(partnerContext.require(pctx([], m)), 'partners.partner_inactive');
    expect(m.incs.filter((x) => x.name === INACTIVE)).toHaveLength(1);
  });
  it('active partner and user -> resolves, no rejection counted', async () => {
    const m = spy(); await partnerContext.require(pctx([userRow()], m));
    expect(m.incs.filter((x) => x.name === INACTIVE)).toEqual([]);
  });
});
