// lab.order_tests + worksheets (lab.worksheets, lab.worksheet_items) (05-SCHEMA §1; indexes 05 §5). Tenant filter explicit (REQ-SEC-024).
import { getRow, insertRow, isUuid, limitOf, query, table, updateRow, type RepoCtx, type Row } from './base.repo.js';

export const ORDER_TESTS = table('lab.order_tests', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'processing_branch_id', 'order_id', 'order_item_id',
  'test_id', 'test_code', 'test_revision', 'catalog_revision', 'department_id', 'workflow_type', 'priority', 'specimen_id', 'uses_existing_material', 'status',
  'approved_at', 'reported_at', 'tat_target_seconds', 'ordered_at', 'received_at', 'cancelled_at', 'cancel_reason',
  'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'], { frozen: ['order_id', 'order_item_id', 'test_id'] });
export const WORKSHEETS = table('lab.worksheets', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'title', 'department_id', 'instrument_id', 'item_count',
  'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/** Snapshot rows (class A). */
export const WORKSHEET_ITEMS = table('lab.worksheet_items', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'worksheet_id', 'position', 'order_test_id',
  'specimen_id', 'snapshot', 'created_at', 'created_by']);

export const insertOrderTest = (rc: RepoCtx, row: Row) => insertRow(rc, ORDER_TESTS, row);
export const getOrderTest = (rc: RepoCtx, id: string) => getRow(rc, ORDER_TESTS, id);
export const updateOrderTest = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, ORDER_TESTS, id, expectedVersion, patch);

/** order_tests__tenant_id_order__idx */
export const listOrderTestsByOrder = async (rc: RepoCtx, orderId: string) =>
  (isUuid(orderId) ? query(rc, 'SELECT * FROM lab.order_tests WHERE tenant_id = $1 AND order_id = $2 ORDER BY ordered_at, id', [orderId]) : []);

// ---- T-07 specimen-driven order test moves (every statement: tenant filter, version bump) ----
/** S2: the specimen's tests wait for receipt. */
export const markTestsAwaitingReceipt = (rc: RepoCtx, specimenId: string) =>
  query(rc, `UPDATE lab.order_tests SET status = 'awaiting_receipt', version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $3 AND status = 'awaiting_collection' RETURNING id`, [rc.actorId, specimenId]);
/** S4: the specimen's tests start processing at the processing centre (03-APP-FLOW S4). */
export const startTestsOfSpecimen = (rc: RepoCtx, specimenId: string, p: { centreId: string; branchId: string; receivedAt: string }) =>
  query(rc, `UPDATE lab.order_tests SET status = 'in_process', processing_centre_id = $3, processing_branch_id = $4, received_at = $5::timestamptz,
                    version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $6 AND status IN ('awaiting_collection','awaiting_receipt') RETURNING id`,
    [rc.actorId, p.centreId, p.branchId, p.receivedAt, specimenId]);
/** 08 A13 D-13: existing-material tests of the order (no specimen) get the processing centre/branch when they have none yet. */
export const copyProcessingToExistingMaterialTests = (rc: RepoCtx, orderId: string, p: { centreId: string; branchId: string }) =>
  query(rc, `UPDATE lab.order_tests SET processing_centre_id = $3, processing_branch_id = $4, version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND order_id = $5 AND uses_existing_material = true AND specimen_id IS NULL AND processing_centre_id IS NULL RETURNING id`,
    [rc.actorId, p.centreId, p.branchId, orderId]);

// ---- T-08 reject / recollection / aliquots (every statement: tenant filter, version bump) ----
const LIVE = `('awaiting_collection','awaiting_receipt','in_process','resulted','verified')`;
/** order_tests__tenant_id_specimen__idx */
export const listOrderTestsOfSpecimen = (rc: RepoCtx, specimenId: string) =>
  query(rc, 'SELECT id, order_item_id, test_id, status FROM lab.order_tests WHERE tenant_id = $1 AND specimen_id = $2', [specimenId]);
/** S11 (08 A13 D-5): the specimen's not-yet-approved tests become cancelled (specimen_rejected); approved / excluded / outsourced tests keep their state. */
export const cancelTestsOfSpecimen = (rc: RepoCtx, specimenId: string, at: string) =>
  query(rc, `UPDATE lab.order_tests SET status = 'cancelled', cancelled_at = $3::timestamptz, cancel_reason = 'specimen_rejected', version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $4 AND status IN ${LIVE} RETURNING id`, [rc.actorId, at, specimenId]);
/** S12: the tests cancelled by a rejection of `fromId` follow the recollection (re-pointed + re-opened). */
export const reopenTestsOfSpecimen = (rc: RepoCtx, fromId: string, toId: string) =>
  query(rc, `UPDATE lab.order_tests SET specimen_id = $3, status = 'awaiting_collection', cancelled_at = NULL, cancel_reason = NULL, version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $4 AND status = 'cancelled' AND cancel_reason = 'specimen_rejected' RETURNING id`, [rc.actorId, toId, fromId]);
/** S5: the tests assigned to an aliquot follow their results. */
export const moveTestsToSpecimen = (rc: RepoCtx, fromId: string, toId: string, testIds: readonly string[]) =>
  query(rc, `UPDATE lab.order_tests SET specimen_id = $3, version = version + 1, updated_at = now(), updated_by = $2
             WHERE tenant_id = $1 AND specimen_id = $4 AND test_id = ANY($5::uuid[]) AND status IN ${LIVE} RETURNING id`, [rc.actorId, toId, fromId, testIds]);

/** order_tests__tenant_id_worklist__p_idx; urgent first ('urgent' > 'routine'), then receipt time. */
export const listWorklist = async (rc: RepoCtx, o: { departmentId: string; limit: number }) => {
  const limit = limitOf(o?.limit);
  if (!isUuid(o.departmentId)) return [];
  return query(rc, `SELECT * FROM lab.order_tests WHERE tenant_id = $1 AND department_id = $2 AND status IN ('in_process','resulted','verified')
                    ORDER BY priority DESC, received_at, id LIMIT $3`, [o.departmentId, limit]);
};

/** order_tests__tenant_id_pending__p_idx; oldest order first. */
export const listPending = (rc: RepoCtx, o: { limit: number }) =>
  query(rc, `SELECT * FROM lab.order_tests WHERE tenant_id = $1 AND status IN ('awaiting_collection','awaiting_receipt','in_process','resulted','verified')
             ORDER BY ordered_at, id LIMIT $2`, [limitOf(o?.limit)]);
