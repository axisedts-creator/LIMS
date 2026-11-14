// C13 T14 — worker tasks partners.issue_access_slip and partners.purge_access_slips (06-IMPLEMENTATION-PLAN row T14; 02-TRD §8.1, §8.2; 03-APP-FLOW §5.5; 08 A2.1, A5.1, A5.2, A5.3).
// Tests: integration (in-memory SQL world, port fakes that record, storage fake) + log-scan. ACs: US-09.3 (worker issues the link as system, renders once, stores the PDF), US-09.4 (business error -> failed + code), US-09.6 (purge at link expiry).
// done_when (worker part): worker calls issuePortalLink as system with exact args; worker calls RenderPort.renderPdf with templateKey 'partners.access_slip' and exactly the seven A5.1 data keys; slip PDF stored once in partners-slips at the
// registered path; URL/token absent from every column, job payload, log, SQL value and error; purge 02:50 at link_expires_at (cron row itself is pinned by manifest.test.ts). LD-140 (UI) does not apply.
// Tasks are exercised through manifest.tasks[id] of ../index.js. Fixture (SQL subset, guard emulation, port / storage fakes): services/api/src/modules/partners/__tests__/access-slip.world.ts (header).
// SEAMS (spec does not fix them; the writer follows them or disputes):
//  - payload of issue: { tenant_id, access_slip_id } (what R4 enqueues); of purge: { tenant_id }. payload.tenant_id must equal ctx.tenantId (REQ-SEC-024, as redact_expired_lines) else the task rejects before any SQL / port call.
//  - issue: `SELECT ... FROM partners.access_slips WHERE tenant_id = $n AND id = $n ... FOR UPDATE` (single table), state must be 'requested' (else resolve with no port call, no storage write). A slip that is not visible for the job's tenant:
//    no port call, no storage write, no change (resolve or reject, either is accepted). patientDisplayName = manifest_lines.patient_full_name, orderRef = registration_no of the line of the slip's order (single-table lookups, tenant + partner bound);
//    partnerName = partners.partners.name; tenantDisplayName = (await ctx.core.tenant(ctx)).displayName (precedent analytics.build_export); tenant timezone / calendar via ctx.ports.IdentityPort.getTenantSettings(ctx, {keys ⊆ timezone, calendarDisplay, reportLinkTtlDays}).
//    The two *Local strings are formatted in the tenant timezone (Asia/Kathmandu, +05:45): 06:00Z shows as 11:45, and they carry the year 2026 (calendarDisplay 'AD'). The port result is used as is (linkId, url, expiresAt).
//  - storage: ctx.storage.put('partners-slips', path, bytes, { contentType: 'application/pdf', ... }) ONCE per successful issue, path {tenant_id}/access-slips/{yyyy}/{mm}/{id}.pdf from ctx.now(); a retry before `issued` may replace (no ifAbsent
//    on an existing object); file_sha256 / file_byte_size = the RenderPort result's sha256 / byteSize; issued_at = ctx.now(). Business failure (port errors reporting.report_not_released / report_superseded, render errors
//    reporting.template_invalid / common.payload_too_large) -> row `failed` + failure_code = the error code, task RESOLVES (no retry); anything else (incl. reporting.render_unavailable, storage, DB) rejects (retry), row stays `requested`.
//  - purge: for 'issued' rows of the job's tenant with link_expires_at < now: ctx.storage.delete('partners-slips', file_path) (common.not_found = already gone = fine), then UPDATE -> state 'expired', file_path / file_sha256 / file_byte_size NULL, expired_at = now.
//    Every statement on access_slips binds the job's tenant. Idempotent by state.
//  - NOT tested (spec gap, see C13.T14-tests.md): retry AFTER a successful render whose DB update then fails (the fake RenderPort refuses the same idempotencyKey with different data, as packages/fakes does: a retry mints a NEW link),
//    metrics (T23), the cron registration (manifest.test.ts), the DDL guard itself (db tests).
import { describe, expect, it } from 'vitest';
import {
  BUCKET, EXPIRES, id, issuedSlip, LINK, leaksIn, makePorts, makeStorage, makeWorld14, NOW13, ORD, P, PHI, RPT, runSlipJob, SL, seed14, sha256, slipById, slipPath, slips, T_A, T_B, U, urlOf, worldLeaks,
  type Storage, type World,
} from '../../../../../api/src/modules/partners/__tests__/access-slip.world.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { manifest } from '../index.js';
import { instantToBs, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';

const issueTask = manifest.tasks!['partners.issue_access_slip']!;
const purgeTask = manifest.tasks!['partners.purge_access_slips']!;
const DAY = 86_400_000;
const PRIVATE = [PHI.phone, PHI.note, PHI.dob, 'SYN-REF-002', 'SYN-MF-0001', 'Synthetic Binita', 'SYN-0002', 'Synthetic Yogesh', 'SYN-Y001'];

function setup() { const w: World = makeWorld14(); const st: Storage = makeStorage(); seed14(w, st); const ports = makePorts(w); return { w, st, ports }; }
type S = ReturnType<typeof setup>;
const issue = (s: S, slip: string, over = {}, payload: unknown = { tenant_id: T_A, access_slip_id: slip }) => runSlipJob(s.w, issueTask, payload, s.st, s.ports, over);
const purge = (s: S, over = {}, payload: unknown = { tenant_id: T_A }) => runSlipJob(s.w, purgeTask, payload, s.st, s.ports, over);
const row = (s: S, slip: string, tenant = T_A) => slipById(s.w, slip, tenant)!;
const iso = (v: unknown) => new Date(v as string).toISOString();
const untouched = (s: S, ids: string[]) => ids.map((i) => JSON.stringify(row(s, i)));
const accessSlipSql = (w: World) => w.log.filter((q) => /\bpartners\.access_slips\b/i.test(q.text));

// ================================================================== issue
describe('partners.issue_access_slip: the happy path (US-09.3)', () => {
  it('calls ReportingPort.issuePortalLink ONCE, as the system actor of the job tenant, with exactly { reportId, versionNo, channel: print_qr, recipientKind: patient }', async () => {
    const s = setup(); const r = await issue(s, SL.req);
    expect(r.threw).toBeUndefined();
    expect(s.ports.issue).toHaveLength(1);
    expect(s.ports.issue[0]!.actorType).toBe('system');
    expect(s.ports.issue[0]!.tenantId).toBe(T_A);
    expect(s.ports.issue[0]!.input).toEqual({ reportId: RPT.b, versionNo: 1, channel: 'print_qr', recipientKind: 'patient' });
  });

  it('calls RenderPort.renderPdf ONCE as system: templateKey partners.access_slip, idempotencyKey = the slip id, data with EXACTLY the seven A5.1 keys (08 A5.1)', async () => {
    const s = setup(); await issue(s, SL.req);
    expect(s.ports.render).toHaveLength(1);
    const c = s.ports.render[0]!;
    expect(c.actorType).toBe('system'); expect(c.tenantId).toBe(T_A);
    expect(Object.keys(c.input).sort()).toEqual(['data', 'idempotencyKey', 'templateKey']);
    expect(c.input.templateKey).toBe('partners.access_slip');
    expect(c.input.idempotencyKey).toBe(SL.req);
    expect(Object.keys(c.input.data).sort()).toEqual(['expiresAtLocal', 'issuedAtLocal', 'orderRef', 'partnerName', 'patientDisplayName', 'portalUrl', 'tenantDisplayName']);
  });

  it('data values: lab name, partner name, patient display name, registration no, the port\'s url, both times in the tenant timezone (11:45, 2026); no phone / note / DOB / sample ref / manifest no', async () => {
    const s = setup(); await issue(s, SL.req);
    const d = s.ports.render[0]!.input.data;
    expect(d).toMatchObject({ tenantDisplayName: 'Synthetic Lab Kathmandu', partnerName: 'Synthetic Partner X', patientDisplayName: 'Synthetic Binita Test', orderRef: 'SYN-0002', portalUrl: urlOf(1) });
    for (const k of ['expiresAtLocal', 'issuedAtLocal']) { expect(typeof d[k], k).toBe('string'); expect(d[k], k).toContain('11:45'); expect(d[k], k).toContain('2026'); }
    expect(d.expiresAtLocal).not.toBe(d.issuedAtLocal);
    const flat = JSON.stringify(d);
    for (const x of [PHI.phone, PHI.note, PHI.dob, 'SYN-REF-002', 'SYN-MF-0001']) expect(flat).not.toContain(x);
  });

  // T14 review item 1 (02-TRD §8.1 [CONV]: *Local formatted per calendarDisplay; IC §4 AD|BS|AD_BS|BS_AD). Exact BS text format is not pinned: BS year + tenant-local time only.
  it.each([['BS', true, false], ['AD_BS', true, true], ['BS_AD', true, true], ['AD', false, true]] as const)('calendarDisplay %s: both *Local strings carry the 11:45 local time, BS year %s, AD year %s', async (cal, hasBs, hasAd) => {
    const s = setup(); const r = await issue(s, SL.req, { calendar: cal });
    const d = s.ports.render[0]!.input.data;
    for (const [k, at] of [['expiresAtLocal', EXPIRES], ['issuedAtLocal', NOW13]] as const) {
      const bsYear = String(instantToBs(at as IsoUtc, 'Asia/Kathmandu').year);
      expect(d[k], k).toContain('11:45'); expect(bsYear).toBe('2083');
      expect(d[k].includes(bsYear), `${k} BS year`).toBe(hasBs);
      expect(d[k].includes('2026'), `${k} AD year`).toBe(hasAd);
    }
    expect(r.settingsCalls.some((c: any) => c.keys.includes('calendarDisplay'))).toBe(true);
  });

  it('stores the slip PDF ONCE in partners-slips at {tenant_id}/access-slips/{yyyy}/{mm}/{id}.pdf (08 A5.2), the decoded render result, application/pdf', async () => {
    const s = setup(); await issue(s, SL.req);
    const puts = s.st.calls.filter((c) => c.op === 'put');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ bucket: BUCKET, path: `${T_A}/access-slips/2026/11/${SL.req}.pdf` });
    expect(puts[0]!.opts).toMatchObject({ contentType: 'application/pdf' });
    const bytes = s.st.get(slipPath(SL.req))!;
    expect(Buffer.from(bytes).toString('latin1')).toContain(urlOf(1)); // the link lives inside the PDF, by design
    expect(s.st.calls.filter((c) => c.op !== 'put')).toHaveLength(0);
  });

  it('the row becomes issued: link_id, link_expires_at (port), file_path, file_sha256 + file_byte_size (render result), issued_at = now; other rows untouched', async () => {
    const s = setup(); const others = untouched(s, [SL.y, SL.issued, SL.failed, SL.expired]);
    await issue(s, SL.req);
    const bytes = s.st.get(slipPath(SL.req))!; const r = row(s, SL.req);
    expect(r).toMatchObject({ state: 'issued', link_id: id(981), file_path: slipPath(SL.req), file_sha256: sha256(bytes), file_byte_size: bytes.length, failure_code: null });
    expect(iso(r['link_expires_at'])).toBe(EXPIRES);
    expect(iso(r['issued_at'])).toBe(NOW13);
    expect(untouched(s, [SL.y, SL.issued, SL.failed, SL.expired])).toEqual(others);
  });

  it('the task selects the slip FOR UPDATE with tenant + id bound', async () => {
    const s = setup(); await issue(s, SL.req);
    const sel = s.w.log.filter((q) => /^\s*SELECT\b[\s\S]*\bpartners\.access_slips\b[\s\S]*\bFOR UPDATE\b/i.test(q.text));
    expect(sel.length).toBeGreaterThanOrEqual(1);
    expect(sel[0]!.values).toEqual(expect.arrayContaining([T_A, SL.req]));
  });

  it('ST12: the URL / token is in NO column, job payload, SQL text or value, log line, metric, error (it exists only in the render input and the PDF)', async () => {
    const s = setup(); const r = await issue(s, SL.req);
    expect(r.threw).toBeUndefined();
    expect(worldLeaks(s.w)).toEqual([]);
    expect(leaksIn(r.logs)).toEqual([]);
    expect(leaksIn(r.metrics)).toEqual([]);
    expect(s.w.jobs).toHaveLength(0);
    expect(leaksIn(s.ports.render[0]!.input)).toEqual(expect.arrayContaining(['SLIPTOKEN-9d41c7e05b3a'])); // sanity: the render input DOES carry it
    expect(leaksIn(s.ports.issue.map((c) => c.input))).toEqual([]); // and the port input does not
  });

  it('lab-linked identifiers and PHI are never logged (patient name, registration no, sample ref, manifest no, phone)', async () => {
    const s = setup(); const r = await issue(s, SL.req);
    expect(leaksIn(r.logs, PRIVATE)).toEqual([]);
  });

  it('a replay after success (state issued) is a no-op: no second link, render or object write; row unchanged', async () => {
    const s = setup(); await issue(s, SL.req);
    const after = JSON.stringify(row(s, SL.req));
    const r = await issue(s, SL.req);
    expect(r.threw).toBeUndefined();
    expect(s.ports.issue).toHaveLength(1); expect(s.ports.render).toHaveLength(1);
    expect(s.st.calls.filter((c) => c.op === 'put')).toHaveLength(1);
    expect(JSON.stringify(row(s, SL.req))).toBe(after);
  });

  it('a retry that runs BEFORE the row is issued may replace the object at the same path (no ifAbsent): a leftover object does not block the issue', async () => {
    const s = setup(); s.st.set(slipPath(SL.req), Buffer.from('%PDF-1.7 leftover of an earlier attempt'));
    const r = await issue(s, SL.req);
    expect(r.threw).toBeUndefined();
    expect(row(s, SL.req)['state']).toBe('issued');
    expect(Buffer.from(s.st.get(slipPath(SL.req))!).toString('latin1')).toContain(urlOf(1));
  });

  it('each slip uses its own partner, order and report (partner Y\'s slip: Y\'s name, patient, registration no, report)', async () => {
    const s = setup(); await issue(s, SL.y);
    expect(s.ports.issue[0]!.input).toEqual({ reportId: RPT.y, versionNo: 1, channel: 'print_qr', recipientKind: 'patient' });
    expect(s.ports.render[0]!.input.data).toMatchObject({ partnerName: 'Synthetic Partner Y', patientDisplayName: 'Synthetic Yogesh Test', orderRef: 'SYN-Y001' });
    expect(row(s, SL.y)['state']).toBe('issued');
    expect(row(s, SL.req)['state']).toBe('requested');
  });
});

