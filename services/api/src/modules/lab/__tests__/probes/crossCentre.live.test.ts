// C5 T-32 / 07-SECURITY §5.1 cross-CENTRE probes P-02, P-05 (centre A2 for an A1 user), P-06, P-12 and abuse case 5, on a real PG17.
// Two layers, both must hold (defence in depth, REQ-SEC-017):
//  (1) handler layer: a centre-A1-scoped user (IdentityPort centreScope = [A1]) names centre-A2 objects -> 404 common.not_found, nothing written, no A2 data in the answer;
//  (2) RLS layer: a device actor of centre A1 (claims actor_type 'device' + centre_id; app.has_all_centres() = false, 08 R3) reads lab tables directly: zero rows of centre A2 objects.
// P-12 hub-lab scope (08 A13 D-13): a processing-centre actor without all_centres and without the collection centre cannot see a specimen before receipt; after receipt at their centre they see it,
// its order tests and results (existing-material rows included).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A1_ONLY, CENTRE, CENTRE_A2, FULL_A, T, TENANT_A, api, as, closePools, claimsOf, codeOf, fire, live, objs, req, requestFor, requireDb, seen, snapshot, uid, withClaims, type Objs } from './kit.js';

let A1: Objs; let A2: Objs; let PRE: Objs; let POST: Objs;
beforeAll(async () => {
  if (!live) return;
  A1 = await objs('a', { centre: CENTRE.a }); A2 = await objs('a', { centre: CENTRE_A2 });
  PRE = await objs('a', { centre: CENTRE.a, state: 'collected' });                  // collected at A1, not yet received anywhere
  POST = await objs('a', { centre: CENTRE.a, processing: CENTRE_A2 });              // collected at A1, received at the hub A2
}, T);
afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

const A2_ONLY = as(A1_ONLY, { centreIds: [CENTRE_A2] });
const markers = (X: Objs) => [X.specimenId, X.barcode, X.regNo, X.resultId, X.orderTestId, X.criticalId, X.exceptionId, X.worksheetId, X.orderId];

// ---------------------------------------------------------------- P-02 / P-05 / P-06 handler layer
const CENTRE_OPS = ['getSpecimen', 'collectSpecimen', 'receiveSpecimen', 'rejectSpecimen', 'requestRecollection', 'createAliquots', 'storeSpecimen', 'discardSpecimen', 'requestOrderLabelPrint', 'getLabOrder',
  'listOrderResults', 'getWorksheet', 'getResult', 'getResultHistory', 'listResultVersions', 'verifyResult', 'returnResult', 'approveResult', 'amendResult', 'getCriticalValue', 'logCriticalNotification',
  'getIngestException', 'assignIngestException', 'reapplyIngestException', 'discardIngestException'];
