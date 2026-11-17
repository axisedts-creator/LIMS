// C5 T-32 / 07-SECURITY §5.1 cross-tenant probes P-01, P-03, P-04, P-05, P-07, EVERY lab operation (55 operationIds) on a real PG17 under RLS.
// Given tenant A authenticated with every lab permission (aal2, all centres) and tenant B's full object graph committed,
// When A calls an operation with B's ids in path / query / body (incl. arrays that MIX an A id with a B id),
// Then 404 common.not_found, no B id / barcode in the answer, and the owner-side snapshot of every B table is byte-identical afterwards ("DB check shows no B change").
// P-01 exception: getAnalyteTrend (#26, RLS-filtered list keyed by patient_id) answers 200 with empty `points` for a B patient id (no existence oracle).
// Needs LIMS_TEST_DATABASE_URL + LIMS_TEST_ADMIN_DATABASE_URL (tests/db/c5-t03/run.sh); under LIMS_T03_REQUIRE_DB=1 a missing database fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_A, FULL_B, OPS, T, TENANT_A, TENANT_B, closePools, codeOf, fire, live, objs, opById, req, requestFor, requireDb, seen, snapshot, uid, type Objs } from './kit.js';

let A: Objs; let B: Objs;
beforeAll(async () => { if (!live) return; A = await objs('a'); B = await objs('b'); }, T);
afterAll(async () => { await closePools(); });

const IN_BODY = new Set(['lookupSpecimenByBarcode', 'bulkCollectSpecimens', 'bulkDispatchSpecimens', 'bulkReceiveSpecimens', 'printSpecimenLabels', 'createWorksheet', 'bulkEnterResults', 'bulkVerifyResults',
  'bulkApproveResults', 'captureQcResult', 'createDeltaCheckRule']);   // the foreign id sits in the body: no path id
const LISTS = new Set(['listSpecimens', 'listWorklistItems', 'listPendingItems', 'listWorksheets', 'listVerificationQueue', 'listCriticalValues', 'listIngestExceptions', 'listQcResults', 'listQcHolds',
  'getStatusBoard', 'listDeltaCheckRules', 'listLabCodedSet']);
const TENANT_LEVEL = new Set(['getLabSettings', 'updateLabSettings', 'upsertLabCode']);   // no foreign id to name: own probes below
const markersOf = (X: Objs): string[] => [X.patientId, X.orderId, X.itemId, X.specimenId, X.barcode, X.regNo, X.orderTestId, X.resultId, X.criticalId, X.exceptionId, X.worksheetId, X.holdId, X.ruleId, X.ruleRowId,
  X.analyteId, X.instrumentId, X.codeOnlyHere, X.tenant];

describe.skipIf(!live)('registry', () => {
  it('every one of the 55 operations is probed below (path id, body id, list, or tenant level)', () => {
    const probed = OPS.filter((o) => o.pathParams.length > 0 || IN_BODY.has(o.id) || LISTS.has(o.id) || TENANT_LEVEL.has(o.id));
    expect(probed.map((o) => o.id).sort()).toEqual(OPS.map((o) => o.id).sort());
  });
});
describe('harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); });
});

