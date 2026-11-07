// C6-T20 portal API P1-P6 through manifest.handlers (02-TRD §6.6; 01-PRD AC-11.1..11.12 API side; 07-SECURITY T3/T4/T5, A3/A4/A5/A26, 7, 8, 8a, 8f, 14).
// ASSUMED handler contract: handler(req, ctx) with ctx = { tenantId, actor {type 'portal', id = link id}, claims (DbClaims incl. portal_stage / portal_report_id /
// portal_session_id), tx, now(), log, ports, rateLimit.consume(tier,key), audit.access(entry), storage.read(bucket,path), commitOnError() } and req = { params, query, headers, body }.
// Handlers read the link purpose / state from the DB (core allowlists no purpose claim). Success results are { status, body?, headers? } with snake_case bodies per the OpenAPI.
// Wrong-code attempts are written then the handler calls ctx.commitOnError() (08 A19 P-42): the counter must survive the 4xx (run() rolls back otherwise).
// P4 streams bucket `reports` (path = report_versions.pdf_object_path) and writes audit.access({ action: 'report.portal_download', ... link id + version id }).
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });   // first import of the module manifest parses the OpenAPI spec
import { PDF_BYTES, PDF_BYTES_V2, LAB_NAME, PATIENT_MASKED, REPORT_A, REPORT_A2, REPORT_B, TENANT_A, TENANT_B, VER_A1, VER_A2, VER_A2R, VER_B1, errShape, idN, makePortalWorld, rejection, sha256buf, sha256hex, type PortalWorld, type Row } from './portal.helpers.js';

const MIN = 60_000; const HOUR = 3600_000;
const iso = (w: PortalWorld, ms: number) => new Date(Date.parse(w.now()) + ms).toISOString();
function seedChallenge(w: PortalWorld, link: Row, over: Row = {}) {
  const id = w.db.newId(); const code = '482913';
  w.db.insert('otp_challenges', { id, tenant_id: link['tenant_id'], link_id: link['id'], channel: 'sms', destination_sha256: sha256buf('dest'), code_hmac: w.hmacOf(id, code), status: 'pending', expires_at: iso(w, 10 * MIN), created_by: link['id'], ...over });
  return { id, code, row: w.db.store['otp_challenges']!.find((c) => c['id'] === id)! };
}
const codeOf = async (p: Promise<unknown>) => (await rejection(p)).code;

