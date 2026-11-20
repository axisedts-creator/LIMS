// T0B-REGAPI-2 (LD-310, LD-315): the six tables of migration 20261117110000 (registration_drafts, favourite_tests, coupons, icd_codes, custom_field_definitions,
// reward_points_ledger) + the order-side coupon / points / claim statements. Explicit tenant_id on every statement; RLS is the backstop. Values are always parameters.
// LD-315 (b): DELETE only on registration_drafts / favourite_tests (owner-bound policy); the points ledger is append only; masters are deactivated, never deleted.
import { insertRow, type Tx } from './shared.repo.js';

type Row = Record<string, any>;
const STAMP = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key`;

// ---------------------------------------------------------------- registration drafts (DB clock: expires_at = updated_at + 14 days)
/** Serialises saves of one (tenant, user, centre): create-or-replace has no unique key in the table (LD-310), so concurrent saves wait here. */
export async function lockDraftKey(tx: Tx, tenantId: string, userId: string, centreId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`frontdesk.registration_drafts:${tenantId}:${userId}:${centreId}`]);
}
export async function purgeExpiredDrafts(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx.query('DELETE FROM frontdesk.registration_drafts WHERE tenant_id = $1 AND user_id = $2 AND expires_at <= now()', [tenantId, userId]);
}
export async function replaceDraft(tx: Tx, tenantId: string, userId: string, centreId: string, payload: unknown): Promise<Row | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.registration_drafts SET payload = $4::jsonb, updated_at = now(), expires_at = now() + interval '14 days', version = version + 1,
      updated_by = (SELECT app.current_actor_id())
    WHERE id = (SELECT id FROM frontdesk.registration_drafts WHERE tenant_id = $1 AND user_id = $2 AND centre_id = $3 AND expires_at > now() ORDER BY updated_at DESC, id DESC LIMIT 1)
      AND tenant_id = $1 RETURNING *`, [tenantId, userId, centreId, JSON.stringify(payload)]);
  return rows[0] ?? null;
}
export async function insertDraft(tx: Tx, tenantId: string, row: { id: string; user_id: string; centre_id: string; payload: unknown }): Promise<Row> {
  const { rows } = await tx.query(`INSERT INTO frontdesk.registration_drafts (id, tenant_id, user_id, centre_id, payload, updated_at, expires_at, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, now(), now() + interval '14 days', (SELECT app.current_actor_id()), (SELECT app.current_actor_id())) RETURNING *`,
  [row.id, tenantId, row.user_id, row.centre_id, JSON.stringify(row.payload)]);
  return rows[0];
}
export async function getLiveDraft(tx: Tx, tenantId: string, userId: string, id: string): Promise<Row | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.registration_drafts WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND expires_at > now()', [tenantId, userId, id]);
  return rows[0] ?? null;
}
export async function deleteLiveDraft(tx: Tx, tenantId: string, userId: string, id: string): Promise<number> {
  const r = await tx.query('DELETE FROM frontdesk.registration_drafts WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND expires_at > now()', [tenantId, userId, id]);
  return r.rowCount ?? 0;
}
/** Newest first by (updated_at, id); `after` = [sort_key, id]. Summaries only (no payload). */
export async function pageDrafts(tx: Tx, tenantId: string, userId: string, o: { centreId?: string; limit: number; after?: readonly [string, string] }): Promise<Row[]> {
  const v: unknown[] = [tenantId, userId, o.limit + 1];
  const w = ['tenant_id = $1', 'user_id = $2', 'expires_at > now()'];
  if (o.centreId) w.push(`centre_id = $${v.push(o.centreId)}::uuid`);
  if (o.after) w.push(`(updated_at, id) < ($${v.push(o.after[0])}::timestamptz, $${v.push(o.after[1])}::uuid)`);
  const { rows } = await tx.query(`SELECT id, centre_id, created_at, updated_at, expires_at, ${STAMP('updated_at')} FROM frontdesk.registration_drafts
    WHERE ${w.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT $3`, v);
  return rows;
}

