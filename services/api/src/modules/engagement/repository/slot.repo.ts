// engagement.slot_templates / slot_blackouts / slot_occupancy / bookings reads (05-SCHEMA §2 slots; table matrix S I U: no DELETE, rows are deactivated).
// STAFF_C RLS scopes by centre; REQ-SEC-024: every statement still binds tenant_id. Static SQL; values are parameters (the only dynamic part is a fixed list of AND terms).
// Statements stay simple (no OR / JOIN / sub-select) so the in-house FakeDb interprets them; the overlap and affected-count logic lives in JS.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

const TPL_COLS = 'id, centre_id, booking_kind, weekdays, start_local, end_local, slot_minutes, capacity, effective_from, effective_to, is_active, version';
const BO_COLS = 'id, centre_id, booking_kind, starts_at, ends_at, reason_code, note, is_active, version';
export const TEMPLATE_COLS = ['booking_kind', 'weekdays', 'start_local', 'end_local', 'slot_minutes', 'capacity', 'effective_from', 'effective_to'] as const;

export interface TemplateValues {
  bookingKind: string; weekdays: number[]; startLocal: string; endLocal: string; slotMinutes: number; capacity: number; effectiveFrom: string; effectiveTo: string | null;
}

/** AND-joined terms from a closed list: placeholders are numbered, input only ever reaches the values array. */
function terms(base: Array<[string, unknown]>, extra: Array<[string, unknown]>): { where: string; values: unknown[] } {
  const all = [...base, ...extra.filter(([, v]) => v !== undefined)];
  return { where: all.map(([t], i) => t.replace('?', `$${i + 1}`)).join(' AND '), values: all.map(([, v]) => v) };
}

/** FK target read (core.collection_centres): same tenant, and visible under the actor's centre scope. */
export async function centreExists(tx: Q, a: { tenantId: string; centreId: string }): Promise<boolean> {
  const { rows } = await tx.query('SELECT id FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.centreId]);
  return rows.length > 0;
}

/** Serialises writers of one (centre, kind) scope for the overlap check-then-write (released with the transaction). */
export async function lockScope(tx: Q, a: { tenantId: string; centreId: string; bookingKind: string }): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`slot_tpl:${a.tenantId}:${a.centreId}:${a.bookingKind}`]);
}

export async function listTemplates(tx: Q, a: { tenantId: string; centreId?: string; isActive?: boolean }): Promise<Row[]> {
  const t = terms([['tenant_id = ?', a.tenantId]], [['centre_id = ?', a.centreId], ['is_active = ?', a.isActive]]);
  const { rows } = await tx.query(`SELECT ${TPL_COLS} FROM engagement.slot_templates WHERE ${t.where} ORDER BY centre_id, booking_kind, start_local, id LIMIT 200` /* contract maxItems 200 */, t.values);
  return rows;
}

export async function getTemplate(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${TPL_COLS} FROM engagement.slot_templates WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}

/** Active templates of one centre + kind (overlap rule candidates). */
export async function activeTemplates(tx: Q, a: { tenantId: string; centreId: string; bookingKind: string }): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT ${TPL_COLS} FROM engagement.slot_templates WHERE tenant_id = $1 AND centre_id = $2 AND booking_kind = $3 AND is_active = true`, [a.tenantId, a.centreId, a.bookingKind]);
  return rows;
}

export async function insertTemplate(tx: Q, a: { tenantId: string; userId: string; centreId: string; v: TemplateValues }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.slot_templates (id, tenant_id, centre_id, booking_kind, weekdays, start_local, end_local, slot_minutes, capacity, effective_from, effective_to, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING ${TPL_COLS}`,
    [uuidv7(), a.tenantId, a.centreId, a.v.bookingKind, a.v.weekdays, a.v.startLocal, a.v.endLocal, a.v.slotMinutes, a.v.capacity, a.v.effectiveFrom, a.v.effectiveTo, a.userId]);
  return rows[0];
}

/** undefined = no row matched id + version (the caller has read the row, so this means a concurrent change). */
export async function updateTemplate(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; v: TemplateValues }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.slot_templates SET booking_kind = $4, weekdays = $5, start_local = $6, end_local = $7, slot_minutes = $8, capacity = $9, effective_from = $10, effective_to = $11,
       version = version + 1, updated_at = now(), updated_by = $12
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${TPL_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.v.bookingKind, a.v.weekdays, a.v.startLocal, a.v.endLocal, a.v.slotMinutes, a.v.capacity, a.v.effectiveFrom, a.v.effectiveTo, a.userId]);
  return rows[0];
}

