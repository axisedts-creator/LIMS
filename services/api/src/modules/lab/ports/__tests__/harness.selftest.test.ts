// C5 T-24 — harness self-test: the fixture -> lab.* mapping of ./harness.ts is valid against the migrated schema (checks, FKs, RLS-visible reads) and cleanup() empties the namespace.
// Independent of ../LabPort.impl.ts. Needs the database of tests/db/c5-t03/run.sh.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanup, closePools, L, live, NS, q, seedFixtures, TENANT, type World } from './harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
afterAll(closePools);

const A = TENANT.A, B = TENANT.B, CEN = L(4), CENB = L(5), DEP = L(7), T1 = L(8), TM = L(9);
const ids = { P: L(1), PB: L(3), O1: L(21), O2: L(22), OB: L(28), I1: L(31), I2: L(32), IM: L(33), IB: L(43), S1: L(51), S2: L(52), S3: L(53), R1: L(61), R2: L(62), RM: L(63), RB: L(74) };
const world = (): World => ({ barcodes: new Map(), mappings: [], criticalLimits: [], grants: {} });
const ord = (id: string, patientId: string, tenantId = A, centreId = CEN) => ({ id, tenantId, patientId, centreId, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } });
const fx = () => ({
  orders: [ord(ids.O1, ids.P), ord(ids.O2, ids.P), ord(ids.OB, ids.PB, B, CENB)],
  items: [
    { id: ids.I1, tenantId: A, orderId: ids.O1, testId: T1, departmentId: DEP, workflowType: 'standard' },
    { id: ids.I2, tenantId: A, orderId: ids.O2, testId: T1, departmentId: DEP, workflowType: 'standard', reportedAt: '2026-11-02T00:00:00.000Z' },
    { id: ids.IM, tenantId: A, orderId: ids.O2, testId: TM, departmentId: DEP, workflowType: 'microbiology' },
    { id: ids.IB, tenantId: B, orderId: ids.OB, testId: T1, departmentId: DEP, workflowType: 'standard' },
  ],
  specimens: [
    { id: ids.S1, tenantId: A, orderId: ids.O1, barcode: 'SYN-0001', status: 'received', itemIds: [] },
    { id: ids.S2, tenantId: A, orderId: ids.O1, barcode: 'SYN-0002-OLD', status: 'rejected', itemIds: [ids.I1] },
    { id: ids.S3, tenantId: A, orderId: ids.O1, barcode: 'SYN-0002-NEW', status: 'received', itemIds: [ids.I1], replacesSpecimenId: ids.S2 },
  ],
  results: [
    { id: ids.R1, tenantId: A, orderItemId: ids.I1, testId: T1, analyteId: L(11), versionNo: 2, status: 'approved', origin: 'manual', valueNumeric: '13.40', approvedAt: '2026-11-01T05:00:00.000Z', commentCodes: [], onHold: false, qcReviewRequired: false },
    { id: ids.R2, tenantId: A, orderItemId: ids.I1, testId: T1, analyteId: L(12), versionNo: 1, status: 'pending', commentCodes: [], onHold: false, qcReviewRequired: false },
    { id: ids.RM, tenantId: A, orderItemId: ids.IM, testId: TM, analyteId: L(14), versionNo: 1, status: 'verified', origin: 'module', verifiedAt: '2026-11-04T00:00:00.000Z', moduleRef: { module: 'micro', entityId: L(81), versionNo: 1 }, lastPhase: 'final', lastPayloadVersion: 1, commentCodes: [], onHold: false, qcReviewRequired: false },
    { id: ids.RB, tenantId: B, orderItemId: ids.IB, testId: T1, analyteId: L(11), versionNo: 1, status: 'pending', commentCodes: [], onHold: false, qcReviewRequired: false },
  ],
});

describe.skipIf(!live)('T-24 harness self-test', () => {
  it('seeds every fixture kind into valid lab rows (stripped barcodes, versions + approvals for approved results, order tests per item) and cleanup() empties the namespace', async () => {
    await cleanup(NS);
    const w = world();
    await seedFixtures(w, fx());
    const rows = (t: string, col = 'id') => q(`SELECT * FROM lab.${t} WHERE ${col}::text LIKE $1`, [`${NS}%`]);
    expect((await rows('orders')).map((r) => r.tenant_id).sort()).toEqual([A, A, B]);
    expect((await rows('specimens')).map((r) => r.barcode).sort()).toEqual(['SYN0001', 'SYN0002NEW', 'SYN0002OLD']);
    expect(w.barcodes.get('SYN0002OLD')).toBe('SYN-0002-OLD');
    const ot = Object.fromEntries((await rows('order_tests', 'order_id')).map((r) => [r.order_item_id, r]));
    expect(ot[ids.I1]).toMatchObject({ specimen_id: ids.S3, status: 'resulted', uses_existing_material: false });   // the non-rejected specimen; approved + pending -> not approved
    expect(ot[ids.I2]).toMatchObject({ status: 'approved', uses_existing_material: true });
    expect(ot[ids.I2].reported_at).not.toBeNull();
    expect((await rows('results', 'order_id')).length).toBe(4);
    expect((await q('SELECT version_no, superseded_by_version_no FROM lab.result_versions WHERE result_id = $1 ORDER BY version_no', [ids.R1]))).toEqual([{ version_no: 1, superseded_by_version_no: 2 }, { version_no: 2, superseded_by_version_no: null }]);
    expect((await q('SELECT kind FROM lab.approvals WHERE result_id = $1 ORDER BY version_no', [ids.R1])).map((r) => r.kind)).toEqual(['approval', 'amendment']);
    expect((await q('SELECT status, verified_at FROM lab.results WHERE id = $1', [ids.RM]))[0].status).toBe('verified');
    expect((await q("SELECT code FROM lab.g_cs_amendment_reasons WHERE code IN ('correction','module_preliminary_update')")).length).toBe(2);
    await seedFixtures(w, fx());                                  // additive + idempotent
    expect((await rows('results', 'order_id')).length).toBe(4);
    await cleanup(NS);
    for (const t of ['orders', 'specimens']) expect(await rows(t), t).toEqual([]);
    expect(await rows('results', 'order_id')).toEqual([]);
    expect(await rows('order_tests', 'order_id')).toEqual([]);
  });
});
