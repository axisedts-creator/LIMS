// engagement.bookings / booking_items / booking_transitions / slot_occupancy / number_counters (+ reads of settings, booking_centres, bookable_items, slot_blackouts) for S1-S5
// (02-TRD §4.8, §5; 05-SCHEMA §2 bookings; table matrix S I U: no DELETE). STAFF_C RLS scopes by centre; REQ-SEC-024: every statement still binds tenant_id.
// Static SQL; values are parameters (the only dynamic part is a fixed list of AND terms). Statements stay simple (no OR / JOIN / sub-select) so the in-house FakeDb interprets them.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

const COLS = 'id, booking_no, patient_id, account_id, created_via, booking_kind, branch_id, centre_id, slot_occupancy_id, slot_start, slot_end, home_address_id, status, order_id, queue_token_id, checked_in_at, cancelled_at, cancel_reason_code, cancelled_by_kind, version';

function terms(base: Array<[string, unknown]>, extra: Array<[string, unknown]> = []): { where: string; values: unknown[] } {
  const all = [...base, ...extra.filter(([, v]) => v !== undefined)];
  return { where: all.map(([t], i) => t.replace('?', `$${i + 1}`)).join(' AND '), values: all.map(([, v]) => v) };
}

/** No settings row = feature never switched on = off. */
export async function settings(tx: Q, tenantId: string): Promise<Row | undefined> {
  const { rows } = await tx.query(
    'SELECT bookings_enabled, booking_horizon_days, booking_min_lead_minutes, max_active_bookings_per_profile, max_orderables_per_booking FROM engagement.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0];
}

/** D-119: the booking_centres projection is the only centre source. */
export async function bookingCentre(tx: Q, a: { tenantId: string; centreId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT centre_id, branch_id, display_name, is_active FROM engagement.booking_centres WHERE tenant_id = $1 AND centre_id = $2', [a.tenantId, a.centreId]);
  return rows[0];
}
export async function centreNames(tx: Q, tenantId: string): Promise<Row[]> {
  const { rows } = await tx.query('SELECT centre_id, display_name FROM engagement.booking_centres WHERE tenant_id = $1', [tenantId]);
  return rows;
}

export async function activeBlackouts(tx: Q, a: { tenantId: string; centreId: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT booking_kind, starts_at, ends_at FROM engagement.slot_blackouts WHERE tenant_id = $1 AND centre_id = $2 AND is_active = true', [a.tenantId, a.centreId]);
  return rows;
}

export async function bookableItems(tx: Q, a: { tenantId: string; orderableIds: readonly string[] }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT orderable_id, orderable_kind, display_name, indicative_price_paisa, sex_restriction, booking_kinds, is_active FROM engagement.bookable_items WHERE tenant_id = $1 AND orderable_id = ANY($2::uuid[])',
    [a.tenantId, [...a.orderableIds]]);
  return rows;
}

/** REQ-SEC-100: future confirmed bookings of one patient. */
export async function countFutureConfirmed(tx: Q, a: { tenantId: string; patientId: string; now: string }): Promise<number> {
  const { rows } = await tx.query("SELECT count(*) FROM engagement.bookings WHERE tenant_id = $1 AND patient_id = $2 AND status = 'confirmed' AND slot_start > $3", [a.tenantId, a.patientId, a.now]);
  return Number(rows[0]?.['count'] ?? 0);
}

/** Read-only fast path before the reserve: a known-full slot is refused without any write (the conditional UPDATE below stays the guard for races). */
export async function slotIsFull(tx: Q, a: { tenantId: string; centreId: string; bookingKind: string; slotStart: string }): Promise<boolean> {
  const { rows } = await tx.query(
    'SELECT booked, capacity FROM engagement.slot_occupancy WHERE tenant_id = $1 AND centre_id = $2 AND booking_kind = $3 AND slot_start = $4', [a.tenantId, a.centreId, a.bookingKind, a.slotStart]);
  return rows[0] !== undefined && Number(rows[0]['booked']) >= Number(rows[0]['capacity']);
}

/** TRD §4.8 step 4: occupancy row created if absent (capacity = template capacity), then a conditional increment; undefined = the slot is full. */
export async function reserve(tx: Q, a: { tenantId: string; userId: string; centreId: string; bookingKind: string; slotStart: string; slotEnd: string; templateId: string; capacity: number }): Promise<Row | undefined> {
  await tx.query(
    `INSERT INTO engagement.slot_occupancy (id, tenant_id, centre_id, booking_kind, slot_start, slot_end, template_id, capacity, booked, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $9) ON CONFLICT (tenant_id, centre_id, booking_kind, slot_start) DO NOTHING`,
    [uuidv7(), a.tenantId, a.centreId, a.bookingKind, a.slotStart, a.slotEnd, a.templateId, a.capacity, a.userId]);
  const { rows } = await tx.query(
    `UPDATE engagement.slot_occupancy SET booked = booked + 1, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND centre_id = $2 AND booking_kind = $3 AND slot_start = $4 AND booked < capacity RETURNING id`,
    [a.tenantId, a.centreId, a.bookingKind, a.slotStart, a.userId]);
  return rows[0];
}

/** Cancel: booked - 1 as a compare-and-set on the value just read (the statement subset has no subtraction); retried when another writer moved the counter in between. */
// ponytail: CAS loop, 10 attempts; switch to `booked = booked - 1` once the SQL subset allows it.
export async function release(tx: Q, a: { tenantId: string; userId: string; occupancyId: string }): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const { rows } = await tx.query('SELECT booked FROM engagement.slot_occupancy WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.occupancyId]);
    const booked = Number(rows[0]?.['booked'] ?? 0);
    if (booked < 1) return;
    const hit = await tx.query(
      'UPDATE engagement.slot_occupancy SET booked = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND booked = $5 RETURNING id',
      [a.tenantId, a.occupancyId, booked - 1, a.userId, booked]);
    if (hit.rows.length > 0) return;
  }
  throw new Error('slot_occupancy release contention');
}

/** 'BK{yy}{seq:6}' source (TRD §4.8 step 5): row created if absent, then the increment takes the row lock, so concurrent writers get distinct numbers. */
export async function nextBookingSeq(tx: Q, a: { tenantId: string; userId: string; yy: string }): Promise<number> {
  const key = `booking_no:${a.yy}`;
  await tx.query('INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, created_by) VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING', [a.tenantId, key, a.userId]);
  const { rows } = await tx.query('UPDATE engagement.number_counters SET last_value = last_value + 1, updated_at = now() WHERE tenant_id = $1 AND counter_key = $2 RETURNING last_value', [a.tenantId, key]);
  return Number(rows[0]!['last_value']);
}

export async function insertBooking(tx: Q, a: { tenantId: string; userId: string; bookingNo: string; patientId: string; kind: string; branchId: string; centreId: string; occupancyId: string; slotStart: string; slotEnd: string; now: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.bookings (id, tenant_id, booking_no, patient_id, created_via, booking_kind, branch_id, centre_id, slot_occupancy_id, slot_start, slot_end, status, confirmed_at, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'staff', $5, $6, $7, $8, $9, $10, 'confirmed', $11, 1, $12, $12) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.bookingNo, a.patientId, a.kind, a.branchId, a.centreId, a.occupancyId, a.slotStart, a.slotEnd, a.now, a.userId]);
  return rows[0]!;
}