export async function deactivateTemplate(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.slot_templates SET is_active = false, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${TPL_COLS}`, [a.tenantId, a.id, a.expectedVersion, a.userId]);
  return rows[0];
}

/** Future occupancy rows of one template (ids + booked), for the overbooked and affected counts. */
export async function futureOccupancyOfTemplate(tx: Q, a: { tenantId: string; templateId: string; now: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT id, booked FROM engagement.slot_occupancy WHERE tenant_id = $1 AND template_id = $2 AND slot_start > $3', [a.tenantId, a.templateId, a.now]);
  return rows;
}

/** S9: the template's new capacity reaches its FUTURE occupancy rows (the reserve path checks `booked < slot_occupancy.capacity`, 02-TRD §4.8; 05-SCHEMA: capacity may drop below booked). booked is untouched. */
export async function syncOccupancyCapacity(tx: Q, a: { tenantId: string; userId: string; templateId: string; capacity: number; now: string }): Promise<void> {
  await tx.query(
    'UPDATE engagement.slot_occupancy SET capacity = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND template_id = $2 AND slot_start > $5',
    [a.tenantId, a.templateId, a.capacity, a.userId, a.now]);
}

/** Confirmed future bookings sitting on the given occupancy rows. */
export async function countConfirmedOnOccupancy(tx: Q, a: { tenantId: string; occupancyIds: readonly string[]; now: string }): Promise<number> {
  if (a.occupancyIds.length === 0) return 0;
  const { rows } = await tx.query(
    "SELECT count(*) FROM engagement.bookings WHERE tenant_id = $1 AND slot_occupancy_id = ANY($2::uuid[]) AND status = 'confirmed' AND slot_start > $3", [a.tenantId, [...a.occupancyIds], a.now]);
  return Number(rows[0]?.['count'] ?? 0);
}

/** Confirmed future bookings of the centre overlapping [startsAt, endsAt) (edges exclusive), of one kind or all kinds. */
export async function countConfirmedInRange(tx: Q, a: { tenantId: string; centreId: string; bookingKind: string | null; startsAt: string; endsAt: string; now: string }): Promise<number> {
  const t = terms(
    [['tenant_id = ?', a.tenantId], ['centre_id = ?', a.centreId], ['slot_start > ?', a.now], ['slot_start < ?', a.endsAt], ['slot_end > ?', a.startsAt]],
    [['booking_kind = ?', a.bookingKind ?? undefined]]);
  const { rows } = await tx.query(`SELECT count(*) FROM engagement.bookings WHERE ${t.where} AND status = 'confirmed'`, t.values);
  return Number(rows[0]?.['count'] ?? 0);
}

/** S6: occupancy counters of one centre + kind in a UTC window. */
export async function occupancyInRange(tx: Q, a: { tenantId: string; centreId: string; bookingKind: string; from: string; to: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT slot_start, capacity, booked FROM engagement.slot_occupancy WHERE tenant_id = $1 AND centre_id = $2 AND booking_kind = $3 AND slot_start >= $4 AND slot_start < $5', [a.tenantId, a.centreId, a.bookingKind, a.from, a.to]);
  return rows;
}

export async function listBlackouts(tx: Q, a: { tenantId: string; centreId?: string; isActive?: boolean }): Promise<Row[]> {
  const t = terms([['tenant_id = ?', a.tenantId]], [['centre_id = ?', a.centreId], ['is_active = ?', a.isActive]]);
  const { rows } = await tx.query(`SELECT ${BO_COLS} FROM engagement.slot_blackouts WHERE ${t.where} ORDER BY starts_at DESC, id LIMIT 200` /* contract maxItems 200 */, t.values);
  return rows;
}

export async function getBlackout(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${BO_COLS} FROM engagement.slot_blackouts WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}

export async function insertBlackout(tx: Q, a: { tenantId: string; userId: string; centreId: string; bookingKind: string | null; startsAt: string; endsAt: string; reasonCode: string; note: string | null }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.slot_blackouts (id, tenant_id, centre_id, booking_kind, starts_at, ends_at, reason_code, note, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${BO_COLS}`,
    [uuidv7(), a.tenantId, a.centreId, a.bookingKind, a.startsAt, a.endsAt, a.reasonCode, a.note, a.userId]);
  return rows[0];
}

export async function deactivateBlackout(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.slot_blackouts SET is_active = false, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${BO_COLS}`, [a.tenantId, a.id, a.expectedVersion, a.userId]);
  return rows[0];
}

/** Queues the booking_centres projection refresh (08 A19 D-119, TRD §8.1: max_attempts 5). Same tx as the template write; job key per tenant so repeated saves collapse. */
export async function enqueueCentreSync(tx: Q, a: { tenantId: string }): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)', ['engagement.sync_booking_centres', JSON.stringify({ tenant_id: a.tenantId }), `bcentres:${a.tenantId}`, null, 5]);
}
