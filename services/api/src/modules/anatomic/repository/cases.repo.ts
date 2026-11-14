// anatomic.cases / anatomic.case_transitions / anatomic.case_items — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import type { CaseQueue, CaseSort } from '../domain/case.js';
import { page, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const CASES_UPDATABLE = { branch_id: '', status: '', priority: '', accession_no: '', accession_series: '', accession_year: '', clinical_history_text: '', assigned_pathologist_membership_id: '', profile_missing: '', current_version_no: '', molecular_rev: '', accessioned_at: '', accessioned_by: '', signed_out_at: '', cancelled_at: '', cancel_reason_code: '', cancel_reason_text: '' } as const;
const CASE_ITEMS_UPDATABLE = { role: '', lab_approved_version_no: '', lab_approved_at: '', is_active: '' } as const;

/** Undefined = an open case (tenant, order, case_kind) already exists: INSERT … ON CONFLICT DO NOTHING (intake race, 02-TRD §4.1). */
export async function insertCase(tx: Q, row: Row): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.cases (id, tenant_id, centre_id, branch_id, order_id, patient_id, case_kind, status, priority, accession_no, accession_series, accession_year, clinical_history_text, assigned_pathologist_membership_id, profile_missing, received_at, accessioned_at, accessioned_by, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::text, 'received'), COALESCE($9::text, 'routine'), $10, $11, $12, $13, $14, COALESCE($15::boolean, false), $16, $17, $18, $19, $20)
     ON CONFLICT (tenant_id, order_id, case_kind) WHERE status NOT IN ('signed_out','cancelled') DO NOTHING RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['branch_id'] ?? null, row['order_id'] ?? null, row['patient_id'] ?? null, row['case_kind'] ?? null, row['status'] ?? null, row['priority'] ?? null, row['accession_no'] ?? null, row['accession_series'] ?? null, row['accession_year'] ?? null, row['clinical_history_text'] ?? null, row['assigned_pathologist_membership_id'] ?? null, row['profile_missing'] ?? null, row['received_at'] ?? null, row['accessioned_at'] ?? null, row['accessioned_by'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0];
}

/** forUpdate: take the case row lock (serialises A6 part-letter allocation per case). */
export async function getCase(tx: Q, i: { tenantId: string; caseId: string; forUpdate?: boolean }): Promise<Row | undefined> {
  const sql = i.forUpdate
    ? `SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND id = $2 FOR UPDATE`
    : `SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND id = $2`;
  const { rows } = await tx.query(sql, [i.tenantId, i.caseId]);
  return rows[0];
}

