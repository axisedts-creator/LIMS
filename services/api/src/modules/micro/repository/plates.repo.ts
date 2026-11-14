// micro.culture_plates + the setup-time reads/writes of M3–M5 (02-TRD §5; 05-SCHEMA §8). REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS.
// Static SQL only; values are always parameters. The culture row is locked FOR UPDATE by the caller (lockCulture) before any plate number is computed.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

const PLATE_COLS = 'id, version, plate_no, media_code, incubation_text, parent_plate_id, source_isolate_id, planted_at, status, culture_id';

/** Highest plate_no of the culture (0 = none yet). Discarded plates keep their number. */
export async function maxPlateNo(tx: Q, a: { tenantId: string; cultureId: string }): Promise<number> {
  const { rows } = await tx.query('SELECT max(plate_no) AS max_no FROM micro.culture_plates WHERE tenant_id = $1 AND culture_id = $2', [a.tenantId, a.cultureId]);
  return Number(rows[0]?.['max_no'] ?? 0);
}

export interface NewPlate {
  id: string; tenantId: string; centreId: string; cultureId: string; plateNo: number; mediaCode: string; incubationText: string | null;
  parentPlateId: string | null; sourceIsolateId: string | null; plantedAt: Date; membershipId: string | null; userId: string;
}
export async function insertPlate(tx: Q, p: NewPlate): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, incubation_text, parent_plate_id, source_isolate_id, planted_at, planted_by_membership_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING ${PLATE_COLS}`,
    [p.id, p.tenantId, p.centreId, p.cultureId, p.plateNo, p.mediaCode, p.incubationText, p.parentPlateId, p.sourceIsolateId, p.plantedAt, p.membershipId, p.userId]);
  return rows[0]!;
}

/** A plate by id, locked (RLS + tenant: another tenant's / centre's plate is simply absent). */
export async function getPlateForUpdate(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${PLATE_COLS} FROM micro.culture_plates WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [a.tenantId, a.id])).rows[0];
}

/** Version-checked discard; undefined = the version moved (409 common.version_conflict). */
export async function discardPlate(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE micro.culture_plates SET status = 'discarded', discarded_at = now(), version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${PLATE_COLS}`, [a.tenantId, a.id, a.expectedVersion, a.userId]);
  return rows[0];
}

/** A plate or isolate id given by the client: which culture does it belong to? (S-03 id_mismatch). */
export async function ownerOfIsolate(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query('SELECT id, culture_id FROM micro.isolates WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id])).rows[0];
}

// ------------------------------------------------------------------ setup inputs (protocol resolution)
/** A protocol by id with the flags setup needs (superseded / inactive versions cannot be chosen). */
export async function getProtocolForSetup(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query(
    `SELECT id, code, version_no, display, read_schedule_hours, final_no_growth_hours, requires_gram_stain, is_active, superseded_at
       FROM micro.plating_protocols WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id])).rows[0];
}

export async function protocolMedia(tx: Q, a: { tenantId: string; protocolId: string }): Promise<Row[]> {
  return (await tx.query(
    'SELECT media_code, incubation_text, sort_order FROM micro.plating_protocol_media WHERE tenant_id = $1 AND protocol_id = $2 ORDER BY sort_order', [a.tenantId, a.protocolId])).rows;
}
