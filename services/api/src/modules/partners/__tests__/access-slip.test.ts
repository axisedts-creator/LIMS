// C13 T14 — patient access slip, API side: R4 issuePatientAccessSlip, R5 getPatientAccessSlip, R6 downloadPatientAccessSlip (06-IMPLEMENTATION-PLAN row T14).
// Tests: integration (in-memory SQL world) + probes + log-scan. ACs: US-09.1 (flag off -> 403), US-09.2 (202 id+state only, no token/URL), US-09.4 (poll / failed state), US-09.5 (no phone: request accepted), US-09.6 (download, no-store, access log on every download).
// done_when (API part): feature flag 403; R4 makes no port call (partner claims); URL/token absent from every column, job payload, log, R4/R5/R6 response and core.idempotency_keys; access-log row on every download; R6 with no file -> 404 common.not_found.
// Spec: 01-PRD US-09; 02-TRD §5.2 R4-R6, §8.1 (partners.issue_access_slip), §13 (access-log table: R6 -> report.access_slip / access_slip), §15 (tests); 03-APP-FLOW §5.5; 05-SCHEMA §3.7a; 07-SECURITY ST12, ST12a; 08 A2.1, A5.2, A5.3, A19 D-105; contracts/openapi/partners.yaml (AccessSlip).
// LEAD DECISION LD-140 (UI only) does not apply: backend part. The worker part (issue / purge tasks, end-to-end spine) is services/worker/src/jobs/partners/__tests__/access-slip.test.ts.
// Handlers are exercised through manifest.handlers[operationId]. Fixture + SQL subset + guard emulation: access-slip.world.ts (header).
// SEAMS (spec does not fix them; the writer follows them or disputes):
//  - Order (as T13): ctx.actor.type === 'partner' else 403 auth.forbidden (no SQL) -> IdentityPort.assertRole(ctx,{permission:'partners.report.read'}) -> partnerContext.require(ctx) (inactive partner -> 403 partners.partner_inactive)
//    -> request validation (path ids must be UUIDs, else 400 common.validation_failed, before SQL on access_slips) -> R4: flag, then the report lookup (flag off + unknown report = 403, not 404).
//  - Flag = partners.settings.access_slip_enabled of the CALLER'S tenant (no settings row = false, A17 P-22). Every statement on the data tables binds tenant_id AND partner_id (no RLS emulated); single-table SQL only.
//  - R4: the report must have a row in partners.order_reports with status 'valid' for (tenant, partner) -> version_no and order_id come from it; INSERT (state 'requested' = the default) under the PARTNER guard
//    (the world refuses a partner UPDATE/DELETE and any non-requested INSERT, so R4/R5/R6 must never touch a slip row with UPDATE); `SELECT app.enqueue_job($1, $2::jsonb, $3)` in the same transaction with
//    identifier 'partners.issue_access_slip', job_key `slip:<id>` and payload { tenant_id, access_slip_id } (payload = ids only). Response 202 { id, report_id, version_no, state:'requested', created_at } (ISO of ctx.now()).
//  - R5/R6 find the slip by (tenant_id, partner_id, report_id, id) of the caller (path report_id must match the slip's report), any member of the same partner may read / download it. Unknown / foreign / mismatching = 404 common.not_found.
//    R5 DTO: the AccessSlip properties only, null columns omitted. R6: only state 'issued'; bytes via ctx.download.stream({bucket:'partners-slips', objectPath: file_path, ...}) OR ctx.storage.read('partners-slips', file_path) + ctx.audit.access
//    (both exist on the test ctx; either route is accepted: the tests look at the storage call, the response and the access log). No fetch / signed URL. Headers: content-type application/pdf, content-disposition attachment with
//    filename="access-slip-<id>.pdf", cache-control no-store, x-content-type-options nosniff. Access log (every download): { action:'report.access_slip', entityType:'access_slip', entityId:<slip id>, outcome:'allowed', detail:{access_slip_id, link_id} }.
//  - The R6 BODY is the slip PDF, which legitimately contains the URL (QR + text); every other output is scanned for the planted marker SLIPTOKEN / portal.invalid.
//  - NOT tested (spec gap / other owner): metrics (lims_partners_access_slips_total is T23), the general rate tier (core), Idempotency-Key replay itself (core pipeline; the stored response body is checked here), denied-log on R6 404.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest } from '../index.js';
import { BUCKET, LINK, leaksIn, makeStorage, makeSlipCtx, makeWorld14, ORD, P, RPT, RPT_SUP, SL, seed14, slipById, slipPdf, slipPath, slipTx, slips, T_A, T_B, TOKEN, U, worldLeaks, NOW13, type Opts, type Storage, type Who, type World } from './access-slip.world.js';