describe('P1 createPortalOtpChallenge (AC-11.1, AC-11.4, T3/T4, 08 A13 D-31)', () => {
  it('link stage -> 202 {challenge_id, channel} only (no destination mask); row pending_send with NULL destination and NULL code', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const out = await w.call.p1(l.cred);
    expect(out.status).toBe(202); expect(Object.keys(out.body).sort()).toEqual(['challenge_id', 'channel']); expect(out.body.channel).toBe('sms');
    const c = w.challenges(l.row['id']); expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: out.body.challenge_id, status: 'pending_send', destination_sha256: null, code_hmac: null, attempts: 0, tenant_id: TENANT_A, channel: 'sms' });
    expect(Date.parse(c[0]!['expires_at']) - Date.parse(w.now())).toBeLessThanOrEqual(10 * MIN);
    expect(Date.parse(c[0]!['expires_at'])).toBeGreaterThan(Date.parse(w.now()));
  });
  it('enqueues reporting.send_portal_otp {challenge_id} in the same transaction (code never in the payload)', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const out = await w.call.p1(l.cred);
    const jobs = w.db.jobsOf('reporting.send_portal_otp'); expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ challenge_id: out.body.challenge_id, tenant_id: TENANT_A }); expect(JSON.stringify(jobs[0]!.payload)).not.toMatch(/\b\d{6}\b/);
  });
  it("channel = coalesce(link.otp_channel, 'sms')", async () => {
    const w = makePortalWorld(); const l = w.mkLink({ otp_channel: 'email', channel: 'email' });
    expect((await w.call.p1(l.cred)).body.channel).toBe('email');
  });
  it('an earlier pending_send / pending challenge of the link becomes superseded', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const a = await w.call.p1(l.cred); const b = await w.call.p1(l.cred);
    const st = (id: string) => w.challenges().find((c) => c['id'] === id)!['status'];
    expect(st(a.body.challenge_id)).toBe('superseded'); expect(st(b.body.challenge_id)).toBe('pending_send');
  });
  it('expired_link -> reporting.link_invalid; session credential cannot request a code', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ expires_at: iso(w, 1000) }); w.advance(2000);
    expect(await codeOf(w.call.p1(l.cred))).toBe('reporting.link_invalid');
    const l2 = w.mkLink(); const s = w.mkSession(l2.row);
    expect(await codeOf(w.call.p1(s.cred))).toMatch(/^(reporting\.link_invalid|reporting\.otp_required|auth\.forbidden|common\.not_found)$/);
    expect(w.challenges(l2.row['id'])).toHaveLength(0);
  });
  it('AC-11.4 / A3: 4th request on one link within an hour -> common.rate_limited, nothing written or enqueued; allowed again after the hour', async () => {
    const w = makePortalWorld(); const l = w.mkLink();
    for (let i = 0; i < 3; i++) expect((await w.call.p1(l.cred)).status).toBe(202);
    const jobs = w.db.jobs.length; const rows = w.challenges().length;
    expect(await codeOf(w.call.p1(l.cred))).toBe('common.rate_limited');
    expect(w.db.jobs.length).toBe(jobs); expect(w.challenges().length).toBe(rows);
    w.advance(HOUR + 1000); expect((await w.call.p1(l.cred)).status).toBe(202);
  });
  it('the 3/hour budget is per link: a second link of the same report is unaffected', async () => {
    const w = makePortalWorld(); const a = w.mkLink(); const b = w.mkLink();
    for (let i = 0; i < 3; i++) await w.call.p1(a.cred);
    expect((await w.call.p1(b.cred)).status).toBe(202);
  });
  it('P1 never calls BillingPort / PaymentProviderPort / SmartReportPort / NotificationPort (the worker sends)', async () => {
    const w = makePortalWorld(); await w.call.p1(w.mkLink().cred);
    expect(w.forbiddenCalls).toEqual([]); expect(w.sent).toEqual([]);
  });
  it('is not idempotency-keyed (P-8 E2): two identical calls make two challenges', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const a = await w.call.p1(l.cred); const b = await w.call.p1(l.cred);
    expect(a.body.challenge_id).not.toBe(b.body.challenge_id);
  });
});

