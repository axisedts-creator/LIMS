// micro.cultures + micro.culture_transitions writes used by the lab.specimen.status_changed.v1 consumer (02-TRD §8.2; 05-SCHEMA cultures).
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

/** The culture of (order item, specimen) = the creation key, locked for the delivery. */
export async function findByItemSpecimen(tx: Q, a: { tenantId: string; orderItemId: string; specimenId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    'SELECT id, status, last_specimen_seq, centre_id FROM micro.cultures WHERE tenant_id = $1 AND order_item_id = $2 AND specimen_id = $3 FOR UPDATE',
    [a.tenantId, a.orderItemId, a.specimenId]);
  return rows[0];
}

/** Every culture of one specimen (rejection fan-out), locked, with "has a submitted report version". */
export async function listBySpecimen(tx: Q, a: { tenantId: string; specimenId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT c.id, c.status, c.last_specimen_seq, c.centre_id,
            EXISTS (SELECT 1 FROM micro.report_versions rv WHERE rv.tenant_id = c.tenant_id AND rv.culture_id = c.id) AS has_report
       FROM micro.cultures c WHERE c.tenant_id = $1 AND c.specimen_id = $2 ORDER BY c.id FOR UPDATE OF c`, [a.tenantId, a.specimenId]);
  return rows;
}

export interface NewCulture {
  id: string; tenantId: string; centreId: string; orderId: string; orderItemId: string; specimenId: string; patientId: string; testId: string;
  specimenTypeCode: string; receivedAt: string; seq: number; userId: string;
}
/** ON CONFLICT on the creation key; undefined = another delivery created it first. */
export async function insertCulture(tx: Q, c: NewCulture): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO micro.cultures (id, tenant_id, centre_id, order_id, order_item_id, specimen_id, patient_id, test_id, specimen_type_code, status, received_at, last_specimen_seq, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     ON CONFLICT (tenant_id, order_item_id, specimen_id) DO NOTHING RETURNING id`,
    [c.id, c.tenantId, c.centreId, c.orderId, c.orderItemId, c.specimenId, c.patientId, c.testId, c.specimenTypeCode, 'awaiting_setup', c.receivedAt, c.seq, c.userId]);
  return rows[0];
}

export async function insertTransition(tx: Q, t: { id: string; tenantId: string; centreId: string; cultureId: string; from: string | null; to: string; reason: string | null; occurredAt: string; userId: string }): Promise<void> {
  await tx.query(
    `INSERT INTO micro.culture_transitions (id, tenant_id, centre_id, culture_id, from_status, to_status, reason_code, occurred_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [t.id, t.tenantId, t.centreId, t.cultureId, t.from, t.to, t.reason, t.occurredAt, t.userId]);
}

/** Aliquot re-point (only while awaiting_setup; cultures_guard re-checks). The audit trigger records the change. */
export async function repoint(tx: Q, a: { tenantId: string; id: string; specimenId: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET specimen_id = $3, last_specimen_seq = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_setup'`, [a.tenantId, a.id, a.specimenId, a.seq, a.userId]);
}

export async function cancelForRejection(tx: Q, a: { tenantId: string; id: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET status = 'cancelled', cancel_reason_code = 'specimen_rejected', cancelled_at = now(), last_specimen_seq = $3,
            version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.seq, a.userId]);
}

/** Advance last_specimen_seq of one culture, forward only. */
export async function bumpSeq(tx: Q, a: { tenantId: string; id: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET last_specimen_seq = $3, version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2 AND last_specimen_seq < $3`, [a.tenantId, a.id, a.seq, a.userId]);
}

/** Other statuses: last_specimen_seq of every culture of the specimen, forward only. */
export async function bumpSeqBySpecimen(tx: Q, a: { tenantId: string; specimenId: string; seq: number; userId: string }): Promise<void> {
  await tx.query(
    `UPDATE micro.cultures SET last_specimen_seq = $3, version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND specimen_id = $2 AND last_specimen_seq < $3`, [a.tenantId, a.specimenId, a.seq, a.userId]);
}