afterEach(() => vi.unstubAllGlobals());
const id7 = (n: number) => `01940e00-0000-7000-8000-c1317${String(n).padStart(7, '0')}`;
const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
const R4 = 'issuePatientAccessSlip', R5 = 'getPatientAccessSlip', R6 = 'downloadPatientAccessSlip';
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AccessSlipProps = ['id', 'report_id', 'version_no', 'state', 'created_at', 'link_expires_at', 'failure_code', 'issued_at'];
const hdr = (h: Record<string, string> = {}) => Object.fromEntries(Object.entries(h).map(([a, b]) => [a.toLowerCase(), b]));
const fails = async (p: Promise<unknown>, code: string, status?: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e, String(e?.message)).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  if (status) expect(e.statusCode).toBe(status);
  return e as LimsError;
};

function setup(o: { enabled?: boolean | null; who?: Who; ctx?: Opts } = {}) {
  const w: World = makeWorld14(); const st = makeStorage(); seed14(w, st, o.enabled === undefined ? {} : { enabled: o.enabled });
  const r = makeSlipCtx(w, o.who ?? 'adminX', H, st, o.ctx);
  return { w, st, ...r };
}
type S = ReturnType<typeof setup>;
const post = (s: S, report: string) => s.run(R4, { params: { report_id: report }, headers: { 'idempotency-key': 'key-0001' }, body: {} });
const get = (s: S, report: string, slip: string) => s.run(R5, { params: { report_id: report, access_slip_id: slip } });
const file = (s: S, report: string, slip: string) => s.run(R6, { params: { report_id: report, access_slip_id: slip } });
const slipWrites = (w: World) => w.writes().filter((q) => /access_slips/i.test(q.text));
const accessRows = (w: World) => w.audit.filter((e) => e.action === 'report.access_slip');
const noFetch = () => { const f = vi.fn(async () => { throw new Error('fetch must not be called'); }); vi.stubGlobal('fetch', f); return f; };

