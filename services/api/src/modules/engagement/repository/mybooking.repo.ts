// Patient-side reads / writes for E30-E36 (T-BK1): engagement.accounts, account_patient_links, settings, bookable_items, booking_centres, slot_templates, bookings, booking_items, booking_transitions
// (02-TRD §4.8, §5; 05-SCHEMA §2 / §5 PAT_ACC). PAT_ACC RLS shows a patient only its own account's rows, but REQ-SEC-024 holds: every statement binds tenant_id AND (where the table has it) account_id.
// Static SQL, values as parameters; statements stay simple (no OR / JOIN / sub-select) so the in-house FakeDb interprets them. Shared booking statements (reserve, release, nextBookingSeq, itemsOf ...) stay in booking.repo.ts.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

const COLS = 'id, booking_no, patient_id, account_id, link_id, created_via, booking_kind, branch_id, centre_id, slot_occupancy_id, slot_start, slot_end, home_address_id, status, order_id, cancel_reason_code, cancelled_by_kind, replaces_booking_id, version';

/** The caller's live account from the signed membership claim. `lock` = FOR UPDATE: serialises one account's creates, so the per-profile / per-day caps cannot be raced (released with the transaction). */
export async function account(tx: Q, a: { tenantId: string; membershipId: string; lock?: boolean }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT id, user_id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status <> 'deleted'${a.lock ? ' FOR UPDATE' : ''}`, [a.tenantId, a.membershipId]);
  return rows[0];
}

/** The account's ACTIVE profiles (links); suspended / revoked links are not profiles any more (P-L5). */
export async function activeLinks(tx: Q, a: { tenantId: string; accountId: string }): Promise<Array<{ id: string; patientId: string; sex: string | null }>> {
  const { rows } = await tx.query("SELECT id, patient_id, sex_snapshot FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'", [a.tenantId, a.accountId]);
  return rows.map((r: Row) => ({ id: r['id'], patientId: r['patient_id'], sex: r['sex_snapshot'] ?? null }));
}

export async function settings(tx: Q, tenantId: string): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT bookings_enabled, home_collection_enabled, home_collection_centre_id, booking_horizon_days, booking_min_lead_minutes, booking_cancel_cutoff_minutes,
            max_active_bookings_per_profile, max_bookings_created_per_account_day, max_orderables_per_booking FROM engagement.settings WHERE tenant_id = $1`, [tenantId]);
  return rows[0];
}

// ponytail: the catalogue and the centre list are small per tenant (a few hundred rows at most): filtered / paged in JS, no ILIKE / array-contains in SQL; move into SQL if a tenant ever lists thousands.
export async function activeItems(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT orderable_id, orderable_kind, code, display_name, indicative_price_paisa, sex_restriction, booking_kinds, sort_order FROM engagement.bookable_items WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order, orderable_id LIMIT 2000', [a.tenantId]);
  return rows;
}
export async function activeCentres(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT centre_id, display_name, address_text FROM engagement.booking_centres WHERE tenant_id = $1 AND is_active = true ORDER BY display_name, centre_id LIMIT 500', [a.tenantId]);
  return rows;
}
/** (centre, kind) pairs that have an active slot template: a centre offers a kind when it has one. */
export async function templateKinds(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT centre_id, booking_kind FROM engagement.slot_templates WHERE tenant_id = $1 AND is_active = true', [a.tenantId]);
  return rows;
}

/** Future confirmed bookings of ONE profile (link): staff-entered bookings have no link and never count (AB-10). */
export async function countActiveOfLink(tx: Q, a: { tenantId: string; linkId: string; now: string }): Promise<number> {
  const { rows } = await tx.query("SELECT count(*) FROM engagement.bookings WHERE tenant_id = $1 AND link_id = $2 AND status = 'confirmed' AND slot_start > $3", [a.tenantId, a.linkId, a.now]);
  return Number(rows[0]?.['count'] ?? 0);
}
/** Bookings CREATED by the account since `since` (any status: a cancel does not give the quota back). */
export async function countCreatedSince(tx: Q, a: { tenantId: string; accountId: string; since: string }): Promise<number> {
  const { rows } = await tx.query('SELECT count(*) FROM engagement.bookings WHERE tenant_id = $1 AND account_id = $2 AND created_at >= $3', [a.tenantId, a.accountId, a.since]);
  return Number(rows[0]?.['count'] ?? 0);
}

