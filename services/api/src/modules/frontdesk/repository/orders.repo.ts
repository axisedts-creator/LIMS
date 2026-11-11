// frontdesk.orders (05-SCHEMA §3). Explicit tenant_id filter on every statement; RLS (tenant + centre) is the backstop.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'branch_id', 'centre_id', 'patient_id', 'registration_no', 'status', 'visit_type', 'billing_mode', 'credit_party_id', 'referrer_id',
  'priority', 'collection_mode', 'source', 'source_ref_id', 'partner_id', 'age_years', 'age_months', 'age_days', 'is_first_order_of_patient',
  'catalog_revision', 'items_version', 'scheduled_at', 'registered_at', 'requires_credit_note'] as const;

export const insertOrder = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.orders', COLS, tenantId, row);
export const getOrderById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.orders', tenantId, id);

/** FD-T09: the order row locked FOR UPDATE (a racing F13/F14 on the same order waits here, then sees the moved version). */
export async function lockOrderById(tx: Tx, tenantId: string, id: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
  return rows[0] ?? null;
}

/** FD-T09 F13: items_version + 1 and version + 1 (optimistic: null when the version moved); requires_credit_note only ever goes false -> true here. */
export async function bumpOrderItemsVersion(tx: Tx, tenantId: string, id: string, expectedVersion: number, requiresCreditNote: boolean): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.orders SET items_version = items_version + 1, requires_credit_note = requires_credit_note OR $4::boolean,
      version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [tenantId, id, expectedVersion, requiresCreditNote]);
  return rows[0] ?? null;
}

/** FD-T09 F14: pre_registered | registered -> cancelled (the DB guard allows no other source status). null when the version moved. */
export async function cancelOrderRow(tx: Tx, tenantId: string, id: string, expectedVersion: number,
  c: { at: Date; by: string; reasonCode: string; reasonText?: string; requiresCreditNote: boolean }): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.orders SET status = 'cancelled', cancelled_at = $4, cancelled_by = $5, cancel_reason_code = $6, cancel_reason_text = $7,
      requires_credit_note = $8, version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [tenantId, id, expectedVersion, c.at, c.by, c.reasonCode, c.reasonText ?? null, c.requiresCreditNote]);
  return rows[0] ?? null;
}