// ================================================================== R4
describe('R4 issuePatientAccessSlip (US-09.1, US-09.2, US-09.5)', () => {
  it('US-09.1: setting access_slip_enabled = false -> 403 common.feature_disabled; no row, no job, no write, no port call', async () => {
    const s = setup({ enabled: false }); const before = slips(s.w).length;
    await fails(post(s, RPT.b), 'common.feature_disabled', 403);
    expect(slips(s.w)).toHaveLength(before); // the seeded rows only
    expect(s.w.jobs).toHaveLength(0);
    expect(slipWrites(s.w)).toHaveLength(0);
    expect(s.denied).toEqual([]);
  });

  it('US-09.1: no settings row yet (lazy row, default false) -> 403 common.feature_disabled', async () => {
    const s = setup({ enabled: null });
    await fails(post(s, RPT.b), 'common.feature_disabled', 403);
    expect(s.w.jobs).toHaveLength(0);
  });

  it('the flag is checked before the report lookup: flag off + unknown report -> 403, not 404', async () => {
    const s = setup({ enabled: false });
    await fails(post(s, RPT.unknown), 'common.feature_disabled', 403);
  });

  it('the flag is the CALLER\'S tenant setting: tenant A off + tenant B on -> A 403, B 202 (B\'s flag never applies to A)', async () => {
    const w = makeWorld14(); const st = makeStorage(); seed14(w, st, { enabled: false });
    w.t['partners.settings']!.push({ tenant_id: T_B, access_slip_enabled: true, include_default_price_list: true, report_download_daily_cap_per_user: 500 });
    await fails(makeSlipCtx(w, 'adminX', H, st).run(R4, { params: { report_id: RPT.b }, body: {} }), 'common.feature_disabled', 403);
    const b = await makeSlipCtx(w, 'adminB', H, st).run(R4, { params: { report_id: RPT.bb }, headers: { 'idempotency-key': 'k-b' }, body: {} });
    expect(b.status).toBe(202);
    expect(slipById(w, b.body.id, T_B)).toMatchObject({ tenant_id: T_B, partner_id: P.b, report_id: RPT.bb });
  });

  it('US-09.2: 202 with { id, report_id, version_no, state: requested, created_at } only', async () => {
    const s = setup();
    const res = await post(s, RPT.b);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['created_at', 'id', 'report_id', 'state', 'version_no']);
    expect(res.body).toMatchObject({ report_id: RPT.b, version_no: 1, state: 'requested' });
    expect(res.body.id).toMatch(UUIDV7);
    expect(new Date(res.body.created_at).toISOString()).toBe(NOW13);
  });

  it('records the request in partners.access_slips: state requested, version = the VALID version at request time, order and requester from the token', async () => {
    const s = setup();
    const a = await post(s, RPT.a); // v1 superseded, v2 valid
    expect(a.body.version_no).toBe(2);
    const row = slipById(s.w, a.body.id)!;
    expect(row).toMatchObject({ tenant_id: T_A, partner_id: P.x, partner_user_id: U.adminX, report_id: RPT.a, version_no: 2, order_id: ORD.rep, state: 'requested', created_by: U.adminX });
    for (const c of ['link_id', 'link_expires_at', 'file_path', 'file_sha256', 'file_byte_size', 'failure_code', 'issued_at', 'expired_at']) expect(row[c] ?? null, c).toBeNull();
    const m = await makeSlipCtx(s.w, 'memberX', H, s.st).run(R4, { params: { report_id: RPT.b }, body: {} }); // a member of the same partner may request
    expect(slipById(s.w, m.body.id)).toMatchObject({ partner_user_id: U.memberX, created_by: U.memberX });
  });

  it('two requests make two distinct rows with distinct ids (no dedupe in the spec)', async () => {
    const s = setup();
    const a = await post(s, RPT.b), b = await post(s, RPT.b);
    expect(a.body.id).not.toBe(b.body.id);
    expect(slips(s.w).filter((r) => r['id'] === a.body.id || r['id'] === b.body.id)).toHaveLength(2);
  });

  it('enqueues partners.issue_access_slip in the same transaction: job_key slip:<id>, payload = ids only', async () => {
    const s = setup();
    const res = await post(s, RPT.b);
    expect(s.w.jobs).toHaveLength(1);
    expect(s.w.jobs[0]).toMatchObject({ identifier: 'partners.issue_access_slip', jobKey: `slip:${res.body.id}` });
    expect(s.w.jobs[0]!.payload).toEqual({ tenant_id: T_A, access_slip_id: res.body.id });
  });

  it('a failing enqueue rolls the slip request back (one transaction): no orphan row without a job', async () => {
    const s = setup(); const before = slips(s.w).length;
    s.w.failNext(/enqueue_job/);
    await expect(post(s, RPT.b)).rejects.toThrow();
    expect(slips(s.w)).toHaveLength(before);
    expect(s.w.jobs).toHaveLength(0);
  });

  it('ST12 / US-09.2: R4 makes NO port call under partner claims (ReportingPort, RenderPort, SmartReportPort, any other port): zero accesses; only IdentityPort.assertRole(partners.report.read)', async () => {
    const s = setup();
    await post(s, RPT.b);
    expect(s.denied).toEqual([]);
    expect(s.roles).toEqual(['partners.report.read']);
    expect(s.portCalls).toHaveLength(0);
    expect(s.st.calls).toHaveLength(0); // and no storage access
  });

  it('404 common.not_found, nothing written: unknown report, partner Y\'s report, tenant B\'s report, a report with no valid version', async () => {
    for (const report of [RPT.unknown, RPT.y, RPT.bb, RPT_SUP]) {
      const s = setup();
      await fails(post(s, report), 'common.not_found', 404);
      expect(slipWrites(s.w)).toHaveLength(0);
      expect(s.w.jobs).toHaveLength(0);
    }
  });

  it('US-09.5 (D-105): a line without a patient mobile number is accepted (202), no extra field, no phone in the response', async () => {
    const s = setup();
    for (const l of s.w.t['partners.manifest_lines']!) l['patient_phone_e164'] = null;
    const res = await post(s, RPT.b);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['created_at', 'id', 'report_id', 'state', 'version_no']);
    expect(s.w.jobs).toHaveLength(1);
  });

  it('request validation: report_id must be a UUID -> 400 common.validation_failed, no write', async () => {
    for (const bad of ['not-a-uuid', '', '1', RPT.b.toUpperCase().slice(0, 30)]) {
      const s = setup();
      await fails(post(s, bad), 'common.validation_failed', 400);
      expect(slipWrites(s.w)).toHaveLength(0);
    }
  });

  it('ST12: nothing secret anywhere (tables, jobs, SQL text + values, access log, logs, response, stored idempotency response body)', async () => {
    const s = setup();
    const res = await post(s, RPT.b);
    const stored = JSON.stringify(res.body); // what core.idempotency_keys.response_body keeps for an R4 replay
    expect(leaksIn(res)).toEqual([]);
    expect(leaksIn(stored)).toEqual([]);
    expect(leaksIn(s.logs)).toEqual([]);
    expect(worldLeaks(s.w)).toEqual([]);
    expect(Object.keys(JSON.parse(stored)).some((k) => /url|token|link|secret/i.test(k))).toBe(false);
  });
});