describe('P2 verifyPortalOtp (AC-11.2, AC-11.3, AC-11.8, T4/T5, A4)', () => {
  it('right code -> 200 session (idle 15 min, absolute 60 min, purpose report); only the SHA-256 of the session token is stored', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    const out = await w.call.p2(l.cred, ch.id, ch.code); const b = out.body;
    expect(out.status).toBe(200); expect(Object.keys(b).sort()).toEqual(['absolute_expires_at', 'idle_expires_at', 'link_purpose', 'session_token']);
    expect(b.link_purpose).toBe('report'); expect(b.session_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Date.parse(b.idle_expires_at)).toBe(Date.parse(w.now()) + 15 * MIN); expect(Date.parse(b.absolute_expires_at)).toBe(Date.parse(w.now()) + 60 * MIN);
    const s = w.sessions(l.row['id']); expect(s).toHaveLength(1);
    expect(Buffer.from(s[0]!['token_sha256']).toString('hex')).toBe(sha256hex(b.session_token)); expect(s[0]).toMatchObject({ tenant_id: TENANT_A, report_id: REPORT_A, link_purpose: 'report' });
    expect(w.allText()).not.toContain(b.session_token);
    expect(w.challenges(l.row['id'])[0]).toMatchObject({ status: 'verified' });
    expect(w.audit.some((e) => e['action'] === 'portal.session_start')).toBe(true);
    await expect(w.authenticate('session.' + b.session_token)).resolves.toMatchObject({ portal_stage: 'session', portal_report_id: REPORT_A });
  });
  it('a dues-purpose link starts a dues session (link_purpose copied)', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ purpose: 'dues' }); const ch = seedChallenge(w, l.row);
    const out = await w.call.p2(l.cred, ch.id, ch.code); expect(out.body.link_purpose).toBe('dues'); expect(w.sessions(l.row['id'])[0]!['link_purpose']).toBe('dues');
  });
  it('wrong codes -> auth.otp_invalid, the attempts counter SURVIVES the 4xx (commitOnError), no session', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    for (let i = 1; i <= 4; i++) { expect(await codeOf(w.call.p2(l.cred, ch.id, '000000'))).toBe('auth.otp_invalid'); expect(ch.row['attempts']).toBe(i); }
    expect(w.sessions()).toHaveLength(0); expect(ch.row['status']).toBe('pending');
  });
  it('AC-11.3 / A4: 5 wrong codes exhaust the challenge; the 6th attempt WITH the right code fails and creates no session', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    for (let i = 0; i < 4; i++) await rejection(w.call.p2(l.cred, ch.id, '000000'));
    expect(await codeOf(w.call.p2(l.cred, ch.id, '000000'))).toMatch(/^(auth\.otp_attempts_exhausted|auth\.otp_invalid)$/);
    expect(ch.row).toMatchObject({ status: 'exhausted', attempts: 5 });
    expect(await codeOf(w.call.p2(l.cred, ch.id, ch.code))).toMatch(/^(auth\.otp_attempts_exhausted|auth\.otp_invalid|common\.rate_limited)$/);
    expect(w.sessions()).toHaveLength(0); expect(ch.row['attempts']).toBeLessThanOrEqual(5);
    expect(w.audit.filter((e) => e['action'] === 'auth.otp_failure').length).toBeGreaterThanOrEqual(1);
  });
  it('brute-force harness: 300 distinct guesses against one challenge evaluate at most 5, never succeed, never create a session', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row); let ok = 0;
    for (let n = 0; n < 300; n++) { const g = String(n).padStart(6, '0'); if (g === ch.code) continue; try { await w.call.p2(l.cred, ch.id, g); ok++; } catch { /* expected */ } }
    expect(ok).toBe(0); expect(ch.row['attempts']).toBeLessThanOrEqual(5); expect(w.sessions()).toHaveLength(0);
    expect(await codeOf(w.call.p2(l.cred, ch.id, ch.code))).toMatch(/^auth\.|^common\.rate_limited$/);
  });
  it('12 parallel wrong guesses: attempts never exceed 5 and none succeeds', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    const r = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => w.call.p2(l.cred, ch.id, String(100000 + i))));
    expect(r.every((x) => x.status === 'rejected')).toBe(true); expect(ch.row['attempts']).toBeLessThanOrEqual(5); expect(w.sessions()).toHaveLength(0);
  });
  it('2 parallel verifications with the right code: exactly one session (single use)', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    const r = await Promise.allSettled([w.call.p2(l.cred, ch.id, ch.code), w.call.p2(l.cred, ch.id, ch.code)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect(w.sessions()).toHaveLength(1);
  });
  it('replay of a verified challenge -> auth.otp_invalid, no second session', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    await w.call.p2(l.cred, ch.id, ch.code); expect(await codeOf(w.call.p2(l.cred, ch.id, ch.code))).toBe('auth.otp_invalid'); expect(w.sessions()).toHaveLength(1);
  });
  it('expired challenge (10 min) with the right code -> auth.otp_invalid', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row); w.advance(10 * MIN + 1000);
    expect(await codeOf(w.call.p2(l.cred, ch.id, ch.code))).toBe('auth.otp_invalid'); expect(w.sessions()).toHaveLength(0);
  });
  it('no oracle: pending_send / failed / superseded / unknown / other-link / other-tenant challenges answer the same as a wrong code', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const other = w.mkLink(); const wrong = seedChallenge(w, l.row);
    const baseline = errShape(await rejection(w.call.p2(l.cred, wrong.id, '000000')));
    const cases: Array<[string, string]> = [];
    for (const st of ['pending_send', 'failed', 'superseded', 'expired']) {
      const extra: Row = st === 'pending_send' ? { destination_sha256: null, code_hmac: null } : st === 'failed' ? { destination_sha256: null, code_hmac: null, failure_code: 'no_contact' } : st === 'superseded' ? { destination_sha256: null } : {};
      cases.push([st, seedChallenge(w, l.row, { status: st, ...extra }).id]);
    }
    cases.push(['unknown', idN(0xdead)]); cases.push(['other link', seedChallenge(w, other.row).id]);
    for (const [name, id] of cases) { const e = await rejection(w.call.p2(l.cred, id, '482913')); expect(errShape(e), name).toBe(baseline); }
    expect(w.sessions()).toHaveLength(0);
  });
  it('malformed codes never succeed and never 5xx', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 482913', '482913 ', '48291\n', '４８２９１３']) {
      const e = await rejection(w.call.p2(l.cred, ch.id, bad)); expect(e.code, JSON.stringify(bad)).toMatch(/^(auth\.otp_invalid|common\.validation_failed|auth\.otp_attempts_exhausted)$/);
    }
    expect(w.sessions()).toHaveLength(0);
  });
  it('only the HMAC is compared: a tampered 31-byte stored value never verifies', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row);
    ch.row['code_hmac'] = ch.row['code_hmac'].subarray(0, 31); expect(await codeOf(w.call.p2(l.cred, ch.id, ch.code))).toMatch(/^auth\./); expect(w.sessions()).toHaveLength(0);
  });
  it('link-stage required: a session credential or expired link cannot verify', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); const ch = seedChallenge(w, l.row);
    expect(await codeOf(w.call.p2(s.cred, ch.id, ch.code))).toMatch(/^(reporting\.link_invalid|auth\.forbidden|common\.not_found|auth\.otp_invalid)$/);
    const old = w.mkLink({ expires_at: iso(w, 1000) }); w.advance(2000);
    expect(await codeOf(w.call.p2(old.cred, seedChallenge(w, old.row).id, '482913'))).toBe('reporting.link_invalid');
  });
});