export async function listCases(tx: Q, i: { tenantId: string; status?: string; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY received_at DESC, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.status ?? null, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCase(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CASES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.cases SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

// ---- A1 listAnatomicCases page (C11 T-07). Queue definitions = 03-APP-FLOW §4.1; every sub-select is tenant-bound to the outer case row. ----
const OPEN_STAIN = `EXISTS (SELECT 1 FROM anatomic.stain_orders so WHERE so.tenant_id = c.tenant_id AND so.case_id = c.id AND so.status IN ('requested','in_progress'))`;
const QUEUE_SQL: Record<CaseQueue, string> = {
  to_accession: `c.status = 'received'`,
  grossing: `c.status = 'accessioned' AND c.case_kind IN ('histology','cytology')
    AND EXISTS (SELECT 1 FROM anatomic.case_items ci JOIN anatomic.test_profiles tp ON tp.tenant_id = ci.tenant_id AND tp.test_id = ci.test_id
                WHERE ci.tenant_id = c.tenant_id AND ci.case_id = c.id AND ci.is_active AND tp.requires_gross)
    AND EXISTS (SELECT 1 FROM anatomic.parts p WHERE p.tenant_id = c.tenant_id AND p.case_id = c.id
                AND NOT EXISTS (SELECT 1 FROM anatomic.gross_records g WHERE g.tenant_id = p.tenant_id AND g.part_id = p.id AND g.is_complete))`,
  bench: `((c.status IN ('accessioned','in_processing')
      AND (EXISTS (SELECT 1 FROM anatomic.slides sl WHERE sl.tenant_id = c.tenant_id AND sl.case_id = c.id AND sl.status = 'pending_stain') OR ${OPEN_STAIN}))
    OR (c.status = 'signed_out' AND ${OPEN_STAIN}))`,
  reporting: `(c.status = 'ready_for_reporting' OR (c.status = 'signed_out' AND (
      EXISTS (SELECT 1 FROM anatomic.report_drafts d WHERE d.tenant_id = c.tenant_id AND d.case_id = c.id AND d.status = 'open')
      OR EXISTS (SELECT 1 FROM anatomic.addenda ad WHERE ad.tenant_id = c.tenant_id AND ad.case_id = c.id AND ad.status = 'draft'))))`,
  // CR-C11-011: lab_approved_version_no < latest item_version_no of an active PRIMARY item; no submission -> max() is NULL -> not awaiting
  awaiting_lab: `c.status = 'signed_out' AND EXISTS (SELECT 1 FROM anatomic.case_items ci WHERE ci.tenant_id = c.tenant_id AND ci.case_id = c.id AND ci.is_active AND ci.role = 'primary'
    AND ci.lab_approved_version_no < (SELECT max(s.item_version_no) FROM anatomic.item_submissions s WHERE s.tenant_id = ci.tenant_id AND s.case_item_id = ci.id))`,
  signed_out: `c.status = 'signed_out'`,
  cancelled: `c.status = 'cancelled'`,
  all: 'TRUE',
};
/** keyset columns per sort (+ c.id as the final tiebreak); casts type the cursor values. accessioned_at NULL sorts as 'infinity' so the key is never NULL. */
const SORT_SQL: Record<CaseSort, { keys: [string, string][]; desc: boolean }> = {
  received_at: { keys: [['c.received_at', 'timestamptz']], desc: false },
  '-received_at': { keys: [['c.received_at', 'timestamptz']], desc: true },
  accessioned_at: { keys: [[`COALESCE(c.accessioned_at, 'infinity')`, 'timestamptz']], desc: false },
  '-accessioned_at': { keys: [[`COALESCE(c.accessioned_at, 'infinity')`, 'timestamptz']], desc: true },
  priority_received_at: { keys: [[`(CASE WHEN c.priority = 'urgent' THEN 0 ELSE 1 END)`, 'integer'], ['c.received_at', 'timestamptz']], desc: false },
};
// timestamps leave the DB as ISO text with microseconds, so a cursor key round-trips exactly (no ms truncation by the driver)
const ISO_FMT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export interface CasePageInput {
  tenantId: string; queue: CaseQueue; sort: CaseSort; limit: number; caseKinds?: string[]; centreIds?: string[]; priority?: string[];
  assignedMembershipId?: string; receivedFrom?: string; receivedTo?: string; after?: { keys: string[]; id: string };
}
/** One page of cases + the computed CaseSummary columns. `limit` is page size + 1 (the caller probes for a next page). Only fixed SQL text is interpolated; values are bound. */
export async function listCasesPage(tx: Q, i: CasePageInput): Promise<Row[]> {
  const args: unknown[] = [i.tenantId];
  const bind = (v: unknown, cast: string) => { args.push(v); return `$${args.length}::${cast}`; };
  const where = [QUEUE_SQL[i.queue]];
  if (i.caseKinds) where.push(`c.case_kind = ANY(${bind(i.caseKinds, 'text[]')})`);
  if (i.centreIds) where.push(`c.centre_id = ANY(${bind(i.centreIds, 'uuid[]')})`);
  if (i.priority) where.push(`c.priority = ANY(${bind(i.priority, 'text[]')})`);
  if (i.assignedMembershipId) where.push(`c.assigned_pathologist_membership_id = ${bind(i.assignedMembershipId, 'uuid')}`);
  if (i.receivedFrom) where.push(`c.received_at >= ${bind(i.receivedFrom, 'timestamptz')}`);
  if (i.receivedTo) where.push(`c.received_at < ${bind(i.receivedTo, 'timestamptz')}`);
  const s = SORT_SQL[i.sort];
  const cols = [...s.keys.map(([e]) => e), 'c.id'];
  if (i.after) {
    const vals = [...s.keys.map(([, cast], n) => bind(i.after!.keys[n], cast)), bind(i.after.id, 'uuid')];
    where.push(`(${cols.join(', ')}) ${s.desc ? '<' : '>'} (${vals.join(', ')})`);
  }
  const WHERE = where.join(' AND ');
  const ORDER = cols.map((e) => `${e} ${s.desc ? 'DESC' : 'ASC'}`).join(', ');
  const LIMIT = bind(i.limit, 'integer');
  const { rows } = await tx.query(
    `SELECT c.id, c.centre_id, c.branch_id, c.order_id, c.patient_id, c.case_kind, c.status, c.priority, c.accession_no, c.assigned_pathologist_membership_id,
            c.profile_missing, c.current_version_no, c.molecular_rev, c.version,
            to_char(c.received_at AT TIME ZONE 'UTC', ${ISO_FMT}) AS received_at, to_char(c.accessioned_at AT TIME ZONE 'UTC', ${ISO_FMT}) AS accessioned_at,
            to_char(c.signed_out_at AT TIME ZONE 'UTC', ${ISO_FMT}) AS signed_out_at,
            (SELECT count(*)::int FROM anatomic.parts p WHERE p.tenant_id = c.tenant_id AND p.case_id = c.id) AS part_count,
            ARRAY(SELECT ci.test_id FROM anatomic.case_items ci WHERE ci.tenant_id = c.tenant_id AND ci.case_id = c.id AND ci.is_active ORDER BY ci.created_at, ci.id) AS test_ids,
            EXISTS (SELECT 1 FROM anatomic.parts p WHERE p.tenant_id = c.tenant_id AND p.case_id = c.id AND p.specimen_state = 'rejected') AS specimen_rejected,
            EXISTS (SELECT 1 FROM anatomic.report_drafts d WHERE d.tenant_id = c.tenant_id AND d.case_id = c.id AND d.status = 'open' AND d.kind <> 'initial') AS open_change,
            (SELECT count(*)::int FROM anatomic.stain_orders so WHERE so.tenant_id = c.tenant_id AND so.case_id = c.id AND so.status IN ('requested','in_progress')) AS pending_stain_orders,
            EXISTS (SELECT 1 FROM anatomic.parts p WHERE p.tenant_id = c.tenant_id AND p.case_id = c.id AND COALESCE(btrim(p.site_text), '') = '') AS parts_missing_site
       FROM anatomic.cases c WHERE c.tenant_id = $1 AND ${WHERE} ORDER BY ${ORDER} LIMIT ${LIMIT}`, args);
  return rows;
}

/** A2: accession number, block label or slide label -> the owning case (labels are unique per tenant). */
export async function lookupObjectByLabel(tx: Q, i: { tenantId: string; label: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT 'case' AS object_kind, c.id AS case_id, NULL::uuid AS block_id, NULL::uuid AS slide_id, c.centre_id FROM anatomic.cases c WHERE c.tenant_id = $1 AND c.accession_no = $2
     UNION ALL SELECT 'block', b.case_id, b.id, NULL::uuid, b.centre_id FROM anatomic.blocks b WHERE b.tenant_id = $1 AND b.label = $2
     UNION ALL SELECT 'slide', s.case_id, s.block_id, s.id, s.centre_id FROM anatomic.slides s WHERE s.tenant_id = $1 AND s.label = $2
     LIMIT 1`, [i.tenantId, i.label]);
  return rows[0];
}

/** All cases of one order (an order can open one case per kind). */
export async function listCasesByOrder(tx: Q, i: { tenantId: string; orderId: string }): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND order_id = $2 ORDER BY received_at, id`, [i.tenantId, i.orderId]);
  return rows;
}

export async function insertCaseTransition(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.case_transitions (id, tenant_id, centre_id, case_id, from_status, to_status, reason_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['from_status'] ?? null, row['to_status'] ?? null, row['reason_code'] ?? null, row['created_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCaseTransition(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.case_transitions WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCaseTransitions(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.case_transitions WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Undefined = the order item already has a case item (tenant, order_item_id): ON CONFLICT DO NOTHING. */
export async function insertCaseItem(tx: Q, row: Row): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.case_items (id, tenant_id, centre_id, case_id, order_item_id, test_id, role, lab_approved_version_no, lab_approved_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::text, 'primary'), COALESCE($8::integer, 0), $9, $10, $11)
     ON CONFLICT (tenant_id, order_item_id) DO NOTHING RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['order_item_id'] ?? null, row['test_id'] ?? null, row['role'] ?? null, row['lab_approved_version_no'] ?? null, row['lab_approved_at'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0];
}

export async function getCaseItem(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.case_items WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCaseItems(tx: Q, i: { tenantId: string; caseId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.case_items WHERE tenant_id = $1 AND case_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY created_at, id`, [i.tenantId, i.caseId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCaseItem(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CASE_ITEMS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.case_items SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