// ================================================================== R5
describe('R5 getPatientAccessSlip (US-09.4)', () => {
  it('requested: { id, report_id, version_no, state: requested } and no optional field', async () => {
    const s = setup();
    const res = await get(s, RPT.b, SL.req);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: SL.req, report_id: RPT.b, version_no: 1, state: 'requested' });
    expect(Object.keys(res.body).every((k) => ['id', 'report_id', 'version_no', 'state', 'created_at'].includes(k))).toBe(true);
  });

  it('issued: link_expires_at and issued_at (ISO) are present; never the link, token, path, hash or any internal column', async () => {
    const s = setup();
    const res = await get(s, RPT.b, SL.issued);
    expect(res.body).toMatchObject({ id: SL.issued, report_id: RPT.b, version_no: 1, state: 'issued', link_expires_at: '2026-12-10T06:00:00.000Z', issued_at: '2026-11-13T05:59:30.000Z' });
    expect(Object.keys(res.body).every((k) => AccessSlipProps.includes(k))).toBe(true);
    for (const k of ['link_id', 'file_path', 'file_sha256', 'file_byte_size', 'partner_id', 'partner_user_id', 'order_id', 'tenant_id', 'url', 'token', 'portal_url']) expect(res.body, k).not.toHaveProperty(k);
  });

  it('failed: the failure code is shown (US-09.4: reporting.report_superseded / not_released / template_invalid ...)', async () => {
    const s = setup();
    const res = await get(s, RPT.b, SL.failed);
    expect(res.body).toMatchObject({ state: 'failed', failure_code: 'reporting.report_superseded' });
    expect(res.body).not.toHaveProperty('link_expires_at');
  });

  it('expired: state expired, no file field', async () => {
    const s = setup();
    const res = await get(s, RPT.b, SL.expired);
    expect(res.body).toMatchObject({ state: 'expired' });
    expect(Object.keys(res.body).every((k) => AccessSlipProps.includes(k))).toBe(true);
  });

  it('no value on the wire is null (null columns are omitted)', async () => {
    const s = setup();
    for (const slip of [SL.req, SL.issued, SL.failed, SL.expired]) {
      const res = await get(s, RPT.b, slip);
      expect(Object.values(res.body).every((v) => v !== null), slip).toBe(true);
    }
  });

  it('404 common.not_found: partner Y\'s slip, tenant B\'s slip, unknown id, and a slip addressed under another report_id', async () => {
    const s = setup();
    await fails(get(s, RPT.y, SL.y), 'common.not_found', 404);     // X asks for Y's slip
    await fails(get(s, RPT.bb, SL.b), 'common.not_found', 404);    // X asks for tenant B's slip
    await fails(get(s, RPT.b, id7(999)), 'common.not_found', 404); // unknown id
    await fails(get(s, RPT.c, SL.req), 'common.not_found', 404);   // right slip, wrong report in the path
    const y = makeSlipCtx(s.w, 'adminY', H, s.st);
    await fails(y.run(R5, { params: { report_id: RPT.b, access_slip_id: SL.req } }), 'common.not_found', 404); // Y asks for X's slip
  });

  it('request validation: report_id / access_slip_id must be UUIDs -> 400 common.validation_failed', async () => {
    const s = setup();
    await fails(get(s, 'nope', SL.req), 'common.validation_failed', 400);
    await fails(get(s, RPT.b, 'nope'), 'common.validation_failed', 400);
  });

  it('any member of the same partner can read the slip another member requested', async () => {
    const s = setup({ who: 'memberX' });
    expect((await get(s, RPT.b, SL.req)).body.id).toBe(SL.req);
  });

  it('polling is a pure read: 30 polls, no write, no port call, no storage access, no access-log row, identical answers', async () => {
    const s = setup();
    const first = await get(s, RPT.b, SL.req);
    for (let i = 0; i < 29; i++) expect((await get(s, RPT.b, SL.req)).body).toEqual(first.body);
    expect(s.w.writes()).toHaveLength(0);
    expect(s.denied).toEqual([]);
    expect(s.st.calls).toHaveLength(0);
    expect(s.w.audit).toHaveLength(0);
  });

  it('no secret anywhere in responses, logs, SQL', async () => {
    const s = setup();
    const out = []; for (const slip of [SL.req, SL.issued, SL.failed, SL.expired]) out.push(await get(s, RPT.b, slip));
    expect(leaksIn(out)).toEqual([]); expect(leaksIn(s.logs)).toEqual([]); expect(worldLeaks(s.w)).toEqual([]);
  });
});

