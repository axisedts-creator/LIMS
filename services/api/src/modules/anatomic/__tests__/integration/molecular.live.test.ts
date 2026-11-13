// C11.T-16 LIVE integration (GATED exactly like T-04/T-06/T-11: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a migrated DB incl. the anatomic DDL).
// Proves what the in-memory ../molecular.handlers.test.ts cannot: validation against a REAL assay definition (created through K9), the partial unique indexes molecular_results (case,target) and
// batch_members (batch,position)/(batch,case), the batches status/closed_at CHECK, the real "batch" counter (MB26xxxx), concurrent writers, RLS (tenant B / centre A1-only user), AC-11.1…11.6.
// Real handlers + real repositories + real requestTx. Fixture ids 0190c411-… (cleanup() removes them); assays/targets/values are created with codes T16_* and wiped here; the 2026 "batch" counter row of tenant A is reset.
// assertRole is a no-op (permission logic is in the unit file). Not run here: no PG in this environment (see T-04 notes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { caseRow, CENTRE_A1, CENTRE_A2, CLAIMS, LIVE, openHarness, TENANT_A, TENANT_B, uid, type Harness } from './setup.js';

const TS = '2026-11-01T00:00:00.000Z';
const ctxFor = (tx: unknown, tenantId: string, actorId: string) => ({
  operationId: 'molecular.live', clientIp: '203.0.113.7', requestId: uid(9991), log: { info() {}, warn() {}, error() {} }, tenantId, actor: { type: 'user', id: actorId }, tx,
  now: () => new Date('2026-11-12T01:30:00Z'), audit: { async access() {} },
  core: { async branch() { throw new Error('unused'); }, memberships: { async list() { return []; } } },
  ports: { IdentityPort: { async assertRole() {}, async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } }, CatalogPort: { async getTest() { throw new Error('unused'); } } },
}) as any;
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const validationFailed = (e: any) => expect(isLimsError(e, 'common.validation_failed'), `code ${e?.code}`).toBe(true);
const conflict = (e: any, code: string) => { expect(isLimsError(e, code), `expected ${code}, got ${e?.code}`).toBe(true); expect(e.statusCode).toBe(409); };