describe('partners.issue_access_slip: not requested / not visible / bad payload', () => {
  it('a slip that is not in state requested (issued, failed, expired): no port call, no storage write, no change, no error', async () => {
    for (const slip of [SL.issued, SL.failed, SL.expired]) {
      const s = setup(); const before = JSON.stringify(row(s, slip));
      const r = await issue(s, slip);
      expect(r.threw, slip).toBeUndefined();
      expect(s.ports.issue, slip).toHaveLength(0); expect(s.ports.render, slip).toHaveLength(0);
      expect(s.st.calls.filter((c) => c.op === 'put'), slip).toHaveLength(0);
      expect(JSON.stringify(row(s, slip)), slip).toBe(before);
    }
  });

  it('payload tenant different from the job tenant, missing or malformed access_slip_id: the task rejects before any port call or write', async () => {
    for (const payload of [{ tenant_id: T_B, access_slip_id: SL.req }, { tenant_id: T_A }, { tenant_id: T_A, access_slip_id: 'nope' }, { access_slip_id: SL.req }, {}, null]) {
      const s = setup();
      const r = await issue(s, SL.req, {}, payload);
      expect(r.threw, JSON.stringify(payload)).toBeInstanceOf(Error);
      expect(s.ports.issue).toHaveLength(0); expect(s.ports.render).toHaveLength(0);
      expect(s.st.calls).toHaveLength(0);
      expect(row(s, SL.req)['state']).toBe('requested');
    }
  });

  it('a slip of another tenant is invisible to the job (tenant A job, tenant B slip id): no port call, no storage write, tenant B row unchanged', async () => {
    const s = setup(); const before = JSON.stringify(row(s, SL.b, T_B));
    await issue(s, SL.b);
    expect(s.ports.issue).toHaveLength(0); expect(s.ports.render).toHaveLength(0);
    expect(s.st.calls.filter((c) => c.op === 'put')).toHaveLength(0);
    expect(JSON.stringify(row(s, SL.b, T_B))).toBe(before);
  });
});