describe.skipIf(!live)('P-02 / P-05 / P-06: centre-A1 user names a centre-A2 object => 404 common.not_found, nothing written', () => {
  it.each(CENTRE_OPS.map((id) => [id] as const))('%s', { timeout: T }, async (id) => {
    const before = await snapshot(TENANT_A);
    const out = await fire(id, requestFor(id, A2), A1_ONLY);
    expect(out.reply, `answered ${out.reply?.status}: A2 objects must be invisible to an A1-only user`).toBeUndefined();
    expect(codeOf(out), `${out.error?.message}`).toBe('common.not_found');
    const body = seen(out.error);
    for (const m of markers(A2)) expect(body, m).not.toContain(m);
    expect({ ...(await snapshot(TENANT_A)), access_log: '' }).toEqual({ ...before, access_log: '' });
  });
  it('control: the same user reads the A1 twin of each (not a blanket 404)', { timeout: T }, async () => {
    for (const id of ['getSpecimen', 'getLabOrder', 'getWorksheet', 'getResult', 'getCriticalValue', 'getIngestException']) {
      const out = await fire(id, requestFor(id, A1), A1_ONLY);
      expect(out.reply?.status, `${id}: ${out.error?.code} ${out.error?.message}`).toBe(200);
    }
  });
  it('P-02 lists: zero A2 rows for an A1-only user, A1 control rows present', { timeout: T }, async () => {
    for (const [id, own, other] of [['listSpecimens', A1.specimenId, A2.specimenId], ['listCriticalValues', A1.criticalId, A2.criticalId], ['listIngestExceptions', A1.exceptionId, A2.exceptionId],
      ['listWorksheets', A1.worksheetId, A2.worksheetId]] as const) {
      const out = await fire(id, id === 'listSpecimens' ? req({ query: { order_id: A2.orderId } }) : requestFor(id, A1), A1_ONLY);
      expect(out.reply?.status, `${id}: ${out.error?.code}`).toBe(200);
      expect(JSON.stringify(out.reply!.body), `${id} leaks ${other}`).not.toContain(other);
      if (id !== 'listSpecimens') expect(JSON.stringify(out.reply!.body), `${id} control`).toContain(own);
    }
  });
  it('P-02 status board: A2 order rows are not on the board of an A1-only user', { timeout: T }, async () => {
    const out = await fire('getStatusBoard', requestFor('getStatusBoard', A1), A1_ONLY);
    expect(out.reply?.status, `${out.error?.code}`).toBe(200);
    expect(JSON.stringify(out.reply!.body)).not.toContain(A2.regNo);
    expect(JSON.stringify(out.reply!.body)).toContain(A1.regNo);
  });
  // LD-126 / ruling: 07-SECURITY P-05 demands 404 for order_id; for specimen_ids the answer is the per-id common.not_found of P-04.
  it('P-05 printSpecimenLabels with an A2 order_id for an A1-only user => 404, no label counter / access-log change', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const out = await fire('printSpecimenLabels', req({ body: { order_id: A2.orderId } }), A1_ONLY);
    expect(codeOf(out), `${out.error?.message}`).toBe('common.not_found');
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it('P-04 printSpecimenLabels with specimen_ids [A2] for an A1-only user => 200, per-id common.not_found, no label', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const out = await fire('printSpecimenLabels', requestFor('printSpecimenLabels', A2), A1_ONLY);
    expect(out.reply?.status, `${out.error?.code} ${out.error?.message}`).toBe(200);
    expect(JSON.stringify(out.reply!.body)).toContain('common.not_found');
    expect(JSON.stringify(out.reply!.body)).not.toContain(A2.barcode);
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it('P-04 bulk with mixed A1 / A2 ids as an A1-only user: A2 id => per-id not_found', { timeout: T }, async () => {
    const out = await fire('bulkCollectSpecimens', req({ headers: { 'idempotency-key': uid() }, body: { items: [{ id: A1.specimenId, version: 1 }, { id: A2.specimenId, version: 1 }] } }), A1_ONLY);
    expect(out.reply?.status, `${out.error?.code}`).toBe(200);
    const b = (out.reply!.body.results as any[]).find((x) => x.id === A2.specimenId);
    expect(b?.code).toBe('common.not_found');
  });
  it('abuse case 5: receive with a processing_centre_id the user does not belong to => 403 auth.forbidden, nothing written', { timeout: T }, async () => {
    const own = await objs('a', { centre: CENTRE.a, state: 'collected' });
    const before = await snapshot(TENANT_A);
    const out = await fire('receiveSpecimen', req({ params: { specimen_id: own.specimenId }, headers: { 'if-match': '"1"' }, body: { processing_centre_id: CENTRE_A2 } }), A1_ONLY);
    expect(codeOf(out), `${out.error?.message}`).toBe('auth.forbidden');
    expect((out.error as any).statusCode).toBe(403);
    expect({ ...(await snapshot(TENANT_A)), access_log: '' }).toEqual({ ...before, access_log: '' });
    const bulk = await fire('bulkReceiveSpecimens', req({ headers: { 'idempotency-key': uid() }, body: { processing_centre_id: CENTRE_A2, items: [{ id: own.specimenId, version: 1 }] } }), A1_ONLY);
    expect(codeOf(bulk) ?? bulk.reply?.body?.results?.[0]?.code).toBe('auth.forbidden');
  });
  it('control: FULL_A (all centres) reads the A2 specimen', { timeout: T }, async () => {
    expect((await fire('getSpecimen', requestFor('getSpecimen', A2), FULL_A)).reply?.status).toBe(200);
  });
});

// ---------------------------------------------------------------- P-02 / P-12 RLS layer (device claims of one centre)
const deviceAt = (centre: string) => claimsOf(TENANT_A, { actor_type: 'device', centre_id: centre });
const idsVisible = (centre: string, table: string, ids: string[]) =>
  withClaims(api(), deviceAt(centre), async (c) => (await c.query(`SELECT id FROM lab.${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [TENANT_A, ids])).rows.map((r) => r.id as string));

describe.skipIf(!live)('P-02 RLS layer: a device of centre A1 sees no centre-A2 row of any centre-scoped lab table', () => {
  const T2 = (): Array<[string, string, string]> => [['specimens', A1.specimenId, A2.specimenId], ['order_tests', A1.orderTestId, A2.orderTestId], ['results', A1.resultId, A2.resultId],
    ['critical_value_log', A1.criticalId, A2.criticalId], ['ingest_exceptions', A1.exceptionId, A2.exceptionId], ['worksheets', A1.worksheetId, A2.worksheetId], ['orders', A1.orderId, A2.orderId]];
  it.each(['specimens', 'order_tests', 'results', 'critical_value_log', 'ingest_exceptions', 'worksheets', 'orders'])('%s', { timeout: T }, async (table) => {
    const [, mine, theirs] = T2().find((x) => x[0] === table)!;
    const seenIds = await idsVisible(CENTRE.a, table, [mine, theirs]);
    expect(seenIds).toContain(mine);
    expect(seenIds).not.toContain(theirs);
    expect(await idsVisible(CENTRE_A2, table, [mine, theirs])).toEqual([theirs]);   // and the mirror image
  });
});

describe.skipIf(!live)('P-12 hub-lab scope (08 A13 D-13): processing-centre actor without the collection centre', () => {
  it('RLS: before receipt the hub (A2) sees nothing of the A1-collected specimen; the collection centre A1 does', { timeout: T }, async () => {
    expect(await idsVisible(CENTRE_A2, 'specimens', [PRE.specimenId])).toEqual([]);
    expect(await idsVisible(CENTRE_A2, 'order_tests', [PRE.orderTestId])).toEqual([]);
    expect(await idsVisible(CENTRE_A2, 'results', [PRE.resultId])).toEqual([]);
    expect(await idsVisible(CENTRE.a, 'specimens', [PRE.specimenId])).toEqual([PRE.specimenId]);
  });
  it('RLS: after receipt at the hub, A2 sees the specimen, its order tests and its results', { timeout: T }, async () => {
    expect(await idsVisible(CENTRE_A2, 'specimens', [POST.specimenId])).toEqual([POST.specimenId]);
    expect(await idsVisible(CENTRE_A2, 'order_tests', [POST.orderTestId])).toEqual([POST.orderTestId]);
    expect(await idsVisible(CENTRE_A2, 'results', [POST.resultId])).toEqual([POST.resultId]);
  });
  it('handler: an A2-only user lists the received specimen and gets 404 on the unreceived one', { timeout: T }, async () => {
    const post = await fire('listSpecimens', req({ query: { order_id: POST.orderId } }), A2_ONLY);
    expect(post.reply?.status, `${post.error?.code}`).toBe(200);
    expect(JSON.stringify(post.reply!.body)).toContain(POST.specimenId);
    const pre = await fire('listSpecimens', req({ query: { order_id: PRE.orderId } }), A2_ONLY);
    expect(JSON.stringify(pre.reply?.body ?? '')).not.toContain(PRE.specimenId);
    expect(codeOf(await fire('getSpecimen', requestFor('getSpecimen', PRE), A2_ONLY))).toBe('common.not_found');
    expect((await fire('getSpecimen', requestFor('getSpecimen', POST), A2_ONLY)).reply?.status).toBe(200);
    expect((await fire('getResult', requestFor('getResult', POST), A2_ONLY)).reply?.status).toBe(200);
    expect(codeOf(await fire('getResult', requestFor('getResult', PRE), A2_ONLY))).toBe('common.not_found');
  });
});