describe.skipIf(!LIVE)('C11-T16 molecular results and batches over a real DB', () => {
  let h: Harness;
  const op = (claims: Record<string, unknown>, tenant: string, name: string, req: Record<string, unknown>) =>
    h.asApp(claims, (tx) => (manifest.handlers as any)[name]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctxFor(tx, tenant, String(claims['sub']))));
  const asA = (name: string, req: Record<string, unknown> = {}) => op(CLAIMS.allA, TENANT_A, name, req);
  const wipe = () => h.asSuperuser(async (tx) => {
    await tx.query(`DELETE FROM anatomic.batch_members WHERE tenant_id = $1 AND batch_id IN (SELECT id FROM anatomic.batches WHERE tenant_id = $1)`, [TENANT_A]);
    await tx.query(`DELETE FROM anatomic.molecular_results WHERE tenant_id = $1`, [TENANT_A]);
    await tx.query(`DELETE FROM anatomic.batches WHERE tenant_id = $1`, [TENANT_A]);
    await tx.query(`DELETE FROM anatomic.assay_target_values WHERE tenant_id = $1 AND target_id IN (SELECT id FROM anatomic.assay_targets WHERE code LIKE 'T16_%')`, [TENANT_A]);
    await tx.query(`DELETE FROM anatomic.assay_targets WHERE tenant_id = $1 AND code LIKE 'T16_%'`, [TENANT_A]);
    await tx.query(`DELETE FROM anatomic.assays WHERE tenant_id = $1 AND code LIKE 'T16_%'`, [TENANT_A]);
    await tx.query(`DELETE FROM anatomic.accession_counters WHERE tenant_id = $1 AND series_key = 'batch' AND year_ad = 2026`, [TENANT_A]);
  });
  const seedCase = async (n: number, over: Record<string, unknown> = {}, centre = CENTRE_A1) => {
    const c = caseRow(uid(3100 + n), TENANT_A, centre, { created_at: TS, updated_at: TS, version: 1, current_version_no: 0, molecular_rev: 0, profile_missing: false, case_kind: 'molecular', status: 'in_processing',
      accession_no: `M99-${9000 + n}`, accessioned_at: TS, ...over });
    await h.seed('anatomic.cases', c);
    return c['id'] as string;
  };
  const results = (caseId: string) => h.asSuperuser(async (tx) => (await tx.query(`SELECT target_code, result_code, value_decimal, unit_code, is_active FROM anatomic.molecular_results WHERE case_id = $1 ORDER BY target_code, is_active`, [caseId])).rows);
  const members = (batchId: string) => h.asSuperuser(async (tx) => (await tx.query(`SELECT case_id, position FROM anatomic.batch_members WHERE batch_id = $1 AND is_active ORDER BY position`, [batchId])).rows);
  let c1: string, c2: string, c3: string, c4: string, cA2: string, cReady: string;

  beforeAll(async () => {
    h = await openHarness(); await h.cleanup(); await wipe();
    await asA('createAnatomicAssay', { body: { code: 'T16_PCR', display: 'Synthetic PCR (T-16)', is_active: true, targets: [
      { code: 'T16_T1', display: 'Target 1', allows_quantitative: false, sort_order: 1, is_active: true, result_values: [
        { code: 'detected', display: 'Detected', is_abnormal: true, sort_order: 1, is_active: true }, { code: 'not_detected', display: 'Not detected', is_abnormal: false, sort_order: 2, is_active: true },
        { code: 'invalid', display: 'Invalid', is_abnormal: true, sort_order: 3, is_active: true }] },
      { code: 'T16_T2', display: 'Target 2', allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 2, sort_order: 2, is_active: true, result_values: [
        { code: 'detected', display: 'Detected', is_abnormal: true, sort_order: 1, is_active: true }] }] } });
    c1 = await seedCase(1); c2 = await seedCase(2); c3 = await seedCase(3); c4 = await seedCase(4); cA2 = await seedCase(5, {}, CENTRE_A2); cReady = await seedCase(6);
  });
  afterAll(async () => { if (h) { await h.cleanup().catch(() => undefined); await wipe().catch(() => undefined); await h.close(); } });

  const row = (over: Record<string, unknown> = {}) => ({ assay_code: 'T16_PCR', target_code: 'T16_T1', result_code: 'detected', ...over });
  const put = (caseId: string, rev: number, rows: Record<string, unknown>[]) => asA('saveAnatomicMolecularResults', { params: { case_id: caseId }, headers: ifm(rev), body: { results: rows } });

  it('AC-11.1/11.3: records T1 = detected with kit data and T2 = 1250 copies_per_ml (text decimal); molecular_rev 0 → 1 in the database', async () => {
    const r = await put(c1, 0, [row({ method_text: 'Synthetic PCR', kit_name: 'SynKit', kit_lot: 'LOT-1', kit_expiry_on: '2027-01-31' }), row({ target_code: 'T16_T2', value_decimal: '1250', unit_code: 'copies_per_ml' })]);
    expect(r.body.molecular_rev).toBe(1);
    expect(await results(c1)).toEqual([{ target_code: 'T16_T1', result_code: 'detected', value_decimal: null, unit_code: null, is_active: true }, { target_code: 'T16_T2', result_code: 'detected', value_decimal: '1250', unit_code: 'copies_per_ml', is_active: true }]);
    const rev = await h.asSuperuser(async (tx) => (await tx.query(`SELECT molecular_rev FROM anatomic.cases WHERE id = $1`, [c1])).rows[0].molecular_rev);
    expect(rev).toBe(1);
  });
  it('AC-11.2/11.3: a code outside the result set, a non-decimal value and a wrong unit → 400; the stored rows and molecular_rev are untouched', async () => {
    validationFailed(await rejects(put(c1, 1, [row({ result_code: 'maybe' })])));
    validationFailed(await rejects(put(c1, 1, [row({ target_code: 'T16_T2', value_decimal: '12a', unit_code: 'copies_per_ml' })])));
    validationFailed(await rejects(put(c1, 1, [row({ target_code: 'T16_T2', value_decimal: '1.234', unit_code: 'copies_per_ml' })])));
    validationFailed(await rejects(put(c1, 1, [row({ target_code: 'T16_T2', value_decimal: '1', unit_code: 'mg_per_dl' })])));
    expect((await results(c1)).filter((x) => x.is_active)).toHaveLength(2);
  });
  it('full replace: the old T2 row stays as history (is_active false), exactly one active row per target (real partial unique index), stale If-Match → common.version_conflict', async () => {
    const r = await put(c1, 1, [row({ result_code: 'not_detected' })]);
    expect(r.body.molecular_rev).toBe(2);
    const rows = await results(c1);
    expect(rows.filter((x) => x.is_active).map((x) => x.target_code)).toEqual(['T16_T1']);
    expect(rows.filter((x) => !x.is_active).length).toBeGreaterThanOrEqual(2);
    expect(isLimsError(await rejects(put(c1, 1, [row()])), 'common.version_conflict')).toBe(true);
  });
  it('two concurrent saves with the same If-Match: exactly one succeeds, the other is common.version_conflict (no raw unique violation)', async () => {
    const rs = await Promise.allSettled([put(c2, 0, [row()]), put(c2, 0, [row({ result_code: 'not_detected' })])]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(isLimsError((rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict')).toBe(true);
    expect((await results(c2)).filter((x) => x.is_active)).toHaveLength(1);
  });

  it('AC-11.4: create a batch (MB26xxxx from the real counter), add 3 cases at positions 3,1,2 → listed 1,2,3; a duplicate position → 409 anatomic.batch_position_taken and nothing of that call is kept', async () => {
    const b = (await asA('createAnatomicBatch', { body: { assay_code: 'T16_PCR', capacity: 8, kit_lot: 'LOT-B' } })).body;
    expect(b.batch_no).toMatch(/^MB26\d{4}$/); expect(b).toMatchObject({ status: 'open', capacity: 8, member_count: 0, assay_code: 'T16_PCR' });
    const add = (batch: string, ms: { case_id: string; position: number }[]) => asA('addAnatomicBatchMembers', { params: { batch_id: batch }, body: { members: ms } });
    const r = await add(b.id, [{ case_id: c1, position: 3 }, { case_id: c2, position: 1 }, { case_id: c3, position: 2 }]);
    expect(r.body.members.map((m: any) => m.position)).toEqual([1, 2, 3]); expect(r.body.members[0].accession_no).toBe('M99-9002');
    conflict(await rejects(add(b.id, [{ case_id: c4, position: 4 }, { case_id: cReady, position: 2 }])), 'anatomic.batch_position_taken');
    expect(await members(b.id)).toHaveLength(3);
    validationFailed(await rejects(add(b.id, [{ case_id: c4, position: 9 }]))); // capacity 8
    const second = (await asA('createAnatomicBatch', { body: { assay_code: 'T16_PCR' } })).body;
    expect(Number(second.batch_no.slice(4))).toBe(Number(b.batch_no.slice(4)) + 1);
    // concurrent adds for one free position: the unique index lets exactly one in
    const rs = await Promise.allSettled([add(second.id, [{ case_id: c1, position: 1 }]), add(second.id, [{ case_id: c2, position: 1 }])]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    conflict((rs.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'anatomic.batch_position_taken');
    // Q6 frees the position, Q7 closes; AC-11.5 afterwards
    const detail = (await asA('getAnatomicBatch', { params: { batch_id: b.id } })).body;
    const removed = await asA('removeAnatomicBatchMembers', { params: { batch_id: b.id }, headers: ifm(detail.version), body: { case_ids: [c3] } });
    expect(removed.body.members.map((m: any) => m.position)).toEqual([1, 3]);
    expect((await add(b.id, [{ case_id: c4, position: 2 }])).body.members.map((m: any) => m.position)).toEqual([1, 2, 3]);
    const cur = (await asA('getAnatomicBatch', { params: { batch_id: b.id } })).body;
    const closed = await asA('closeAnatomicBatch', { params: { batch_id: b.id }, headers: ifm(cur.version) });
    expect(closed.body).toMatchObject({ status: 'closed', member_count: 3 });
    conflict(await rejects(add(b.id, [{ case_id: cReady, position: 8 }])), 'anatomic.batch_closed'); // AC-11.5
    conflict(await rejects(asA('closeAnatomicBatch', { params: { batch_id: b.id }, headers: ifm(closed.body.version) })), 'anatomic.batch_closed');
    expect(await members(b.id)).toHaveLength(3);
    const l = (await asA('listAnatomicBatches', { query: { status: 'closed' } })).body.data; expect(l.map((x: any) => x.id)).toContain(b.id);
  });

  it('RLS: tenant B cannot see or touch tenant A\'s batch (404); a centre-A1-only user cannot add an A2 case (404) and sees no A2 case through a batch', async () => {
    const b = (await asA('createAnatomicBatch', { body: { assay_code: 'T16_PCR' } })).body;
    expect(isLimsError(await rejects(op(CLAIMS.sysB, TENANT_B, 'getAnatomicBatch', { params: { batch_id: b.id } })), 'common.not_found')).toBe(true);
    expect((await op(CLAIMS.sysB, TENANT_B, 'listAnatomicBatches', {})).body.data.some((x: any) => x.id === b.id)).toBe(false);
    const e = await rejects(op(CLAIMS.a1Only, TENANT_A, 'addAnatomicBatchMembers', { params: { batch_id: b.id }, body: { members: [{ case_id: cA2, position: 1 }] } }));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(await members(b.id)).toEqual([]);
  });

  it('AC-11.6: a molecular case without any result cannot be marked ready (409 anatomic.case_invalid_transition); once a result is saved it can', async () => {
    const cur = async () => h.asSuperuser(async (tx) => (await tx.query(`SELECT version, status FROM anatomic.cases WHERE id = $1`, [cReady])).rows[0]);
    const ready = async () => asA('markAnatomicCaseReady', { params: { case_id: cReady }, headers: ifm((await cur()).version) });
    conflict(await rejects(ready()), 'anatomic.case_invalid_transition');
    expect((await cur()).status).toBe('in_processing');
    await put(cReady, 0, [row()]);
    expect((await ready()).body.status).toBe('ready_for_reporting');
    expect((await cur()).status).toBe('ready_for_reporting');
  });
});
