// C6-T43 — P7 getPortalDues + the dues-session isolation (02-TRD §6.6 P3/P4/P7, §4.6 rule 8; 08 Addendum A21.1; 01-PRD AC-18.9; 07-SECURITY T23, abuse A27).
// World = C6-T42 makePayWorld (T20 portal world + balance hint + gateways). P7 is a portal handler: it reads reporting tables only (BillingPort / PaymentProviderPort are FORBIDDEN proxies).
// ASSUMED: manifest.handlers.getPortalDues (req {} , ctx from the portalSession resolver) -> { status: 200, body }, body keys exactly {lab_name, dues?, report_follows}.
// OPEN POINT for the writer (spec silent): under real RLS a dues session cannot read qr_tokens (policy needs portal_link_purpose = 'report'); the source of `lab_name` for a dues
// session is the writer's call (the fake DB does not enforce it): the test only pins lab_name = the report's frozen lab name snapshot.
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });   // first import of the module manifest parses the OpenAPI spec (cold start)
import { makePayWorld, DUE, rejection } from './portal.payment.helpers.js';
import { LAB_NAME, PATIENT_MASKED, REPORT_A, VER_A1, makePortalWorld } from './portal.helpers.js';

const p7 = (p: ReturnType<typeof makePayWorld>, cred: string) => p.w.run('getPortalDues', cred);

describe('P7 getPortalDues — AC-18.9: a dues session sees only the amount, the pay options and "report follows"', () => {
  it('dues session, balance 500, gateways [esewa, khalti] -> 200 {lab_name, dues {balance_due_paisa 50000, online_gateways}, report_follows true}; nothing else', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' }); const out = await p7(p, s.cred);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ lab_name: LAB_NAME, dues: { balance_due_paisa: DUE, online_gateways: ['esewa', 'khalti'] }, report_follows: true });
  });
  it('no gateways configured (C15 not live) -> online_gateways [] (the page shows the counter copy)', async () => {
    const p = makePayWorld({ gateways: [] }); const s = p.patient({ purpose: 'dues' });
    expect((await p7(p, s.cred)).body).toEqual({ lab_name: LAB_NAME, dues: { balance_due_paisa: DUE, online_gateways: [] }, report_follows: true });
  });
  it('an open request of THIS link is shown as dues.open_request {id, status}; another link\'s request is not', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' }); const r = p.seedRequest(s.linkId);
    expect((await p7(p, s.cred)).body.dues.open_request).toEqual({ id: r['id'], status: 'queued' });
    const other = p.patient({ purpose: 'dues' }); expect((await p7(p, other.cred)).body.dues.open_request).toBeUndefined();
  });
  it('balance 0 (payment received, report not released yet) -> no `dues` key, report_follows still true; unknown balance -> same', async () => {
    const p = makePayWorld({ balanceHint: 0 }); const s = p.patient({ purpose: 'dues' });
    const a = await p7(p, s.cred); expect(a.status).toBe(200); expect(a.body).toEqual({ lab_name: LAB_NAME, report_follows: true }); expect('dues' in a.body).toBe(false);
    p.hint(null); expect((await p7(p, s.cred)).body).toEqual({ lab_name: LAB_NAME, report_follows: true });
  });
  it('a report-purpose session may call P7 too: same dues block as P3, report_follows false', async () => {
    const p = makePayWorld(); const s = p.patient(); const out = await p7(p, s.cred);
    expect(out.status).toBe(200); expect(out.body).toEqual({ lab_name: LAB_NAME, dues: { balance_due_paisa: DUE, online_gateways: ['esewa', 'khalti'] }, report_follows: false });
  });
  it('a referrer / centre report link has no dues block (patient links only, as P3)', async () => {
    const p = makePayWorld(); const s = p.patient({ recipient_kind: 'referrer', channel: 'email' }); const out = await p7(p, s.cred);
    expect(out.status).toBe(200); expect(out.body.dues).toBeUndefined();
  });
  it('NO report content in any answer: no patient display, panel names, report/version ids, download, smart summary, pdf', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' }); const out = await p7(p, s.cred); expect(out.status).toBe(200); const text = JSON.stringify(out.body);
    for (const x of [PATIENT_MASKED, 'panel', 'download', 'smart_summary', 'report_version_id', VER_A1, REPORT_A, 'pdf', 'status_label', 'report_kind']) expect(text, x).not.toContain(x);
  });
  it('P7 never calls BillingPort / PaymentProviderPort (the amount is the balance-event hint on the report row)', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' }); await p7(p, s.cred); expect(p.w.forbiddenCalls).toEqual([]);
  });
  it('a link-stage credential -> 401 reporting.otp_required; an unknown credential -> reporting.link_invalid', async () => {
    const p = makePayWorld(); const l = p.w.mkLink({ purpose: 'dues' });
    expect((await rejection(p7(p, l.cred))).code).toBe('reporting.otp_required');
    expect((await rejection(p7(p, 'session.' + 'A'.repeat(43)))).code).toBe('reporting.link_invalid');
  });
  it('an ended session -> reporting.link_invalid (same as every invalid credential)', async () => {
    const p = makePayWorld(); const l = p.w.mkLink({ purpose: 'dues' }); const s = p.w.mkSession(l.row, { ended_at: p.w.now() });
    expect((await rejection(p7(p, s.cred))).code).toBe('reporting.link_invalid');
  });
});