// ================================================================== R6
describe('R6 downloadPatientAccessSlip (US-09.6)', () => {
  it('200: the stored PDF bytes, application/pdf, attachment access-slip-<id>.pdf, Cache-Control no-store, nosniff', async () => {
    const s = setup(); const f = noFetch();
    const res = await file(s, RPT.b, SL.issued);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(slipPdf(SL.issued))).toBe(true);
    const h = hdr(res.headers);
    expect(h['content-type']).toContain('application/pdf');
    expect(h['content-disposition']).toContain('attachment');
    expect(h['content-disposition']).toContain(`filename="access-slip-${SL.issued}.pdf"`);
    expect(h['cache-control']).toContain('no-store');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(f).not.toHaveBeenCalled(); // bytes are read server-side: no signed URL, no fetch
  });

  it('reads exactly the registered object of the slip, server-side: bucket partners-slips, path {tenant_id}/access-slips/{yyyy}/{mm}/{id}.pdf, once', async () => {
    const s = setup(); noFetch();
    await file(s, RPT.b, SL.issued);
    expect(s.st.calls).toEqual([{ op: 'read', bucket: BUCKET, path: slipPath(SL.issued) }]);
    expect(s.denied).toEqual([]); // no port is involved (partner claims never touch Storage or C6)
  });

  it('access log on EVERY download: report.access_slip / access_slip / slip id / allowed / detail { access_slip_id, link_id } (08 A5.3, CR-C13-012)', async () => {
    const s = setup(); noFetch();
    await file(s, RPT.b, SL.issued);
    const m = makeSlipCtx(s.w, 'memberX', H, s.st);
    await m.run(R6, { params: { report_id: RPT.b, access_slip_id: SL.issued } }); // a second member, a second download
    await file(s, RPT.b, SL.issued);                                              // and the first one again
    const rows = accessRows(s.w);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ action: 'report.access_slip', entityType: 'access_slip', entityId: SL.issued, outcome: 'allowed' });
      expect(r.detail).toMatchObject({ access_slip_id: SL.issued, link_id: LINK.issued });
    }
    expect(s.w.audit.filter((e) => e.action !== 'report.access_slip')).toHaveLength(0);
  });

  it('R6 is a pure read of the row: no UPDATE / INSERT / DELETE on any table', async () => {
    const s = setup(); noFetch();
    await file(s, RPT.b, SL.issued);
    expect(s.w.writes()).toHaveLength(0);
    expect(s.w.jobs).toHaveLength(0);
  });

  it('US-09.6 / 08 A5.3: a slip that is not issued has no file -> 404 common.not_found (requested, failed, expired); no storage read, no allowed log', async () => {
    for (const slip of [SL.req, SL.failed, SL.expired]) {
      const s = setup(); noFetch();
      await fails(file(s, RPT.b, slip), 'common.not_found', 404);
      expect(s.st.calls.filter((c) => c.op === 'read'), slip).toHaveLength(0);
      expect(accessRows(s.w).filter((r) => r.outcome === 'allowed'), slip).toHaveLength(0);
    }
  });

  it('an issued row whose object is gone (purge race, deleted object) -> 404 common.not_found, never an allowed log row', async () => {
    const s = setup(); noFetch();
    s.st.objects.delete(`${BUCKET}|${slipPath(SL.issued)}`);
    await fails(file(s, RPT.b, SL.issued), 'common.not_found', 404);
    expect(accessRows(s.w)).toHaveLength(0);
  });

  it('ST12: partner Y, tenant B, an unknown id and a wrong report_id in the path all get 404; the object is never read', async () => {
    const s = setup(); noFetch();
    await fails(file(s, RPT.y, SL.issuedY), 'common.not_found', 404);   // X asks for Y's slip
    await fails(file(s, RPT.bb, SL.issuedB), 'common.not_found', 404);  // X asks for tenant B's slip
    await fails(file(s, RPT.b, id7(999)), 'common.not_found', 404);
    await fails(file(s, RPT.c, SL.issued), 'common.not_found', 404);    // right slip, wrong report
    const y = makeSlipCtx(s.w, 'adminY', H, s.st);
    await fails(y.run(R6, { params: { report_id: RPT.b, access_slip_id: SL.issued } }), 'common.not_found', 404); // Y asks for X's slip
    expect(s.st.calls.filter((c) => c.op === 'read')).toHaveLength(0);
    expect(accessRows(s.w).filter((r) => r.outcome === 'allowed')).toHaveLength(0);
  });

  it('a storage failure surfaces as an error: no bytes, no allowed log row; the error carries no secret', async () => {
    const s = setup(); noFetch();
    s.st.fail.read = new Error('storage backend down');
    const e = await file(s, RPT.b, SL.issued).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(accessRows(s.w).filter((r) => r.outcome === 'allowed')).toHaveLength(0);
    expect(leaksIn(e)).toEqual([]);
  });

  it('request validation: path ids must be UUIDs -> 400 common.validation_failed, no storage read', async () => {
    const s = setup();
    await fails(file(s, 'nope', SL.issued), 'common.validation_failed', 400);
    await fails(file(s, RPT.b, 'nope'), 'common.validation_failed', 400);
    expect(s.st.calls).toHaveLength(0);
  });

  it('ST12: headers, access log, logs and SQL never contain the link (only the PDF body does, by design)', async () => {
    const s = setup(); noFetch();
    const res = await file(s, RPT.b, SL.issued);
    expect(Buffer.from(res.body).toString('latin1')).toContain(TOKEN); // by design: the PDF holds the link (QR + text)
    expect(leaksIn({ status: res.status, headers: res.headers })).toEqual([]);
    expect(leaksIn(s.logs)).toEqual([]);
    expect(worldLeaks(s.w)).toEqual([]);
  });
});