describe('P3 getPortalReport (AC-11.2, AC-11.7, AC-11.12, A5, A26, 8a)', () => {
  it('summary: lab name, status, issue date, masked patient name, panels, download version id - and nothing else sensitive', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); const out = await w.call.p3(s.cred); const b = out.body;
    expect(out.status).toBe(200);
    expect(b).toMatchObject({ lab_name: LAB_NAME, patient_display: PATIENT_MASKED, download: { report_version_id: VER_A1 }, report: { family: 'laboratory', report_kind: 'final', version_no: 1, panel_names: ['Complete Blood Count'] } });
    expect(typeof b.report.status_label).toBe('string'); expect(Date.parse(b.report.issued_at)).not.toBeNaN(); expect(b.report.updated_notice).toBeUndefined();
    expect(JSON.stringify(b)).not.toMatch(/Test Patient 0001|\+977|0001SY000001|object_path|pdf_|token|sha256/i);
    expect(w.forbiddenCalls).toEqual([]);
  });
  it('AC-11.7: after an amendment the portal shows the latest released version with updated_notice; the superseded version is not offered', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); w.amend(); const b = (await w.call.p3(s.cred)).body;
    expect(b.download.report_version_id).toBe(VER_A2); expect(b.report).toMatchObject({ version_no: 2, report_kind: 'amended', panel_names: ['Complete Blood Count', 'Liver Function Test'] });
    expect(b.report.updated_notice).toMatchObject({ previous_version_no: 1 }); expect(Date.parse(b.report.updated_notice.updated_at)).not.toBeNaN();
    expect(await codeOf(w.call.p4(s.cred, VER_A1))).toBe('common.not_found');
    expect((await w.call.p4(s.cred, VER_A2)).status).toBe(200);
  });
  it('smart_summary comes only from report_versions.smart_summary_json; absent when NULL; zero SmartReportPort calls', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    expect('smart_summary' in (await w.call.p3(s.cred)).body && (await w.call.p3(s.cred)).body.smart_summary != null).toBe(false);
    w.amend({ sections: [{ heading: 'Summary', text: 'synthetic <b>x</b>' }] }); const b = (await w.call.p3(s.cred)).body;
    expect(b.smart_summary).toEqual({ sections: [{ heading: 'Summary', text: 'synthetic <b>x</b>' }] }); expect(w.forbiddenCalls).toEqual([]);
  });
  it('dues block only when the patient link has balance > 0; gateways default []; BillingPort never called', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    expect((await w.call.p3(s.cred)).body.dues).toBeUndefined();
    w.db.store['reports']!.find((r) => r['id'] === REPORT_A)!['billing_balance_due_paisa'] = 150000;
    expect((await w.call.p3(s.cred)).body.dues).toMatchObject({ balance_due_paisa: 150000, online_gateways: [] }); expect(w.forbiddenCalls).toEqual([]);
    const ref = w.mkLink({ recipient_kind: 'referrer', channel: 'email' }); expect((await w.call.p3(w.mkSession(ref.row).cred)).body.dues).toBeUndefined();
  });
  it('A26: a dues-purpose session gets common.not_found on P3 and P4', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ purpose: 'dues' }); const s = w.mkSession(l.row);
    expect(await codeOf(w.call.p3(s.cred))).toBe('common.not_found'); expect(await codeOf(w.call.p4(s.cred, VER_A1))).toBe('common.not_found');
    expect(w.storageReads).toEqual([]);
  });
  it('AC-11.12: link-stage credential on P3, P4, P6 -> 401 reporting.otp_required (not link_invalid)', async () => {
    const w = makePortalWorld(); const l = w.mkLink();
    for (const e of await Promise.all([w.call.p3(l.cred), w.call.p4(l.cred, VER_A1), w.call.p6(l.cred)].map((p) => rejection(p)))) { expect(e.code).toBe('reporting.otp_required'); expect(e.statusCode ?? 401).toBe(401); }
    expect(w.storageReads).toEqual([]);
  });
  it('expired_link credential on session operations is refused too (never serves a report)', async () => {
    const w = makePortalWorld(); const l = w.mkLink({ expires_at: iso(w, 1000) }); w.advance(2000);
    for (const e of await Promise.all([w.call.p3(l.cred), w.call.p4(l.cred, VER_A1), w.call.p6(l.cred)].map((p) => rejection(p)))) expect(e.code).toMatch(/^(reporting\.otp_required|reporting\.link_invalid)$/);
  });
  it('A5: session of report X cannot reach a version of report Y (same tenant) or of another tenant', async () => {
    const w = makePortalWorld(); const s = w.mkSession(w.mkLink().row);
    for (const v of [VER_A2R, VER_B1, idN(0xbeef)]) expect(await codeOf(w.call.p4(s.cred, v))).toBe('common.not_found');
    expect(w.storageReads).toEqual([]);
  });
  it('a session on tenant B data never reads tenant A (every reporting statement carries the claim tenant)', async () => {
    const w = makePortalWorld(); const lb = w.mkLink({ tenant_id: TENANT_B, report_id: REPORT_B }); const s = w.mkSession(lb.row); w.db.stmts.length = 0;
    const b = (await w.call.p3(s.cred)).body; expect(b.download.report_version_id).toBe(VER_B1);
    for (const st of w.db.stmts.filter((x) => /\breporting\.(reports|report_versions|qr_tokens|portal_links)\b/i.test(x.text) && x.verb === 'select')) expect(st.values, st.text).toContain(TENANT_B);
  });
  it('AC-11.8: each request slides idle to now+15 min (capped at the 60 min absolute); no session after 15 idle minutes or 60 total', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    w.advance(10 * MIN); await w.call.p3(s.cred); expect(Date.parse(s.row['idle_expires_at'])).toBe(Date.parse(w.now()) + 15 * MIN);
    w.advance(14 * MIN); await w.call.p3(s.cred);
    w.advance(14 * MIN); await w.call.p3(s.cred);                                                     // 38 min in, still active
    w.advance(14 * MIN); await w.call.p3(s.cred); expect(Date.parse(s.row['idle_expires_at'])).toBeLessThanOrEqual(Date.parse(s.row['absolute_expires_at']));
    w.advance(10 * MIN);                                                                              // 66 min since start: absolute passed
    expect((await rejection(w.call.p3(s.cred))).code).toMatch(/^(reporting\.link_invalid|reporting\.otp_required)$/);
    const s2 = w.mkSession(w.mkLink().row); w.advance(15 * MIN + 1000);
    expect((await rejection(w.call.p3(s2.cred))).code).toMatch(/^(reporting\.link_invalid|reporting\.otp_required)$/);
  });
  it('the credential travels in a header only: query-string tokens are ignored', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row);
    const ctx = await w.portalCtx(s.cred); const out = await w.run('getPortalReport', ctx, { query: { token: 'link.' + l.token, credential: 'x' } });
    expect(out.status).toBe(200); expect(w.allText()).not.toContain(l.token);
  });
});