export async function insertBooking(tx: Q, a: { tenantId: string; userId: string; accountId: string; linkId: string; bookingNo: string; patientId: string; kind: string; branchId: string; centreId: string; occupancyId: string;
  slotStart: string; slotEnd: string; homeAddressId: string | null; replacesId: string | null; now: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.bookings (id, tenant_id, booking_no, account_id, patient_id, link_id, created_via, booking_kind, branch_id, centre_id, slot_occupancy_id, slot_start, slot_end, home_address_id, status, confirmed_at, replaces_booking_id, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'app', $7, $8, $9, $10, $11, $12, $13, 'confirmed', $14, $15, 1, $16, $16) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.bookingNo, a.accountId, a.patientId, a.linkId, a.kind, a.branchId, a.centreId, a.occupancyId, a.slotStart, a.slotEnd, a.homeAddressId, a.now, a.replacesId, a.userId]);
  return rows[0]!;
}
export async function insertItem(tx: Q, a: { tenantId: string; userId: string; bookingId: string; accountId: string; centreId: string; orderableId: string; kind: string; name: string; pricePaisa: number | null; sortOrder: number }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.booking_items (id, tenant_id, booking_id, account_id, centre_id, orderable_id, orderable_kind, display_name_snapshot, indicative_price_paisa, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [uuidv7(), a.tenantId, a.bookingId, a.accountId, a.centreId, a.orderableId, a.kind, a.name, a.pricePaisa, a.sortOrder, a.userId]);
}
export async function insertTransition(tx: Q, a: { tenantId: string; userId: string; bookingId: string; accountId: string; centreId: string; from: string | null; to: string; reason: string | null; now: string }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.booking_transitions (id, tenant_id, booking_id, account_id, centre_id, from_status, to_status, reason_code, actor_type, actor_id, occurred_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'patient', $9, $10, $9)`,
    [uuidv7(), a.tenantId, a.bookingId, a.accountId, a.centreId, a.from, a.to, a.reason, a.userId, a.now]);
}

/** One of the account's OWN bookings (staff-entered, foreign and other-tenant rows are simply absent). */
export async function getMine(tx: Q, a: { tenantId: string; accountId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.bookings WHERE tenant_id = $1 AND account_id = $2 AND id = $3`, [a.tenantId, a.accountId, a.id]);
  return rows[0];
}

/** Conditional patient cancel (guards: version and status confirmed; the patient cannot cancel a checked-in booking): undefined = lost a race. */
export async function cancelMine(tx: Q, a: { tenantId: string; userId: string; accountId: string; id: string; expectedVersion: number; reason: string; now: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.bookings SET status = 'cancelled', cancelled_at = $5, cancel_reason_code = $6, cancelled_by_kind = 'patient', version = version + 1, updated_at = now(), updated_by = $7
     WHERE tenant_id = $1 AND account_id = $2 AND id = $3 AND version = $4 AND status = 'confirmed' RETURNING ${COLS}`,
    [a.tenantId, a.accountId, a.id, a.expectedVersion, a.now, a.reason, a.userId]);
  return rows[0];
}

/** Keyset page, newest slot first (slot_start DESC, id DESC): rows of the cursor's own slot_start (smaller id) first, then earlier slots. */
export async function listMine(tx: Q, a: { tenantId: string; accountId: string; status?: string; limit: number; after?: { slotStart: string; id: string } }): Promise<Row[]> {
  const run = async (extra: Array<[string, unknown]>, limit: number): Promise<Row[]> => {
    const all: Array<[string, unknown]> = [['tenant_id = ?', a.tenantId], ['account_id = ?', a.accountId], ...(a.status ? [['status = ?', a.status] as [string, unknown]] : []), ...extra];
    const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.bookings WHERE ${all.map(([t], i) => t.replace('?', `$${i + 1}`)).join(' AND ')} ORDER BY slot_start DESC, id DESC LIMIT ${limit}`, all.map(([, v]) => v));
    return rows;
  };
  if (!a.after) return run([], a.limit);
  const same = await run([['slot_start = ?', a.after.slotStart], ['id < ?', a.after.id]], a.limit);
  if (same.length >= a.limit) return same;
  return [...same, ...(await run([['slot_start < ?', a.after.slotStart]], a.limit - same.length))];
}