describe('partners.issue_access_slip: failures (US-09.4)', () => {
  it('business error from issuePortalLink (reporting.report_not_released / report_superseded) -> state failed + failure_code, task resolves (no retry), no render, no object', async () => {
    for (const code of ['reporting.report_not_released', 'reporting.report_superseded']) {
      const s = setup(); s.ports.ctl.issueErr = new LimsError(code as any);
      const r = await issue(s, SL.req);
      expect(r.threw, code).toBeUndefined();
      expect(row(s, SL.req), code).toMatchObject({ state: 'failed', failure_code: code, link_id: null, file_path: null, file_sha256: null });
      expect(s.ports.render, code).toHaveLength(0);
      expect(s.st.calls.filter((c) => c.op === 'put'), code).toHaveLength(0);
      await issue(s, SL.req); // replay of a failed slip: no-op
      expect(s.ports.issue, code).toHaveLength(1);
    }
  });

  it('RenderPort business errors reporting.template_invalid / common.payload_too_large -> state failed + that code, task resolves, no object written', async () => {
    for (const code of ['reporting.template_invalid', 'common.payload_too_large']) {
      const s = setup(); s.ports.ctl.renderErr = new LimsError(code as any);
      const r = await issue(s, SL.req);
      expect(r.threw, code).toBeUndefined();
      expect(row(s, SL.req), code).toMatchObject({ state: 'failed', failure_code: code, file_path: null, link_id: null });
      expect(s.st.calls.filter((c) => c.op === 'put'), code).toHaveLength(0);
      expect(worldLeaks(s.w), code).toEqual([]);
    }
  });

  it('reporting.render_unavailable is an infra failure: the task REJECTS (retry), the row stays requested, nothing stored; when the renderer is back the next delivery issues the slip', async () => {
    const s = setup(); s.ports.ctl.renderErr = () => new LimsError('reporting.render_unavailable');
    const r1 = await issue(s, SL.req);
    expect(r1.threw).toBeInstanceOf(Error);
    expect(row(s, SL.req)['state']).toBe('requested');
    expect(s.st.calls.filter((c) => c.op === 'put')).toHaveLength(0);
    expect(leaksIn(r1.threw)).toEqual([]);
    const r2 = await issue(s, SL.req, { attempt: 2 });
    expect(r2.threw).toBeUndefined();
    expect(row(s, SL.req)['state']).toBe('issued');
    expect(s.st.calls.filter((c) => c.op === 'put')).toHaveLength(1);
    expect(worldLeaks(s.w)).toEqual([]);
  });

  it('other port failures (issuePortalLink dependency error, unexpected Error) reject for retry; the row stays requested; no render', async () => {
    for (const err of [new LimsError('common.dependency_unavailable'), new Error('socket hang up')]) {
      const s = setup(); s.ports.ctl.issueErr = err;
      const r = await issue(s, SL.req);
      expect(r.threw).toBeInstanceOf(Error);
      expect(row(s, SL.req)['state']).toBe('requested');
      expect(s.ports.render).toHaveLength(0);
    }
  });

  it('a storage failure or a failing final UPDATE rejects for retry: row requested, no secret in the error, logs or SQL', async () => {
    const a = setup(); a.st.fail.put = new Error('storage backend down');
    const ra = await issue(a, SL.req);
    expect(ra.threw).toBeInstanceOf(Error); expect(row(a, SL.req)['state']).toBe('requested');
    expect(leaksIn(ra.threw)).toEqual([]); expect(leaksIn(ra.logs)).toEqual([]); expect(worldLeaks(a.w)).toEqual([]);

    const b = setup(); b.w.failNext(/UPDATE partners\.access_slips/);
    const rb = await issue(b, SL.req);
    expect(rb.threw).toBeInstanceOf(Error); expect(row(b, SL.req)['state']).toBe('requested');
    expect(leaksIn(rb.threw)).toEqual([]); expect(leaksIn(rb.logs)).toEqual([]); expect(worldLeaks(b.w)).toEqual([]);
  });

  it('failure paths do not log lab-linked identifiers or PHI either', async () => {
    const s = setup(); s.ports.ctl.issueErr = new LimsError('reporting.report_superseded');
    const r = await issue(s, SL.req);
    expect(leaksIn(r.logs, PRIVATE)).toEqual([]);
  });
});