describe('P4 downloadPortalReportPdf (AC-11.6, AC-11.10, AC-11.9 API side)', () => {
  it('serves the stored bytes as an attachment with nosniff + no-store + application/pdf; access_log report.portal_download with link id and version id', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); const out = await w.call.p4(s.cred, VER_A1);
    expect(out.status).toBe(200); expect(Buffer.from(out.body as Uint8Array).equals(Buffer.from(PDF_BYTES))).toBe(true);
    const h = Object.fromEntries(Object.entries(out.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['content-type']).toBe('application/pdf'); expect(h['content-disposition']).toMatch(/^attachment;/); expect(h['x-content-type-options']).toBe('nosniff'); expect(h['cache-control']).toMatch(/no-store/);
    expect(w.storageReads).toEqual([{ bucket: 'reports', path: `${TENANT_A}/reports/${REPORT_A}/v1.pdf` }]);
    const e = w.audit.find((x) => x['action'] === 'report.portal_download'); expect(e).toBeTruthy(); expect(JSON.stringify(e)).toContain(l.row['id']); expect(JSON.stringify(e)).toContain(VER_A1);
    expect(JSON.stringify(e)).not.toContain(s.token);
  });
  it('serves v2 bytes after an amendment', async () => {
    const w = makePortalWorld(); const s = w.mkSession(w.mkLink().row); w.amend();
    expect(Buffer.from((await w.call.p4(s.cred, VER_A2)).body as Uint8Array).equals(Buffer.from(PDF_BYTES_V2))).toBe(true);
  });
  it('AC-11.6: 20 downloads in an hour pass, the 21st -> common.rate_limited (no bytes, no audit row); budget is per link and recovers', async () => {
    const w = makePortalWorld(); const s = w.mkSession(w.mkLink().row, { absolute_expires_at: iso(w, 24 * HOUR), idle_expires_at: iso(w, 24 * HOUR) });
    for (let i = 0; i < 20; i++) expect((await w.call.p4(s.cred, VER_A1)).status).toBe(200);
    const reads = w.storageReads.length; const rows = w.audit.length;
    expect(await codeOf(w.call.p4(s.cred, VER_A1))).toBe('common.rate_limited'); expect(w.storageReads.length).toBe(reads); expect(w.audit.length).toBe(rows);
    const other = w.mkSession(w.mkLink().row); expect((await w.call.p4(other.cred, VER_A1)).status).toBe(200);
    w.advance(HOUR + 1000); expect((await w.call.p4(w.mkSession(w.link(s.row['link_id']) as Row).cred, VER_A1)).status).toBe(200);
  });
  it('a revoked link ends access: the session of a link revoked mid-session is refused', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); l.row['revoked_at'] = w.now();
    expect((await rejection(w.call.p4(s.cred, VER_A1))).code).toBe('reporting.link_invalid'); expect(w.storageReads).toEqual([]);
  });
  it('malformed version ids are refused (not_found / validation), never reach storage', async () => {
    const w = makePortalWorld(); const s = w.mkSession(w.mkLink().row);
    for (const id of ['not-a-uuid', '../../etc/passwd', '']) expect((await rejection(w.call.p4(s.cred, id))).code).toMatch(/^(common\.not_found|common\.validation_failed)$/);
    expect(w.storageReads).toEqual([]);
  });
  it('another report version of the same tenant is never streamed even when its id is guessed', async () => {
    const w = makePortalWorld(); const s = w.mkSession(w.mkLink().row); await rejection(w.call.p4(s.cred, VER_A2R)); expect(w.audit.filter((e) => e['action'] === 'report.portal_download')).toEqual([]);
    expect(REPORT_A2).not.toBe(REPORT_A);
  });
});