// ================================================================== gates (R4 R5 R6)
describe('gates: partner actors only, partners.report.read, active partner', () => {
  const call = (s: S, op: string) => (op === R4 ? post(s, RPT.b) : op === R5 ? get(s, RPT.b, SL.req) : file(s, RPT.b, SL.issued));

  for (const op of [R4, R5, R6]) {
    it(`${op}: a non-partner actor (staff user, system, patient) -> 403 auth.forbidden before any SQL, storage or port`, async () => {
      for (const actorType of ['user', 'system', 'patient']) {
        const s = setup({ ctx: { actorType } });
        await fails(call(s, op), 'auth.forbidden', 403);
        expect(s.w.log, actorType).toHaveLength(0);
        expect(s.st.calls).toHaveLength(0);
      }
    });

    it(`${op}: IdentityPort.assertRole(partners.report.read) is asked; its refusal propagates and nothing is read or written`, async () => {
      const ok = setup(); noFetch(); await call(ok, op);
      expect(ok.roles).toEqual(['partners.report.read']);
      const s = setup({ ctx: { assertRoleError: new LimsError('auth.forbidden') } });
      await fails(call(s, op), 'auth.forbidden', 403);
      expect(slipWrites(s.w)).toHaveLength(0);
      expect(s.st.calls).toHaveLength(0);
    });

    it(`${op}: a user of a suspended partner -> 403 partners.partner_inactive`, async () => {
      const s = setup({ who: 'adminZ' });
      await fails(s.run(op, { params: { report_id: RPT.b, access_slip_id: SL.req }, body: {} }), 'partners.partner_inactive', 403);
      expect(s.st.calls).toHaveLength(0);
    });
  }
});

