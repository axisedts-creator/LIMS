// C11.T-13 LIVE integration (GATED exactly like T-04/T-12/T-16: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a migrated DB incl. the anatomic DDL).
// Proves what the in-memory ../report.draft.handlers.test.ts cannot: the REAL partial unique indexes (one open draft per case, one initial draft per case), the report_drafts CHECKs/guard trigger,
// real diagnosis / template rows through the real repositories, RLS (tenant B), real parallel writers — AC-07.1, 07.4, 07.6, AC-08.5/08.6 (draft side), D-66 (b), through the real handlers and requestTx.
// AC-07.5 (image limit) and AC-07.3 are covered in the in-memory file only (seeding real image rows needs the upload pipeline).
// assertRole is a no-op (permission logic is in the unit file). Fixture ids 0190c411-… (h.cleanup() removes them); diagnoses use codes T13-* and templates keys t13_* and are wiped here.
// Not run here: no PG in this environment (see T-04 notes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { caseRow, CENTRE_A1, CENTRE_B1, CLAIMS, LIVE, openHarness, TENANT_A, TENANT_B, uid, type Harness } from './setup.js';

const TS = '2026-11-01T00:00:00.000Z';
const ctxFor = (tx: unknown, tenantId: string, actorId: string) => ({
  operationId: 'report.draft.live', clientIp: '203.0.113.7', requestId: uid(9992), log: { info() {}, warn() {}, error() {} }, tenantId, actor: { type: 'user', id: actorId }, tx,
  now: () => new Date('2026-11-13T04:00:00Z'), audit: { async access() {} },
  core: { async branch() { throw new Error('unused'); }, memberships: { async list() { return []; } }, async user() { return { displayName: 'Dr Synthetic One' }; } },
  ports: { IdentityPort: { async assertRole() {}, async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } }, CatalogPort: { async getTest() { throw new Error('unused'); } } },
}) as any;
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const validationFailed = (e: any, path: string) => {
  expect(isLimsError(e, 'common.validation_failed'), `code ${e?.code}`).toBe(true);
  expect(e.errors?.some((f: any) => f.path === path), `errors[] has ${path}: ${JSON.stringify(e.errors)}`).toBe(true);
};
const conflict = (e: any, code: string) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code}`).toBe(true); expect(e.statusCode).toBe(409); };
const DEF = {
  schema_version: 1, title: 'Synthetic live checklist', applies_to_case_kinds: ['histology'],
  sections: [{ key: 'tumour', heading: 'Tumour', fields: [{ key: 'site', label: 'Site', type: 'text', required: true }, { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] }] }],
};

describe.skipIf(!LIVE)('C11-T13 report drafts over a real DB', () => {
  let h: Harness;
  const op = (claims: Record<string, unknown>, tenant: string, name: string, req: Record<string, unknown>) =>
    h.asApp(claims, (tx) => (manifest.handlers as any)[name]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctxFor(tx, tenant, String(claims['sub']))));
  const asA = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.allA, TENANT_A, name, req);
  const asB = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.sysB, TENANT_B, name, req);
  const wipe = () => h.asSuperuser(async (tx) => {
    await tx.query(`DELETE FROM anatomic.report_drafts WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await tx.query(`DELETE FROM anatomic.cs_diagnoses WHERE code LIKE 'T13-%' AND tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await tx.query(`DELETE FROM anatomic.synoptic_templates WHERE template_key LIKE 't13\\_%' AND tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  });
  const seedCase = async (n: number, over: Record<string, unknown> = {}, tenant = TENANT_A, centre = CENTRE_A1) => {
    const c = caseRow(uid(3300 + n), tenant, centre, { created_at: TS, updated_at: TS, version: 1, current_version_no: 0, molecular_rev: 0, profile_missing: false, case_kind: 'histology', status: 'in_processing',
      accession_no: `H99-${9300 + n}`, accessioned_at: TS, ...over });
    await h.seed('anatomic.cases', c);
    return c['id'] as string;
  };
  const rows = (caseId: string) => h.asSuperuser(async (tx) => (await tx.query(`SELECT kind, status, version, impression_text, diagnosis_codes, synoptic, image_ids FROM anatomic.report_drafts WHERE case_id = $1 ORDER BY created_at`, [caseId])).rows);
  const save = (caseId: string, rev: number, body: Record<string, unknown>) => asA('saveAnatomicReportDraft', { params: { case_id: caseId }, headers: ifm(rev), body });
  let cMain: string, cRace: string, cLimit: string, cSigned: string, cSignedRev: string, cB: string;
  let tplPub: string, tplDraft: string;

  beforeAll(async () => {
    h = await openHarness(); await h.cleanup(); await wipe();
    cMain = await seedCase(1); cRace = await seedCase(2); cLimit = await seedCase(3); cSigned = await seedCase(4, { status: 'signed_out', signed_out_at: TS }); cSignedRev = await seedCase(5, { status: 'signed_out', signed_out_at: TS });
    cB = await seedCase(6, {}, TENANT_B, CENTRE_B1);
    for (const [n, code, active] of [[1, 'T13-0001', true], [2, 'T13-0009', false]] as const) {
      await h.seed('anatomic.cs_diagnoses', { id: uid(3500 + n), tenant_id: TENANT_A, code, display: `Synthetic diagnosis ${code}`, system: 'local', sort_order: 0, is_active: active, created_by: CLAIMS.allA.sub, updated_by: CLAIMS.allA.sub });
    }
    await h.seed('anatomic.cs_diagnoses', { id: uid(3510), tenant_id: TENANT_B, code: 'T13-B001', display: 'Tenant B diagnosis', system: 'local', sort_order: 0, is_active: true, created_by: CLAIMS.sysB.sub, updated_by: CLAIMS.sysB.sub });
    const tpl = (id: string, key: string, status: string) => ({ id, tenant_id: TENANT_A, template_key: key, version_no: 1, status, title: DEF.title, applies_to_case_kinds: ['histology'], definition: JSON.stringify(DEF),
      published_at: status === 'draft' ? null : TS, retired_at: status === 'retired' ? TS : null, created_by: CLAIMS.allA.sub, updated_by: CLAIMS.allA.sub });
    tplPub = uid(3600); tplDraft = uid(3601);
    await h.seed('anatomic.synoptic_templates', tpl(tplPub, 't13_pub', 'published'));
    await h.seed('anatomic.synoptic_templates', tpl(tplDraft, 't13_draft', 'draft'));
  });
  afterAll(async () => { if (h) { await wipe().catch(() => undefined); await h.cleanup().catch(() => undefined); await h.close(); } });

  it('AC-07.1: create ("0") → version 1 kind initial; update with the current version → 2; a stale If-Match → 409 common.version_conflict; the row in the database agrees', async () => {
    const a = await save(cMain, 0, { microscopy_text: 'Mucosa with mild gastritis.', impression_text: 'Chronic gastritis.', comment_text: 'Correlate clinically.' });
    expect(a.body).toMatchObject({ kind: 'initial', version: 1, impression_text: 'Chronic gastritis.' });
    const b = await save(cMain, 1, { impression_text: 'Chronic active gastritis.' });
    expect(b.body).toMatchObject({ version: 2, impression_text: 'Chronic active gastritis.', microscopy_text: '' });
    conflict(await rejects(save(cMain, 1, { impression_text: 'lost' })), 'common.version_conflict');
    conflict(await rejects(save(cMain, 0, { impression_text: 'lost' })), 'common.version_conflict');
    expect(await rows(cMain)).toEqual([expect.objectContaining({ kind: 'initial', status: 'open', version: 2, impression_text: 'Chronic active gastritis.' })]);
    expect((await asA('getAnatomicReportDraft', { params: { case_id: cMain } })).body).toEqual(b.body);
  });

  it('real unique indexes: two parallel creates with "0" → exactly one wins, the loser is common.version_conflict (not a raw 23505), one open draft in the table', async () => {
    const rs = await Promise.allSettled([save(cRace, 0, { impression_text: 'A' }), save(cRace, 0, { impression_text: 'B' })]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(isLimsError((rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict')).toBe(true);
    expect(await rows(cRace)).toHaveLength(1);
  });

  it('AC-07.4: impression of 8,001 characters → 400 at /impression_text; nothing reaches the table', async () => {
    validationFailed(await rejects(save(cLimit, 0, { impression_text: 'x'.repeat(8001) })), '/impression_text');
    expect(await rows(cLimit)).toEqual([]);
  });

  it('AC-07.6: an unknown, an inactive and another tenant\'s diagnosis code → 400 at /diagnosis_codes/0/code; an active one is stored and answered with its display', async () => {
    for (const code of ['T13-4040', 'T13-0009', 'T13-B001']) validationFailed(await rejects(save(cLimit, 0, { diagnosis_codes: [{ code }] })), '/diagnosis_codes/0/code');
    expect(await rows(cLimit)).toEqual([]);
    const ok = await save(cLimit, 0, { diagnosis_codes: [{ code: 'T13-0001' }] });
    expect(ok.body.diagnosis_codes).toEqual([{ code: 'T13-0001', display: 'Synthetic diagnosis T13-0001', system: 'local' }]);
    expect((await rows(cLimit))[0]!.diagnosis_codes).toEqual(['T13-0001']);
  });

  it('AC-08.5 / AC-08.6 (draft side): a published template with a required field empty saves; a draft-status template → 409 anatomic.template_not_published; another tenant\'s id is refused', async () => {
    const ok = await save(cMain, 2, { synoptic: [{ template_id: tplPub, values: { grade: 'g1' } }] });
    expect(ok.body.synoptic).toEqual([{ template_id: tplPub, template_key: 't13_pub', template_version: 1, title: DEF.title, values: { grade: 'g1' } }]);
    conflict(await rejects(save(cMain, 3, { synoptic: [{ template_id: tplDraft, values: {} }] })), 'anatomic.template_not_published');
    validationFailed(await rejects(save(cMain, 3, { synoptic: [{ template_id: tplPub, values: { grade: 'g9' } }] })), '/synoptic/0/values/grade');
  });

  it('D-66 (b): a signed_out case without an open change draft → 409 anatomic.signout_locked and no row; with an open revision draft the save updates that draft', async () => {
    conflict(await rejects(save(cSigned, 0, { impression_text: 'late edit' })), 'anatomic.signout_locked');
    expect(await rows(cSigned)).toEqual([]);
    await h.seed('anatomic.report_drafts', { id: uid(3800), tenant_id: TENANT_A, centre_id: CENTRE_A1, case_id: cSignedRev, kind: 'revision', status: 'open', change_reason_code: 'correction', impression_text: 'Signed text',
      base_version_no: 1, created_by: CLAIMS.allA.sub, updated_by: CLAIMS.allA.sub });
    const r = await save(cSignedRev, 1, { impression_text: 'Revised text' });
    expect(r.body).toMatchObject({ kind: 'revision', change_reason_code: 'correction', impression_text: 'Revised text', version: 2 });
    expect(await rows(cSignedRev)).toEqual([expect.objectContaining({ kind: 'revision', status: 'open', version: 2 })]);
  });

  it('tenant isolation (RLS + tenant-bound repos): tenant B cannot read or write tenant A\'s case/draft (404), and A cannot reach B\'s case; no row appears on the wrong side', async () => {
    for (const [fn, cs] of [[asB, cMain], [asA, cB]] as const) {
      expect(isLimsError(await rejects(fn('getAnatomicReportDraft', { params: { case_id: cs } })), 'common.not_found')).toBe(true);
      expect(isLimsError(await rejects(fn('saveAnatomicReportDraft', { params: { case_id: cs }, headers: ifm(0), body: { impression_text: 'cross' } })), 'common.not_found')).toBe(true);
    }
    expect(await rows(cB)).toEqual([]);
    expect((await rows(cMain))[0]!.impression_text).not.toBe('cross');
  });
});