export async function insertItem(tx: Q, a: { tenantId: string; userId: string; bookingId: string; centreId: string; orderableId: string; kind: string; name: string; pricePaisa: number | null; sortOrder: number }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.booking_items (id, tenant_id, booking_id, centre_id, orderable_id, orderable_kind, display_name_snapshot, indicative_price_paisa, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [uuidv7(), a.tenantId, a.bookingId, a.centreId, a.orderableId, a.kind, a.name, a.pricePaisa, a.sortOrder, a.userId]);
}

export async function insertTransition(tx: Q, a: { tenantId: string; userId: string; bookingId: string; centreId: string; from: string | null; to: string; reason: string | null; actorType: string; now: string }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.booking_transitions (id, tenant_id, booking_id, centre_id, from_status, to_status, reason_code, actor_type, actor_id, occurred_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9)`,
    [uuidv7(), a.tenantId, a.bookingId, a.centreId, a.from, a.to, a.reason, a.actorType, a.userId, a.now]);
}

export async function getBooking(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.bookings WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}

export async function itemsOf(tx: Q, a: { tenantId: string; bookingIds: readonly string[] }): Promise<Row[]> {
  if (a.bookingIds.length === 0) return [];
  const { rows } = await tx.query(
    'SELECT booking_id, orderable_id, display_name_snapshot, indicative_price_paisa, sort_order FROM engagement.booking_items WHERE tenant_id = $1 AND booking_id = ANY($2::uuid[]) ORDER BY sort_order',
    [a.tenantId, [...a.bookingIds]]);
  return rows;
}

export async function transitionsOf(tx: Q, a: { tenantId: string; bookingId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT from_status, to_status, reason_code, actor_type, occurred_at FROM engagement.booking_transitions WHERE tenant_id = $1 AND booking_id = $2 ORDER BY occurred_at, id LIMIT 200', [a.tenantId, a.bookingId]);
  return rows;
}

/** One keyset page. `after` = the cursor (slot_start, id): rows of the cursor's own slot_start come first (by id), then later slots; two simple queries, so no OR / row comparison is needed. */
export async function listPage(tx: Q, a: { tenantId: string; from: string; to: string; centreId?: string; kind?: string; statuses?: string[]; desc: boolean; limit: number; after?: { slotStart: string; id: string } }): Promise<Row[]> {
  const filters: Array<[string, unknown]> = [['centre_id = ?', a.centreId], ['booking_kind = ?', a.kind], ['status = ANY(?::text[])', a.statuses]];
  const dir = a.desc ? 'DESC' : 'ASC';
  const run = async (base: Array<[string, unknown]>, order: string, limit: number): Promise<Row[]> => {
    const t = terms([['tenant_id = ?', a.tenantId], ...base], filters);
    const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.bookings WHERE ${t.where} ORDER BY ${order} LIMIT ${limit}`, t.values);
    return rows;
  };
  if (!a.after) return run([['slot_start >= ?', a.from], ['slot_start < ?', a.to]], `slot_start ${dir}, id ${dir}`, a.limit);
  const same = await run([['slot_start = ?', a.after.slotStart], [a.desc ? 'id < ?' : 'id > ?', a.after.id]], `id ${dir}`, a.limit);
  if (same.length >= a.limit) return same;
  const rest = await run(a.desc ? [['slot_start >= ?', a.from], ['slot_start < ?', a.after.slotStart]] : [['slot_start > ?', a.after.slotStart], ['slot_start < ?', a.to]], `slot_start ${dir}, id ${dir}`, a.limit - same.length);
  return [...same, ...rest];
}

/** Conditional cancel (guards: version and a cancellable status): undefined = lost a race. */
export async function cancel(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; reason: string; now: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.bookings SET status = 'cancelled', cancelled_at = $4, cancel_reason_code = $5, cancelled_by_kind = 'staff', version = version + 1, updated_at = now(), updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('confirmed', 'checked_in') RETURNING ${COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.now, a.reason, a.userId]);
  return rows[0];
}

/** Conditional check-in (confirmed only); queue_token_id is set in the same statement when a token was issued first. */
export async function checkIn(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; tokenId: string | null; now: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.bookings SET status = 'checked_in', checked_in_at = $4, queue_token_id = $5, version = version + 1, updated_at = now(), updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'confirmed' RETURNING ${COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.now, a.tokenId, a.userId]);
  return rows[0];
}