/** FD-T12 F12: pre_registered -> registered (registered_at + catalog_revision re-stamped, as the lifecycle guard allows). null when the version or status moved. */
export async function confirmOrderRow(tx: Tx, tenantId: string, id: string, expectedVersion: number, c: { at: Date; catalogRevision: number }): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.orders SET status = 'registered', registered_at = $4, catalog_revision = $5,
      version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'pre_registered' RETURNING *`, [tenantId, id, expectedVersion, c.at, c.catalogRevision]);
  return rows[0] ?? null;
}

/** FD-T11 ageAtOrder: per patient, the age snapshot of the most recent order that carries one. */
export async function latestAgeByPatients(tx: Tx, tenantId: string, patientIds: readonly string[]): Promise<Map<string, { years: number; months: number; days: number }>> {
  const out = new Map<string, { years: number; months: number; days: number }>();
  if (patientIds.length === 0) return out;
  const { rows } = await tx.query(`SELECT DISTINCT ON (patient_id) patient_id, age_years, age_months, age_days FROM frontdesk.orders
    WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[]) AND age_years IS NOT NULL
    ORDER BY patient_id, COALESCE(registered_at, created_at) DESC, id DESC`, [tenantId, patientIds]);
  for (const r of rows) out.set(r.patient_id, { years: Number(r.age_years), months: Number(r.age_months ?? 0), days: Number(r.age_days ?? 0) });
  return out;
}

/** is_first_order_of_patient = NOT this (any status counts: a cancelled order is still a prior visit). */
/** FD-T15 F7: orders that can still change (stored pre_registered / registered; `registered` may derive to completed) and the instant of the last order.
 *  Last = COALESCE(registered_at, cancelled_at, created_at): a pre-registration cancelled before confirmation has no registered_at. */
export async function openOrdersOfPatient(tx: Tx, tenantId: string, patientId: string): Promise<any[]> {
  return (await tx.query(`SELECT id, status FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2 AND status IN ('pre_registered','registered','in_progress') ORDER BY id`, [tenantId, patientId])).rows;
}
export async function lastOrderAt(tx: Tx, tenantId: string, patientId: string): Promise<Date | null> {
  return (await tx.query(`SELECT max(COALESCE(registered_at, cancelled_at, created_at)) AS at FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2`, [tenantId, patientId])).rows[0]?.at ?? null;
}

export async function patientHasOrder(tx: Tx, tenantId: string, patientId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2 LIMIT 1', [tenantId, patientId]);
  return rows.length > 0;
}

/**
 * F6 keyset page, newest first unless asc. Sort key = COALESCE(registered_at, created_at) so pre-registered orders (NULL registered_at) page deterministically
 * [CONV]; it is returned as microsecond-exact text (`sort_key`) for the cursor. `after` = [sort_key text, id].
 */
export async function pageOrdersByPatient(tx: Tx, tenantId: string, patientId: string, o: { asc: boolean; limit: number; after?: readonly [string, string]; scopeCentreIds?: readonly string[] }): Promise<any[]> {
  const K = 'COALESCE(o.registered_at, o.created_at)';
  const cmp = o.asc ? '>' : '<';
  const dir = o.asc ? 'ASC' : 'DESC';
  const v: unknown[] = [tenantId, patientId, o.limit + 1, ...(o.after ?? [])];
  const scope = o.scopeCentreIds ? `AND o.centre_id = ANY($${v.push(o.scopeCentreIds)}::uuid[])` : '';   // as pageOrders: app-level centre scope, not only RLS
  const { rows } = await tx.query(`SELECT o.*, to_char(${K} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,
      (SELECT count(*)::int FROM frontdesk.order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id AND i.status = 'active') AS item_count,
      EXISTS (SELECT 1 FROM frontdesk.order_flags f WHERE f.tenant_id = o.tenant_id AND f.order_id = o.id AND f.status = 'open') AS has_open_flag
    FROM frontdesk.orders o WHERE o.tenant_id = $1 AND o.patient_id = $2 ${scope}
      ${o.after ? `AND (${K}, o.id) ${cmp} ($4::timestamptz, $5::uuid)` : ''}
    ORDER BY ${K} ${dir}, o.id ${dir} LIMIT $3`, v);
  return rows;
}

export interface OrderFilter {
  status?: string; centreId?: string; source?: string; hasOpenFlag?: boolean; from?: string; to?: string;
  /** Caller's centre scope: undefined = all centres; otherwise only these (fail closed on []). */
  scopeCentreIds?: readonly string[];
}

/**
 * F10 keyset page (same sort key / cursor shape as pageOrdersByPatient). Values are always bound parameters; the SQL text only ever gets fixed fragments.
 * Rows carry the patient's display name (null for anonymised patients), the active item_count and has_open_flag.
 */
export async function pageOrders(tx: Tx, tenantId: string, f: OrderFilter, o: { asc: boolean; limit: number; after?: readonly [string, string] }): Promise<any[]> {
  const K = 'COALESCE(o.registered_at, o.created_at)';
  const FLAG = `EXISTS (SELECT 1 FROM frontdesk.order_flags f WHERE f.tenant_id = o.tenant_id AND f.order_id = o.id AND f.status = 'open')`;
  const v: unknown[] = [tenantId, o.limit + 1];
  const p = (x: unknown): string => `$${v.push(x)}`;
  const w = ['o.tenant_id = $1'];
  if (f.scopeCentreIds) w.push(`o.centre_id = ANY(${p(f.scopeCentreIds)}::uuid[])`);
  if (f.status) w.push(`o.status = ${p(f.status)}`);
  if (f.centreId) w.push(`o.centre_id = ${p(f.centreId)}::uuid`);
  if (f.source) w.push(`o.source = ${p(f.source)}`);
  if (f.from) w.push(`o.registered_at >= ${p(f.from)}::timestamptz`);
  if (f.to) w.push(`o.registered_at <= ${p(f.to)}::timestamptz`);
  if (f.hasOpenFlag !== undefined) w.push(`${FLAG} = ${p(f.hasOpenFlag)}::boolean`);
  if (o.after) w.push(`(${K}, o.id) ${o.asc ? '>' : '<'} (${p(o.after[0])}::timestamptz, ${p(o.after[1])}::uuid)`);
  const dir = o.asc ? 'ASC' : 'DESC';
  const { rows } = await tx.query(`SELECT o.*, CASE WHEN p.anonymised_at IS NULL THEN p.full_name ELSE '' END AS patient_display,
      to_char(${K} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,
      (SELECT count(*)::int FROM frontdesk.order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id AND i.status = 'active') AS item_count,
      ${FLAG} AS has_open_flag
    FROM frontdesk.orders o JOIN frontdesk.patients p ON p.tenant_id = o.tenant_id AND p.id = o.patient_id
    WHERE ${w.join(' AND ')}
    ORDER BY ${K} ${dir}, o.id ${dir} LIMIT $2`, v);
  return rows;
}

export async function listOrdersByPatient(tx: Tx, tenantId: string, patientId: string, limit = 100): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2
    ORDER BY registered_at DESC NULLS FIRST, id LIMIT $3`, [tenantId, patientId, limit]);
  return rows;
}