// ---------------------------------------------------------------- P-01 every operation with an id parameter
describe.skipIf(!live)('P-01 operation names a tenant-B object', () => {
  const ops = OPS.filter((o) => o.pathParams.length > 0 && !TENANT_LEVEL.has(o.id) && !LISTS.has(o.id) && o.id !== 'getAnalyteTrend' && o.id !== 'listLabCodedSet');
  it.each(ops.map((o) => [o.id] as const))('%s => 404 common.not_found, no B data in the answer, zero B changes in the DB', { timeout: T }, async (id) => {
    const before = await snapshot(TENANT_B);
    const out = await fire(id, requestFor(id, B), FULL_A);
    expect(out.reply, `answered ${out.reply?.status}: B objects must be invisible to A`).toBeUndefined();
    expect(codeOf(out), `${out.error?.message}`).toBe('common.not_found');
    expect((out.error as any).statusCode).toBe(404);
    const body = seen(out.error);
    for (const needle of markersOf(B)) expect(body, needle).not.toContain(needle);
    expect(out.probe.logs.join('\n')).not.toContain(B.barcode);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('#26 getAnalyteTrend with a B patient id => 200 and empty points (no existence oracle), B untouched', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('getAnalyteTrend', requestFor('getAnalyteTrend', B), FULL_A);
    expect(out.reply?.status, JSON.stringify(out.error?.code)).toBe(200);
    expect(out.reply!.body.points).toEqual([]);
    expect(JSON.stringify(out.reply!.body)).not.toContain(B.patientId);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('control: the same operations answer for tenant A\'s own objects (the probe is not a blanket 404)', { timeout: T }, async () => {
    for (const id of ['getSpecimen', 'getResult', 'getLabOrder', 'getWorksheet', 'getCriticalValue', 'getIngestException']) {
      const out = await fire(id, requestFor(id, A), FULL_A);
      expect(out.reply?.status, `${id}: ${out.error?.code} ${out.error?.message}`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------- P-03 lists
describe.skipIf(!live)('P-03 list operations with B data present => zero B rows (and an A control row where the list must show one)', () => {
  const OWN: Record<string, (X: Objs) => string> = { listSpecimens: (X) => X.specimenId, listCriticalValues: (X) => X.criticalId, listIngestExceptions: (X) => X.exceptionId, listWorksheets: (X) => X.worksheetId,
    // LD-126: the listDeltaCheckRules DTO id is the row id
    listQcHolds: (X) => X.holdId, listDeltaCheckRules: (X) => X.ruleRowId, listLabCodedSet: (X) => X.codeOnlyHere, getStatusBoard: (X) => X.regNo };
  it.each([...LISTS].map((id) => [id] as const))('%s', { timeout: T }, async (id) => {
    const rq = (X: Objs) => (id === 'listSpecimens' ? req({ query: { order_id: X.orderId } }) : requestFor(id, X));
    const own = await fire(id, rq(A), FULL_A);
    expect(own.reply?.status, `${id}: ${own.error?.code} ${own.error?.message}`).toBe(200);
    const text = JSON.stringify(own.reply!.body);
    for (const needle of markersOf(B).filter((m) => m !== TENANT_B)) expect(text, needle).not.toContain(needle);
    if (OWN[id]) expect(text, `A control row of ${id}`).toContain(OWN[id]!(A));
    // naming B's ids as filters must not reveal B either
    const probe = await fire(id, rq(B), FULL_A);
    const t2 = JSON.stringify(probe.reply?.body ?? seen(probe.error));
    for (const needle of markersOf(B).filter((m) => m !== TENANT_B)) expect(t2, needle).not.toContain(needle);
    if (probe.reply) expect(probe.reply.status).toBe(200);
  });
  it('B sees its own rows (positive control for the B-side data)', { timeout: T }, async () => {
    const r = await fire('listSpecimens', req({ query: { order_id: B.orderId } }), FULL_B);
    expect(JSON.stringify(r.reply?.body)).toContain(B.specimenId);
  });
});

// ---------------------------------------------------------------- P-04 bulk with mixed A/B ids
describe.skipIf(!live)('P-04 bulk operations with mixed A/B ids => per-id common.not_found for B, A processed', () => {
  const outcomeOf = (body: any, id: string) => (body?.results ?? []).find((x: any) => x.id === id);
  it.each([
    ['bulkCollectSpecimens', (X: Objs) => ({ items: [{ id: X.specimenId, version: 1 }] }), (X: Objs) => X.specimenId],
    ['bulkDispatchSpecimens', (X: Objs) => ({ items: [{ id: X.specimenId, version: 1 }] }), (X: Objs) => X.specimenId],
    ['bulkReceiveSpecimens', (X: Objs) => ({ processing_centre_id: X.centre, items: [{ id: X.specimenId, version: 1 }] }), (X: Objs) => X.specimenId],
    ['bulkVerifyResults', (X: Objs) => ({ items: [{ id: X.resultId, version: 1 }] }), (X: Objs) => X.resultId],
    ['bulkApproveResults', (X: Objs) => ({ items: [{ id: X.resultId, version: 1 }] }), (X: Objs) => X.resultId],
  ] as const)('%s', { timeout: T }, async (id, bodyOf, idOf) => {
    const before = await snapshot(TENANT_B);
    const out = await fire(id, req({ headers: { 'idempotency-key': uid() }, body: { ...bodyOf(A), items: [...bodyOf(A).items, ...bodyOf(B).items] } }), FULL_A);
    expect(out.reply?.status, `${id}: ${out.error?.code} ${out.error?.message}`).toBe(200);
    const b = outcomeOf(out.reply!.body, idOf(B));
    expect(b, 'a per-id entry for the B id').toBeDefined();
    expect(b.outcome).not.toBe('ok');
    expect(b.code).toBe('common.not_found');
    expect(JSON.stringify(b)).not.toContain(B.barcode);
    expect(outcomeOf(out.reply!.body, idOf(A)), 'A id is answered too (processed, whatever its own state outcome)').toBeDefined();
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('bulkEnterResults entries [A result, B result]: B entry not_found, no B change', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const e = (X: Objs) => ({ result_id: X.resultId, version: 1, value_numeric: '5.5' });   // ruling A: DecimalString
    // LD-126: the code must not invent a CatalogPort; the probe supplies one so the A entry is processed (P-04).
    const catalog = { async referenceRangeFor() { return undefined; }, async criticalLimitsFor() { return undefined; } };
    const out = await fire('bulkEnterResults', req({ headers: { 'idempotency-key': uid() }, body: { entries: [e(A), e(B)] } }), FULL_A, { ports: { CatalogPort: catalog } });
    expect([200, 404]).toContain(out.reply?.status ?? (out.error as any)?.statusCode);
    expect(JSON.stringify(out.reply?.body ?? seen(out.error))).not.toContain(B.barcode);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
});

// ---------------------------------------------------------------- P-05 labels
describe.skipIf(!live)('P-05 label operations with a tenant-B order / specimen => 404', () => {
  it('requestOrderLabelPrint with B order_id', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('requestOrderLabelPrint', requestFor('requestOrderLabelPrint', B), FULL_A);
    expect(codeOf(out)).toBe('common.not_found');
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('printSpecimenLabels [A specimen, B specimen] => B refused, no B label counter / access-log change', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('printSpecimenLabels', req({ body: { specimen_ids: [A.specimenId, B.specimenId] } }), FULL_A);
    expect(out.reply?.status ?? (out.error as any)?.statusCode, `${out.error?.code}`).toBeGreaterThanOrEqual(200);
    if (out.reply) expect(JSON.stringify(out.reply.body)).not.toContain(B.barcode); else expect(codeOf(out)).toBe('common.not_found');
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('lookupSpecimenByBarcode with the barcode of a B label => 404 "No specimen with this barcode in your lab." (abuse case 2), no B data', { timeout: T }, async () => {
    const out = await fire('lookupSpecimenByBarcode', requestFor('lookupSpecimenByBarcode', B), FULL_A);
    expect(codeOf(out)).toBe('common.not_found');
    expect(seen(out.error)).not.toContain(B.specimenId);
    const mine = await fire('lookupSpecimenByBarcode', requestFor('lookupSpecimenByBarcode', A), FULL_A);   // control
    expect(mine.reply?.status, `${mine.error?.code}`).toBe(200);
  });
});

// ---------------------------------------------------------------- P-07 write / FK probes
describe.skipIf(!live)('P-07 write and FK probes: an A request that names a B id inside an A object is rejected and writes nothing', () => {
  it('createAliquots on an A specimen listing a tenant-B test id', { timeout: T }, async () => {
    const A7 = await objs('a');   // LD-126: fresh specimen, version 1 (the earlier print bumped A's)
    const before = { a: await snapshot(TENANT_A), b: await snapshot(TENANT_B) };
    const out = await fire('createAliquots', req({ params: { specimen_id: A7.specimenId }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { aliquots: [{ test_ids: [B.testId] }] } }), FULL_A);
    expect(out.reply, 'must be rejected').toBeUndefined();
    expect(['common.not_found', 'common.validation_failed']).toContain(codeOf(out));
    expect(seen(out.error)).not.toContain(B.testId);
    expect(await snapshot(TENANT_B)).toEqual(before.b);
    expect({ ...(await snapshot(TENANT_A)), access_log: '' }).toEqual({ ...before.a, access_log: '' });
  });
  it('assignIngestException: A exception assigned to a tenant-B result', { timeout: T }, async () => {
    const before = { a: await snapshot(TENANT_A), b: await snapshot(TENANT_B) };
    const out = await fire('assignIngestException', req({ params: { exception_id: A.exceptionId }, headers: { 'idempotency-key': uid() }, body: { result_id: B.resultId } }), FULL_A);
    expect(out.reply, 'must be rejected').toBeUndefined();
    expect(codeOf(out)).toBe('common.not_found');
    expect(await snapshot(TENANT_B)).toEqual(before.b);
    expect((await snapshot(TENANT_A))['ingest_exceptions']).toEqual(before.a['ingest_exceptions']);
  });
  it('logCriticalNotification on a B critical event', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('logCriticalNotification', requestFor('logCriticalNotification', B), FULL_A);
    expect(codeOf(out)).toBe('common.not_found');
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('createWorksheet naming order tests [A, B] => refused, no worksheet row', { timeout: T }, async () => {
    const n = (await (await import('./kit.js')).owner('SELECT count(*)::int AS n FROM lab.worksheets WHERE tenant_id = ANY($1)', [[TENANT_A, TENANT_B]]))[0].n;
    const out = await fire('createWorksheet', req({ headers: { 'idempotency-key': uid() }, body: { title: 'Probe mixed', order_test_ids: [A.orderTestId, B.orderTestId] } }), FULL_A);
    expect(out.reply, 'must be rejected').toBeUndefined();
    expect(['common.not_found', 'common.validation_failed']).toContain(codeOf(out));
    expect((await (await import('./kit.js')).owner('SELECT count(*)::int AS n FROM lab.worksheets WHERE tenant_id = ANY($1)', [[TENANT_A, TENANT_B]]))[0].n).toBe(n);
  });
  it('captureQcResult / createDeltaCheckRule with a B centre id or analyte id never writes into B', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const q = await fire('captureQcResult', req({ headers: { 'idempotency-key': uid() }, body: { ...(requestFor('captureQcResult', A).body as object), centre_id: B.centre } }), FULL_A);
    expect(q.reply?.status ?? 400).not.toBe(201);
    expect(q.reply).toBeUndefined();
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('A-side tenant level: getLabSettings returns A\'s row only; updateLabSettings changes only A', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const g = await fire('getLabSettings', requestFor('getLabSettings', B), FULL_A);
    expect(g.reply?.status, `${g.error?.code}`).toBe(200);
    expect(await snapshot(TENANT_B)).toEqual(before);
    const put = await fire('updateLabSettings', req({ headers: { 'if-match': `"${g.reply!.body.version ?? 1}"` }, body: (requestFor('updateLabSettings', A).body as object) }), FULL_A);
    expect([200, 409]).toContain(put.reply?.status ?? (put.error as any)?.statusCode);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
  it('upsertLabCode in A with a code that exists only in B creates an A row, B row untouched', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    const out = await fire('upsertLabCode', req({ params: { set_name: 'rejection_reasons', code: B.codeOnlyHere }, headers: { 'if-match': '"1"' }, body: { display: 'A twin (SYNTHETIC)', sort_order: 1, is_active: true } }), FULL_A);
    expect([200, 201, 404, 409]).toContain(out.reply?.status ?? (out.error as any)?.statusCode);
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
});
void opById;