// ================================================================== purge
const addOld = (s: S) => {
  const at = (iso: string) => new Date(iso);
  issuedSlip(s.w, s.st, { id: SL.old1, partner_id: P.x, link_id: LINK.old1, link_expires_at: at('2026-11-01T06:00:00Z') });
  issuedSlip(s.w, s.st, { id: SL.old2, partner_id: P.x, link_id: LINK.old2, link_expires_at: at('2026-11-10T06:00:00Z') });
  issuedSlip(s.w, s.st, { id: SL.fresh, partner_id: P.x, link_id: LINK.fresh, link_expires_at: at('2026-12-05T06:00:00Z') });
  issuedSlip(s.w, s.st, { id: SL.oldY, partner_id: P.y, partner_user_id: U.adminY, report_id: RPT.y, order_id: ORD.y, link_id: LINK.oldY, link_expires_at: at('2026-11-02T06:00:00Z') });
  issuedSlip(s.w, s.st, { id: SL.oldB, tenant_id: T_B, partner_id: P.b, partner_user_id: U.adminB, report_id: RPT.bb, order_id: ORD.b, link_id: LINK.oldB, link_expires_at: at('2026-11-01T06:00:00Z'), created_by: U.adminB, updated_by: U.adminB });
};
const dels = (s: S) => s.st.calls.filter((c) => c.op === 'delete').map((c) => c.path).sort();