describe('P5 requestPortalLinkReissue (AC-11.5, review fix #14)', () => {
  const expired = (w: PortalWorld, over: Row = {}) => { const l = w.mkLink({ expires_at: iso(w, 1000), ...over }); w.advance(2000); return l; };
  it('expired unrevoked link -> 202 {} and job reporting.reissue_portal_link {link_id, reissue_day (Asia/Kathmandu), n} with key reissue:<link>:<day>:<n>', async () => {
    const w = makePortalWorld(); const l = expired(w); const out = await w.call.p5(l.cred);
    expect(out).toMatchObject({ status: 202, body: {} }); const jobs = w.db.jobsOf('reporting.reissue_portal_link'); expect(jobs).toHaveLength(1);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date(w.now()));
    expect(jobs[0]!.payload).toMatchObject({ link_id: l.row['id'], reissue_day: day, n: 1, tenant_id: TENANT_A }); expect(jobs[0]!.jobKey).toBe(`reissue:${l.row['id']}:${day}:1`);
    expect(l.row['reissue_count_day']).toBe(1); expect(String(l.row['reissue_day']).slice(0, 10)).toBe(day);
  });
  it('at most link_reissue_max_per_day per day (settings, default 3): the 4th still answers 202 {} but enqueues nothing; a new Kathmandu day resets', async () => {
    const w = makePortalWorld(); const l = expired(w);
    for (let i = 0; i < 4; i++) expect(await w.call.p5(l.cred)).toMatchObject({ status: 202, body: {} });
    expect(w.db.jobsOf('reporting.reissue_portal_link')).toHaveLength(3); expect(l.row['reissue_count_day']).toBe(3);
    w.advance(24 * HOUR); await w.call.p5(l.cred); expect(w.db.jobsOf('reporting.reissue_portal_link')).toHaveLength(4);
  });
  it('honours a tenant setting below the default', async () => {
    const w = makePortalWorld(); w.db.store['settings']!.find((s) => s['tenant_id'] === TENANT_A)!['link_reissue_max_per_day'] = 1; const l = expired(w);
    await w.call.p5(l.cred); await w.call.p5(l.cred); expect(w.db.jobsOf('reporting.reissue_portal_link')).toHaveLength(1);
  });
  it('a still-valid link -> 202 {} and nothing is issued', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); expect(await w.call.p5(l.cred)).toMatchObject({ status: 202, body: {} });
    expect(w.db.jobsOf('reporting.reissue_portal_link')).toEqual([]); expect(l.row['reissue_count_day']).toBe(0);
  });
  it('response is byte-identical for expired / valid / over-limit; revoked and unknown links stop at the resolver with the one link_invalid error', async () => {
    const w = makePortalWorld(); const e = expired(w); const v = w.mkLink(); const bodies = new Set<string>();
    for (const c of [e.cred, v.cred, e.cred, e.cred, e.cred]) { const o = await w.call.p5(c); bodies.add(JSON.stringify([o.status, o.body, o.headers ?? null])); }
    expect(bodies.size).toBe(1);
    const rev = w.mkLink({ revoked_at: w.now() }); const shapes = new Set<string>();
    for (const c of [rev.cred, 'link.' + 'Z'.repeat(22), 'junk']) shapes.add(errShape(await rejection(w.call.p5(c))));
    expect(shapes.size).toBe(1); expect(w.db.jobsOf('reporting.reissue_portal_link')).toHaveLength(3); // LD-66: link_reissue_max_per_day default 3
  });
  it('never issues a token itself and never uses the rate limiter grammar (strict) for a reissue key', async () => {
    const w = makePortalWorld(); const l = expired(w); await w.call.p5(l.cred);
    expect(w.db.store['portal_links']!.filter((x) => x['reissued_from_link_id'] === l.row['id'])).toEqual([]); expect(w.sent).toEqual([]);
  });
});

