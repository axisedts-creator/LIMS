// C11.T-26 — nightly E2E scenario + performance check (06 plan row T-26; 02-TRD §14 "E2E (nightly)", §11 targets; 05-DoD §3.5).
// received event → accession → gross → blocks → slides → ready → draft → sign-out → (C5 fake verify/approve) → view row → amendment → addendum,
// then the 07-SECURITY §5.6 log scan, then p95 of every §11 operation against TARGETS_MS on the reference dataset (1× default; LIMS_E2E_SCALE=10).
// LD-140 (2026-11-13): UI-only rule; this suite drives the API, so no UI components/colours are involved.
// Needs the compose stack — not part of the per-task verify (see .orchestra/notes/C11.T-26-tests.md). Synthetic data only.
import { expect, test } from '@playwright/test';
import { Api, hook, PLANTED, runToSignOut, type Json } from './flow';
import { lifecycleRuns, TARGETS_MS, type Op } from './perf';

const scale = Number(process.env.LIMS_E2E_SCALE ?? 1);
const AMEND_REASON = process.env.LIMS_E2E_AMEND_REASON ?? ''; // a C5 `amendment_reasons` code (08 A17 D-62); never a system code
const NEEDS_REASON = 'NEEDS: LIMS_E2E_AMEND_REASON = an active C5 amendment reason code';

test.describe.serial('anatomic nightly scenario', () => {
  let api: Api;
  let caseId = '';
  let accession = '';

  test.beforeAll(async ({ playwright }) => {
    const token = process.env.LIMS_E2E_TOKEN;
    api = new Api(await playwright.request.newContext({ extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {} }));
  });

  test('1. received → … → sign-out (version 1 original, case signed_out)', async () => {
    const r = await runToSignOut(api, { planted: true });
    caseId = r.caseId;
    accession = r.accession;
    expect(r.signed.report_version).toMatchObject({ version_no: 1, version_kind: 'original', scope: 'full' });
    expect(r.signed.case.status).toBe('signed_out');
    expect(r.signed.report_version.submissions.length).toBeGreaterThan(0);
    expect(r.signed.report_version.submissions.length).toBeLessThanOrEqual(5);
    // lookup by accession still resolves to the case (REQ-SEC-098: label in body)
    const found = await api.call('POST', '/cases/lookup', { body: { label: accession }, op: 'lookupAnatomicObject', expect: 200 });
    expect(found.json).toMatchObject({ object_kind: 'case', case_id: caseId });
  });

  test('2. adding a part after sign-out is locked (AC-03.5)', async () => {
    const r = await api.call('POST', `/cases/${caseId}/parts`, { body: { site_text: 'Extra' } });
    expect(r.res.status()).toBe(409);
    expect(r.json.code ?? r.json.type).toContain('anatomic.signout_locked');
  });

  test('3. C5 fake verify+approve → published view row for version 1', async () => {
    await hook(api.req, 'c5_verify_approve', { case_id: caseId });
    await expect
      .poll(async () => (await api.detail(caseId, false)).items.every((i: Json) => i.lab_status === 'approved'), { timeout: 30_000 })
      .toBe(true);
    const row = await hook(api.req, 'view_row', { case_id: caseId, version_no: 1 }); // anatomic.v_pub_report_content (03-IC §6.8)
    expect(row).toMatchObject({ version_no: 1 });
    const v = (await api.call('GET', `/cases/${caseId}/versions/1`, { expect: 200 })).json;
    expect(v.version_kind).toBe('original');
  });

  test('4. change after approval → amendment (version 2) with C5 reason', async () => {
    expect(AMEND_REASON, NEEDS_REASON).not.toBe('');
    const d = await api.detail(caseId, false);
    const draft = (await api.call('POST', `/cases/${caseId}/changes`, { ifMatch: d.version, body: { reason_code: AMEND_REASON }, expect: 201 })).json;
    expect(draft.kind).toBe('amendment'); // approved target ⇒ amendment, not revision (04 §4.4)
    expect(draft.microscopy_text).toContain('benign'); // prefilled from the latest full version
    const saved = (
      await api.call('PUT', `/cases/${caseId}/report-draft`, {
        ifMatch: draft.version,
        op: 'saveAnatomicReportDraft',
        expect: 200,
        body: { gross_text: draft.gross_text, microscopy_text: draft.microscopy_text, impression_text: 'Skin, left arm: benign (amended).', diagnosis_codes: draft.diagnosis_codes.map((c: Json) => ({ code: c.code })) },
      })
    ).json;
    const out = (await api.call('POST', `/cases/${caseId}/sign-out`, { ifMatch: saved.version, body: { attest: true }, op: 'signOutAnatomicCase', expect: 200 })).json;
    expect(out.report_version).toMatchObject({ version_no: 2, version_kind: 'amendment', scope: 'full', change_reason_code: AMEND_REASON });
  });

  test('5. addendum: create → sign → version 3 addendum_only; versions newest first', async () => {
    const a = (await api.call('POST', `/cases/${caseId}/addenda`, { body: { kind: 'other', text: 'Supplementary note.' }, expect: 201 })).json;
    const out = (await api.call('POST', `/addenda/${a.id}/sign`, { ifMatch: a.version, body: { attest: true }, op: 'signOutAnatomicCase', expect: 200 })).json;
    expect(out.report_version).toMatchObject({ version_no: 3, version_kind: 'addendum', scope: 'addendum_only' });
    const list = (await api.call('GET', `/cases/${caseId}/versions`, { expect: 200 })).json.data as Json[];
    expect(list.map((v) => v.version_no)).toEqual([3, 2, 1]);
    // duplicate retry of the same sign (same Idempotency-Key) is covered by integration tests; here: signed addendum is immutable
    const put = await api.call('PUT', `/addenda/${a.id}`, { ifMatch: out.case.addenda.find((x: Json) => x.id === a.id).version, body: { kind: 'other', text: 'edit' } });
    expect(put.res.status()).toBe(409);
  });

  test('6. log scan: planted values absent from logs, metric labels and problem detail (07-SECURITY §5.6)', async () => {
    const logs = JSON.stringify(await hook(api.req, 'captured_logs', {}));
    for (const v of [PLANTED.accession, PLANTED.caption, PLANTED.gross, PLANTED.diagnosis]) expect(logs, `planted value leaked: ${v}`).not.toContain(v);
    const bad = await api.call('POST', `/cases/${caseId}/parts`, { body: { site_text: '' } }); // 400 problem+json: detail must not echo input
    expect(JSON.stringify(bad.json)).not.toContain(PLANTED.gross);
  });

  test(`7. perf: lifecycle x${lifecycleRuns(scale)} (seed ${scale}×) meets 02-TRD §11 p95 targets`, async () => {
    for (let i = 0; i < lifecycleRuns(scale); i++) await runToSignOut(api);
    for (let i = 0; i < 20 * scale; i++) await api.call('GET', '/cases?limit=50', { op: 'listAnatomicCases', expect: 200 });
    console.log(api.t.report());
    for (const op of Object.keys(TARGETS_MS) as Op[]) {
      expect(api.t.count(op), `${op}: no samples`).toBeGreaterThan(0);
      expect(api.t.p95(op), `${op} p95`).toBeLessThanOrEqual(TARGETS_MS[op]);
    }
  });
});