// ================================================================== fixture self-check (the DDL guard itself is C0-0B / db tests, not provable in this in-memory world)
describe('fixture self-check: guard emulation (05-SCHEMA §3.7a transitions + RLS WITH CHECK)', () => {
  const insert = (state: string, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { tenant_id: T_A, id: id7(990), partner_id: P.x, partner_user_id: U.adminX, report_id: RPT.b, version_no: 1, order_id: ORD.lab, state, created_by: U.adminX, updated_by: U.adminX, ...extra };
    const cols = Object.keys(row);
    return [`INSERT INTO partners.access_slips (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row)] as const;
  };
  const worldWith = () => { const w = makeWorld14(); seed14(w); return w; };

  it('a partner actor can INSERT state requested, cannot INSERT another state, cannot UPDATE or DELETE', async () => {
    const w = worldWith(); const n = slips(w).length; const tx = slipTx(w, 'partner');
    await tx.query(...insert('requested')); expect(slips(w)).toHaveLength(n + 1);
    await expect(tx.query(...insert('failed', { id: id7(991), failure_code: 'reporting.report_superseded' }))).rejects.toMatchObject({ constraint: 'access_slips__rls_with_check' });
    await expect(tx.query("UPDATE partners.access_slips SET state = 'issued' WHERE tenant_id = $1 AND id = $2", [T_A, SL.req])).rejects.toMatchObject({ code: '42501' });
    await expect(tx.query('DELETE FROM partners.access_slips WHERE tenant_id = $1 AND id = $2', [T_A, SL.req])).rejects.toMatchObject({ code: '42501' });
    expect(slips(w)).toHaveLength(n + 1);
  });

  it('system: requested -> issued | failed and issued -> expired only; nothing leaves failed / expired; nobody deletes', async () => {
    const w = worldWith(); const tx = slipTx(w, 'system');
    await expect(tx.query("UPDATE partners.access_slips SET state = 'expired' WHERE tenant_id = $1 AND id = $2", [T_A, SL.req])).rejects.toMatchObject({ code: '23514' }); // requested -> expired
    await expect(tx.query("UPDATE partners.access_slips SET state = 'requested' WHERE tenant_id = $1 AND id = $2", [T_A, SL.issued])).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query("UPDATE partners.access_slips SET state = 'issued' WHERE tenant_id = $1 AND id = $2", [T_A, SL.failed])).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query("UPDATE partners.access_slips SET state = 'failed', failure_code = $3 WHERE tenant_id = $1 AND id = $2", [T_A, SL.expired, 'x.y'])).rejects.toMatchObject({ code: '23514' });
    await tx.query("UPDATE partners.access_slips SET state = 'failed', failure_code = $3 WHERE tenant_id = $1 AND id = $2", [T_A, SL.req, 'reporting.report_not_released']);
    expect(slipById(w, SL.req)).toMatchObject({ state: 'failed', failure_code: 'reporting.report_not_released' });
    await expect(tx.query('DELETE FROM partners.access_slips WHERE tenant_id = $1 AND id = $2', [T_A, SL.req])).rejects.toMatchObject({ code: '42501' });
  });

  it('"NOT NULL iff state" columns and the file_path pattern are enforced', async () => {
    const w = worldWith(); const tx = slipTx(w, 'system');
    await expect(tx.query("UPDATE partners.access_slips SET state = 'issued', link_id = $3 WHERE tenant_id = $1 AND id = $2", [T_A, SL.req, LINK.issued])).rejects.toMatchObject({ code: '23514' }); // issued without file columns
    const bytes = slipPdf(SL.req);
    await expect(tx.query("UPDATE partners.access_slips SET state = 'issued', link_id = $3, link_expires_at = $4, file_path = $5, file_sha256 = $6, file_byte_size = $7, issued_at = $4 WHERE tenant_id = $1 AND id = $2",
      [T_A, SL.req, LINK.issued, new Date(NOW13), 'wrong/path.pdf', 'a'.repeat(64), bytes.length])).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the world honest: seed14 holds every state, the slip PDF is stored for every issued row', () => {
    const w = makeWorld14(); const st: Storage = makeStorage(); seed14(w, st);
    expect(new Set(slips(w).map((r) => r['state']))).toEqual(new Set(['requested', 'issued', 'failed', 'expired']));
    for (const r of slips(w).filter((x) => x['state'] === 'issued')) expect(st.has(String(r['file_path']))).toBe(true);
  });
});