describe('dues session isolation: P3 / P4 -> 404 common.not_found, no report content, no PDF bytes read', () => {
  it('P3 getPortalReport and P4 downloadPortalReportPdf (even with the right version id) -> common.not_found; storage never read', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' });
    expect((await rejection(p.w.call.p3(s.cred))).code).toBe('common.not_found');
    expect((await rejection(p.w.call.p4(s.cred, VER_A1))).code).toBe('common.not_found');
    expect(p.w.storageReads).toEqual([]);
  });
  it('a report-purpose session of the SAME report still works (control: the 404 is the purpose, not the data)', async () => {
    const p = makePayWorld(); const s = p.patient(); expect((await p.w.call.p3(s.cred)).status).toBe(200); expect((await p.w.call.p4(s.cred, VER_A1)).status).toBe(200);
  });
  it('the 404 is identical for a dues session of an unreleased report (nothing about the report leaks through a different error)', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' });
    const a = await rejection(p.w.call.p3(s.cred)); const b = await rejection(p.w.call.p4(s.cred, 'not-a-version'));
    expect([a.code, b.code]).toEqual(['common.not_found', 'common.not_found']);
  });
});

describe('portalSession resolver: portal_link_purpose claim (02-TRD §6.6; RLS policies read app.current_claims()->>\'portal_link_purpose\')', () => {
  const resolver = async () => (await import('../index.js')).manifest.authResolvers!['portalSession'] as { resolve(c: string, tx: unknown): Promise<any> };
  it('direct resolver: link and session credentials carry extraClaims.portal_link_purpose = the link\'s purpose (dues | report)', async () => {
    const w = makePortalWorld(); const r = await resolver();
    for (const purpose of ['report', 'dues'] as const) {
      const l = w.mkLink({ purpose }); const s = w.mkSession(l.row); const tx = w.db.newTx();
      try {
        expect((await r.resolve(l.cred, tx)).extraClaims, `link ${purpose}`).toMatchObject({ portal_stage: 'link', portal_link_purpose: purpose });
        expect((await r.resolve(s.cred, tx)).extraClaims, `session ${purpose}`).toMatchObject({ portal_stage: 'session', portal_link_purpose: purpose });
      } finally { w.db.endTx(tx, false); }
    }
  });
  it('through the core: authenticate() returns the claim `portal_link_purpose` (needs the C0 allow-list services/api/src/core/auth/claims.ts EXTRA_CLAIMS.reporting += portal_link_purpose — CR if C0-owned)', async () => {
    const w = makePortalWorld(); const d = w.mkLink({ purpose: 'dues' }); const rep = w.mkLink();
    expect(await w.authenticate(w.mkSession(d.row).cred)).toMatchObject({ portal_stage: 'session', portal_link_purpose: 'dues' });
    expect(await w.authenticate(w.mkSession(rep.row).cred)).toMatchObject({ portal_stage: 'session', portal_link_purpose: 'report' });
    expect(await w.authenticate(d.cred)).toMatchObject({ portal_stage: 'link', portal_link_purpose: 'dues' });
  });
  it('the claim comes from the DB row, never from the credential: a dues link cannot be turned into a report session by any request field', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' });
    const out = await rejection(p.w.run('getPortalReport', s.cred, { query: { purpose: 'report' }, headers: { 'x-portal-link-purpose': 'report' }, body: { purpose: 'report' } })); expect(out.code).toBe('common.not_found');
  });
});
// 07-SECURITY A27 (redeemPortalLinkForApp with a dues link -> reporting.link_invalid) is already pinned by reportingport.t37.test.ts ("dues-only link" row).
