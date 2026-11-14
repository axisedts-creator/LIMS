// micro.isolates + micro.specimen_isolate_counters writes of M7–M10 (02-TRD §5; 05-SCHEMA §8; 08 A17 P-22). REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS.
// Static SQL only; values are always parameters. The caller locks the culture row FOR UPDATE (cultures.repo lockCulture) before numbering.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

const COLS = 'id, version, culture_id, centre_id, specimen_id, isolate_seq, plate_id, status, organism_code, organism_source, identified_at, colony_description, quantity_text, is_reportable, withdraw_reason_code, ast_panel_id, ast_method';

/** An isolate by id, unlocked (RLS + tenant) — M8–M10 read it for the 404 / centre permission before locking the culture (review T-09 #1: culture-first lock order). */
export async function getIsolate(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${COLS} FROM micro.isolates WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id])).rows[0];
}

/** An isolate by id, locked (RLS + tenant: another tenant's / centre's isolate is simply absent). */
export async function getIsolateForUpdate(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${COLS} FROM micro.isolates WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [a.tenantId, a.id])).rows[0];
}

/**
 * Next isolate number of a specimen (08 A17 P-22): ONE upsert on the lazily created counter row; the row lock it takes serialises concurrent creates of any culture of the
 * specimen, so 20 parallel creates give 1..20. Never SELECT max + 1. The counter only grows (withdrawn numbers are never reused). CHECK 0..99 fails past 99 (23514).
 */
export async function nextIsolateSeq(tx: Q, a: { tenantId: string; specimenId: string; userId: string }): Promise<number> {
  const { rows } = await tx.query(
    `INSERT INTO micro.specimen_isolate_counters (tenant_id, specimen_id, last_seq, created_by, updated_by)
     VALUES ($1, $2, 1, $3, $3)
     ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = specimen_isolate_counters.last_seq + 1, updated_at = now(), updated_by = $3
     RETURNING last_seq`, [a.tenantId, a.specimenId, a.userId]);
  return Number(rows[0]!['last_seq']);
}

export interface NewIsolate {
  id: string; tenantId: string; centreId: string; cultureId: string; specimenId: string; seq: number; plateId: string | null; status: 'pending_id' | 'identified';
  organismCode: string | null; identifiedAt: Date | null; membershipId: string | null; colony: string | null; quantity: string | null; userId: string;
}
export async function insertIsolate(tx: Q, i: NewIsolate): Promise<Row> {
  const identified = i.status === 'identified';
  const { rows } = await tx.query(
    `INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, plate_id, status, organism_code, organism_source, identified_at, identified_by_membership_id,
            colony_description, quantity_text, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING ${COLS}`,
    [i.id, i.tenantId, i.centreId, i.cultureId, i.specimenId, i.seq, i.plateId, i.status, i.organismCode, identified ? 'manual' : null, i.identifiedAt, identified ? i.membershipId : null,
      i.colony, i.quantity, i.userId]);
  return rows[0]!;
}

/** M8 (I2 / I3): version-guarded; an instrument-sourced identification re-identified by hand becomes 'manual'. undefined = the version moved. */
export async function identify(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; organismCode: string; at: Date; membershipId: string | null; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.isolates SET status = 'identified', organism_code = $4, organism_source = 'manual', identified_at = $5, identified_by_membership_id = $6,
            version = version + 1, updated_at = now(), updated_by = $7
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${COLS}`, [a.tenantId, a.id, a.expectedVersion, a.organismCode, a.at, a.membershipId, a.userId]);
  return rows[0];
}

/** M9: full replace of the four fields (NULL = cleared). */
export async function describe(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; colony: string | null; quantity: string | null; isReportable: boolean; plateId: string | null; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.isolates SET colony_description = $4, quantity_text = $5, is_reportable = $6, plate_id = $7, version = version + 1, updated_at = now(), updated_by = $8
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${COLS}`, [a.tenantId, a.id, a.expectedVersion, a.colony, a.quantity, a.isReportable, a.plateId, a.userId]);
  return rows[0];
}

/** M10 (I4): withdrawn is terminal; organism and number are kept. */
export async function withdraw(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; reasonCode: string; comment: string | null; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.isolates SET status = 'withdrawn', withdraw_reason_code = $4, withdraw_comment = $5, version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${COLS}`, [a.tenantId, a.id, a.expectedVersion, a.reasonCode, a.comment, a.userId]);
  return rows[0];
}