describe('partners.purge_access_slips (02:50, per_tenant; deletes the PDF at link_expires_at — 08 A2.1, A5.3)', () => {
  it('issued slips with link_expires_at < now: object deleted (bucket partners-slips, the registered path), row expired with file columns NULL, expired_at = now; link_id and link_expires_at kept', async () => {
    const s = setup(); addOld(s);
    const r = await purge(s);
    expect(r.threw).toBeUndefined();
    for (const sid of [SL.old1, SL.old2, SL.oldY]) {
      expect(row(s, sid), sid).toMatchObject({ state: 'expired', file_path: null, file_sha256: null, file_byte_size: null });
      expect(row(s, sid)['link_id'], sid).not.toBeNull(); expect(row(s, sid)['link_expires_at'], sid).not.toBeNull();
      expect(Math.abs(new Date(row(s, sid)['expired_at']).getTime() - new Date(NOW13).getTime()), sid).toBeLessThanOrEqual(DAY);
      expect(s.st.has(slipPath(sid)), sid).toBe(false);
    }
    expect(dels(s)).toEqual([slipPath(SL.old1), slipPath(SL.old2), slipPath(SL.oldY)].sort());
    expect(s.st.calls.filter((c) => c.op === 'delete').every((c) => c.bucket === BUCKET)).toBe(true);
  });

  it('only what is due: unexpired issued slips keep row AND object; requested / failed / expired rows are not touched; tenant B\'s overdue slip and object are not touched', async () => {
    const s = setup(); addOld(s);
    const own = [SL.fresh, SL.issued, SL.issuedY, SL.req, SL.failed, SL.expired, SL.y];
    const keep = untouched(s, own); const keepB = [JSON.stringify(row(s, SL.oldB, T_B)), JSON.stringify(row(s, SL.issuedB, T_B))];
    await purge(s);
    expect(untouched(s, own)).toEqual(keep);
    expect([JSON.stringify(row(s, SL.oldB, T_B)), JSON.stringify(row(s, SL.issuedB, T_B))]).toEqual(keepB);
    expect(row(s, SL.oldB, T_B)).toMatchObject({ state: 'issued' });
    for (const sid of [SL.fresh, SL.issued, SL.issuedY]) expect(s.st.has(slipPath(sid)), sid).toBe(true);
    expect(s.st.has(slipPath(SL.oldB, T_B))).toBe(true);
  });

  it('idempotent by state: a second run deletes nothing and changes nothing', async () => {
    const s = setup(); addOld(s); await purge(s);
    const state = JSON.stringify(slips(s.w)); const n = s.st.calls.length;
    const r = await purge(s);
    expect(r.threw).toBeUndefined();
    expect(JSON.stringify(slips(s.w))).toBe(state);
    expect(s.st.calls).toHaveLength(n);
  });

  it('an object that is already gone (storage common.not_found) is fine: the row is still expired', async () => {
    const s = setup(); addOld(s); s.st.objects.delete(`${BUCKET}|${slipPath(SL.old1)}`);
    const r = await purge(s);
    expect(r.threw).toBeUndefined();
    expect(row(s, SL.old1)['state']).toBe('expired');
  });

  it('a storage delete failure rejects (retry) and expires nothing in that delivery; the retry finishes the job (objects already deleted count as gone)', async () => {
    const s = setup(); addOld(s);
    s.st.fail.delete = (p) => (p === slipPath(SL.old2) ? new Error('storage backend down') : undefined);
    const r1 = await purge(s);
    expect(r1.threw).toBeInstanceOf(Error);
    for (const sid of [SL.old1, SL.old2, SL.oldY]) expect(row(s, sid)['state'], sid).toBe('issued'); // one transaction: rolled back
    delete s.st.fail.delete;
    const r2 = await purge(s, { attempt: 2 });
    expect(r2.threw).toBeUndefined();
    for (const sid of [SL.old1, SL.old2, SL.oldY]) { expect(row(s, sid)['state'], sid).toBe('expired'); expect(s.st.has(slipPath(sid)), sid).toBe(false); }
  });

  it('tenant scoping: every statement on access_slips binds the job tenant (never tenant B); a payload tenant different from the job tenant rejects with no change', async () => {
    const s = setup(); addOld(s);
    await purge(s);
    const sql = accessSlipSql(s.w).filter((q) => !/^\s*(INSERT)/i.test(q.text));
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) { expect(q.values, q.text).toContain(T_A); expect(q.values, q.text).not.toContain(T_B); }
    const t = setup(); addOld(t);
    const before = JSON.stringify(slips(t.w));
    const r = await purge(t, {}, { tenant_id: T_B });
    expect(r.threw).toBeInstanceOf(Error);
    expect(JSON.stringify(slips(t.w))).toBe(before);
    expect(t.st.calls).toHaveLength(0);
  });

  it('makes no port call and never reads or writes an object (delete only); no secret in logs, SQL or tables', async () => {
    const s = setup(); addOld(s);
    const r = await purge(s);
    expect(s.ports.issue).toHaveLength(0); expect(s.ports.render).toHaveLength(0);
    expect(s.st.calls.every((c) => c.op === 'delete')).toBe(true);
    expect(leaksIn(r.logs)).toEqual([]);
    expect(worldLeaks(s.w)).toEqual([]);
  });
});