// ---------------------------------------------------------------- favourite tests
/** Idempotent add: the unique (tenant, user, orderable) decides; `created` = this call inserted the row. */
export async function addFavourite(tx: Tx, tenantId: string, row: { id: string; user_id: string; orderable_id: string }): Promise<{ row: Row; created: boolean }> {
  const ins = await tx.query(`INSERT INTO frontdesk.favourite_tests (id, tenant_id, user_id, orderable_id, created_by, updated_by)
    VALUES ($1, $2, $3, $4, (SELECT app.current_actor_id()), (SELECT app.current_actor_id())) ON CONFLICT (tenant_id, user_id, orderable_id) DO NOTHING RETURNING *`,
  [row.id, tenantId, row.user_id, row.orderable_id]);
  if (ins.rows[0]) return { row: ins.rows[0], created: true };
  const { rows } = await tx.query('SELECT * FROM frontdesk.favourite_tests WHERE tenant_id = $1 AND user_id = $2 AND orderable_id = $3', [tenantId, row.user_id, row.orderable_id]);
  return { row: rows[0], created: false };
}
export async function removeFavourite(tx: Tx, tenantId: string, userId: string, orderableId: string): Promise<number> {
  const r = await tx.query('DELETE FROM frontdesk.favourite_tests WHERE tenant_id = $1 AND user_id = $2 AND orderable_id = $3', [tenantId, userId, orderableId]);
  return r.rowCount ?? 0;
}
export async function pageFavourites(tx: Tx, tenantId: string, userId: string, o: { limit: number; after?: readonly [string, string] }): Promise<Row[]> {
  const v: unknown[] = [tenantId, userId, o.limit + 1];
  const after = o.after ? `AND (created_at, id) < ($${v.push(o.after[0])}::timestamptz, $${v.push(o.after[1])}::uuid)` : '';
  const { rows } = await tx.query(`SELECT id, orderable_id, created_at, ${STAMP('created_at')} FROM frontdesk.favourite_tests
    WHERE tenant_id = $1 AND user_id = $2 AND is_active ${after} ORDER BY created_at DESC, id DESC LIMIT $3`, v);
  return rows;
}

// ---------------------------------------------------------------- masters (coupons, icd_codes, custom_field_definitions)
export type Master = 'coupons' | 'icd_codes' | 'custom_field_definitions';
const MASTER_COLS: Record<Master, readonly string[]> = {
  coupons: ['id', 'code', 'amount_paisa', 'percent', 'valid_from', 'valid_to', 'usage_limit', 'is_active'],
  icd_codes: ['id', 'code', 'description', 'is_active'],
  custom_field_definitions: ['id', 'field_key', 'label', 'field_type', 'required', 'choices', 'sort_order', 'is_active'],
};
const MASTER_SET: Record<Master, readonly string[]> = {
  coupons: ['valid_from', 'valid_to', 'usage_limit', 'is_active'], icd_codes: ['description', 'is_active'],
  custom_field_definitions: ['label', 'required', 'choices', 'sort_order', 'is_active'],
};
export const insertMaster = (tx: Tx, t: Master, tenantId: string, row: Row) =>
  insertRow(tx, `frontdesk.${t}`, MASTER_COLS[t], tenantId, row, t === 'custom_field_definitions' ? { jsonCols: ['choices'] } : {});
export async function lockMaster(tx: Tx, t: Master, tenantId: string, id: string): Promise<Row | null> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.${t} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id]);
  return rows[0] ?? null;
}
/** Optimistic PATCH: version + 1 where the version still matches (null when it moved). Only the allowlisted columns of `t` are written. */
export async function updateMaster(tx: Tx, t: Master, tenantId: string, id: string, version: number, set: Row): Promise<Row | null> {
  const cols = MASTER_SET[t].filter((c) => set[c] !== undefined);
  const v: unknown[] = [tenantId, id, version, ...cols.map((c) => (c === 'choices' ? JSON.stringify(set[c]) : set[c]))];
  const sets = cols.map((c, i) => `${c} = $${i + 4}${c === 'choices' ? '::jsonb' : ''}`);
  const { rows } = await tx.query(`UPDATE frontdesk.${t} SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = (SELECT app.current_actor_id())'].join(', ')}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, v);
  return rows[0] ?? null;
}
/** Keyset pages in key order: coupons / icd_codes by code, custom fields by (sort_order, field_key). `after` = the last key(s). */
export async function pageMaster(tx: Tx, t: Master, tenantId: string, o: { limit: number; isActive?: boolean; q?: string; after?: readonly (string | number)[] }): Promise<Row[]> {
  const v: unknown[] = [tenantId, o.limit + 1];
  const w = ['tenant_id = $1'];
  if (o.isActive !== undefined) w.push(`is_active = $${v.push(o.isActive)}`);
  if (o.q !== undefined) {   // ICD: prefix of the code or words of the description (LIKE wildcards escaped)
    const esc = o.q.replace(/[\\%_]/g, (m) => `\\${m}`);
    w.push(`(code LIKE $${v.push(`${esc.toUpperCase()}%`)} OR description ILIKE $${v.push(`%${esc}%`)})`);
  }
  const fields = t === 'custom_field_definitions';
  if (o.after) w.push(fields ? `(sort_order, field_key) > ($${v.push(o.after[0])}::int, $${v.push(o.after[1])})` : `code > $${v.push(o.after[0])}`);
  const { rows } = await tx.query(`SELECT * FROM frontdesk.${t} WHERE ${w.join(' AND ')} ORDER BY ${fields ? 'sort_order, field_key' : 'code'} LIMIT $2`, v);
  return rows;
}
export async function activeFieldDefinitions(tx: Tx, tenantId: string): Promise<Row[]> {
  return (await tx.query('SELECT field_key, field_type, required, choices FROM frontdesk.custom_field_definitions WHERE tenant_id = $1 AND is_active', [tenantId])).rows;
}
export async function activeIcdCodes(tx: Tx, tenantId: string, codes: readonly string[]): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  const { rows } = await tx.query('SELECT code FROM frontdesk.icd_codes WHERE tenant_id = $1 AND is_active AND code = ANY($2::text[])', [tenantId, codes]);
  return new Set(rows.map((r) => r.code as string));
}

// ---------------------------------------------------------------- coupons at registration / cancel
export async function getCouponByCode(tx: Tx, tenantId: string, code: string): Promise<Row | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.coupons WHERE tenant_id = $1 AND code = $2', [tenantId, code]);
  return rows[0] ?? null;
}
/** One use, atomically: the row lock serialises racing saves and the WHERE re-checks validity + the limit, so used_count never passes usage_limit. null = not usable. */
export async function useCoupon(tx: Tx, tenantId: string, code: string, today: string): Promise<Row | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.coupons SET used_count = used_count + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND code = $2 AND is_active AND (valid_from IS NULL OR valid_from <= $3::date) AND (valid_to IS NULL OR valid_to >= $3::date)
      AND (usage_limit IS NULL OR used_count < usage_limit) RETURNING *`, [tenantId, code, today]);
  return rows[0] ?? null;
}
export async function releaseCoupon(tx: Tx, tenantId: string, code: string): Promise<void> {
  await tx.query(`UPDATE frontdesk.coupons SET used_count = used_count - 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND code = $2 AND used_count > 0`, [tenantId, code]);
}

