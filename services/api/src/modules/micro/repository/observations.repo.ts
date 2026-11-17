// micro.culture_observations (M6; 02-TRD §5, §4.1; 05-SCHEMA §8). Append-only: this file has no UPDATE and no DELETE (AC-04.4, a correction is a new row).
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

export interface NewObservation {
  id: string; tenantId: string; centreId: string; cultureId: string; plateId: string | null; kind: string; growthCode: string | null; quantityText: string | null;
  findingText: string | null; observedAt: Date; hoursSincePlanting: number | null; membershipId: string | null; correctsId: string | null; userId: string;
}
export async function insertObservation(tx: Q, o: NewObservation): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, plate_id, kind, growth_code, quantity_text, finding_text, observed_at, hours_since_planting,
       recorded_by_membership_id, corrects_observation_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, kind, plate_id, growth_code, quantity_text, finding_text, observed_at, hours_since_planting::text AS hours_since_planting, recorded_by_membership_id, corrects_observation_id`,
    [o.id, o.tenantId, o.centreId, o.cultureId, o.plateId, o.kind, o.growthCode, o.quantityText, o.findingText, o.observedAt, o.hoursSincePlanting, o.membershipId, o.correctsId, o.userId]);
  return rows[0]!;
}

/** Which culture an observation belongs to (S-03 id_mismatch); another tenant's / centre's row is absent. */
export async function ownerOfObservation(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query('SELECT id, culture_id FROM micro.culture_observations WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id])).rows[0];
}

/** Which culture a plate belongs to. */
export async function ownerOfPlate(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  return (await tx.query('SELECT id, culture_id FROM micro.culture_plates WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id])).rows[0];
}

/** Latest plate_read.observed_at of the culture (02-TRD §4.1), or null. */
export async function latestReadAt(tx: Q, a: { tenantId: string; cultureId: string }): Promise<Date | null> {
  const v = (await tx.query(
    `SELECT max(observed_at) AS latest FROM micro.culture_observations WHERE tenant_id = $1 AND culture_id = $2 AND kind = 'plate_read'`, [a.tenantId, a.cultureId])).rows[0]?.['latest'];
  return v == null ? null : new Date(v);
}