describe('P6 endPortalSession', () => {
  it('session -> 204, ended_at set, the credential no longer resolves; the link and its OTP budget are untouched', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const s = w.mkSession(l.row); const out = await w.call.p6(s.cred);
    expect(out.status).toBe(204); expect(s.row['ended_at']).not.toBeNull();
    expect((await rejection(w.call.p3(s.cred))).code).toBe('reporting.link_invalid'); expect(l.row['revoked_at']).toBeNull();
  });
  it('ending twice: the second finds no session (link_invalid), nothing else ends', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const a = w.mkSession(l.row); const b = w.mkSession(l.row);
    await w.call.p6(a.cred); expect((await rejection(w.call.p6(a.cred))).code).toBe('reporting.link_invalid'); expect(b.row['ended_at']).toBeNull();
  });
});

describe('cross-cutting (07-SECURITY 4, 7, 9, 14)', () => {
  it('full flow leaves no token / session token / code / PDF path in logs, SQL text, audit rows or job payloads except as hashes', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row); const v = await w.call.p2(l.cred, ch.id, ch.code);
    const sc = 'session.' + v.body.session_token; await w.call.p3(sc); await w.call.p4(sc, VER_A1); await w.call.p6(sc);
    const text = w.logs.join('\n') + JSON.stringify(w.audit) + JSON.stringify(w.db.jobs.map((j) => j.payload)) + w.db.stmts.map((x) => x.text).join('\n');
    for (const secret of [l.token, v.body.session_token, ch.code, 'Test Patient 0001', '+9779800000010']) expect(text, secret).not.toContain(secret);
    expect(w.audit.filter((e) => /otp|token|code/i.test(JSON.stringify(Object.keys(e))))).toEqual([]);
  });
  it('portal paths never call BillingPort / PaymentProviderPort / SmartReportPort / LabPort / CatalogPort', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row); const v = await w.call.p2(l.cred, ch.id, ch.code);
    const sc = 'session.' + v.body.session_token; await w.call.p3(sc); await w.call.p4(sc, VER_A1); await w.call.p5(l.cred); await w.call.p6(sc);
    expect(w.forbiddenCalls).toEqual([]);
  });
  it('every reporting statement is parameterised (no input interpolated into SQL) and tenant-scoped on tenant tables', async () => {
    const w = makePortalWorld(); const l = w.mkLink(); const ch = seedChallenge(w, l.row); w.db.stmts.length = 0;
    const v = await w.call.p2(l.cred, ch.id, ch.code); await w.call.p3('session.' + v.body.session_token);
    for (const s of w.db.stmts) { expect(s.text).not.toMatch(new RegExp(`${ch.code}|${l.token}|${v.body.session_token}|${ch.id}`)); }
  });
});