// ---------------------------------------------------------------- reward points (append only)
/** Serialises redemptions of one patient (the ledger has no row to lock): a racing save waits, then sees the committed redemption. */
export async function lockPatientPoints(tx: Tx, tenantId: string, patientId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`frontdesk.reward_points_ledger:${tenantId}:${patientId}`]);
}
export async function pointTotals(tx: Tx, tenantId: string, patientId: string): Promise<{ earned: number; redeemed: number }> {
  const { rows } = await tx.query(`SELECT COALESCE(SUM(points) FILTER (WHERE entry_kind = 'earned'), 0)::bigint AS earned, COALESCE(SUM(points) FILTER (WHERE entry_kind = 'redeemed'), 0)::bigint AS redeemed
    FROM frontdesk.reward_points_ledger WHERE tenant_id = $1 AND patient_id = $2`, [tenantId, patientId]);
  return { earned: Number(rows[0].earned), redeemed: Number(rows[0].redeemed) };
}
export async function orderPoints(tx: Tx, tenantId: string, orderId: string): Promise<{ earned: number; redeemed: number }> {
  const { rows } = await tx.query(`SELECT COALESCE(SUM(points) FILTER (WHERE entry_kind = 'earned'), 0)::bigint AS earned, COALESCE(SUM(points) FILTER (WHERE entry_kind = 'redeemed'), 0)::bigint AS redeemed
    FROM frontdesk.reward_points_ledger WHERE tenant_id = $1 AND order_id = $2`, [tenantId, orderId]);
  return { earned: Number(rows[0].earned), redeemed: Number(rows[0].redeemed) };
}
export const insertPoints = (tx: Tx, tenantId: string, row: { id: string; patient_id: string; order_id: string; entry_kind: 'earned' | 'redeemed'; points: number }) =>
  insertRow(tx, 'frontdesk.reward_points_ledger', ['id', 'patient_id', 'order_id', 'entry_kind', 'points'], tenantId, row, { actorCols: ['created_by'] });
export async function pagePoints(tx: Tx, tenantId: string, patientId: string, o: { limit: number; after?: readonly [string, string] }): Promise<Row[]> {
  const v: unknown[] = [tenantId, patientId, o.limit + 1];
  const after = o.after ? `AND (created_at, id) < ($${v.push(o.after[0])}::timestamptz, $${v.push(o.after[1])}::uuid)` : '';
  const { rows } = await tx.query(`SELECT id, entry_kind, points, order_id, created_at, ${STAMP('created_at')} FROM frontdesk.reward_points_ledger
    WHERE tenant_id = $1 AND patient_id = $2 ${after} ORDER BY created_at DESC, id DESC LIMIT $3`, v);
  return rows;
}

// ---------------------------------------------------------------- number preview (a READ of the counter; the save still takes the value under its row lock)
export async function readCounter(tx: Tx, tenantId: string, kind: string, scopeKey: string): Promise<number> {
  const { rows } = await tx.query('SELECT last_value FROM frontdesk.number_counters WHERE tenant_id = $1 AND counter_kind = $2 AND scope_key = $3', [tenantId, kind, scopeKey]);
  return rows[0] ? Number(rows[0].last_value) : 0;
}
