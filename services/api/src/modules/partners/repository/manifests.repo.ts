// C13 T08 — partners.manifests (05-SCHEMA §3.6). Every statement is bound by (tenant_id, partner_id) from partnerContext, never from the request
// (REQ-SEC-024); RLS is the second wall. Values are bound parameters only; no request value is part of SQL text.
import type { Q, Scope } from './counters.repo.js';

type Row = Record<string, any>;
const WHERE = 'tenant_id = $1 AND partner_id = $2';

/** receiving branch/centre/mode snapshot source (03-APP-FLOW §4.1 M1 step 3). */
export async function partnerSnapshot(s: Scope): Promise<Row | undefined> {
  const { rows } = await s.tx.query('SELECT receiving_branch_id, receiving_centre_id, conversion_mode FROM partners.partners WHERE tenant_id = $1 AND id = $2', [s.tenantId, s.partnerId]);
  return rows[0];
}

export async function insert(s: Scope, v: { id: string; manifestNo: string; branchId: string; centreId: string; mode: string; notes: string | null; collectedOn: string | null }): Promise<Row> {
  const { rows } = await s.tx.query(
    'INSERT INTO partners.manifests (id, tenant_id, partner_id, manifest_no, receiving_branch_id, receiving_centre_id, conversion_mode, notes, collected_on, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $10) RETURNING *',
    [v.id, s.tenantId, s.partnerId, v.manifestNo, v.branchId, v.centreId, v.mode, v.notes, v.collectedOn, s.actorId]);
  return rows[0]!;
}

export async function get(s: Scope, id: string): Promise<Row | undefined> {
  const { rows } = await s.tx.query(`SELECT * FROM partners.manifests WHERE ${WHERE} AND id = $3`, [s.tenantId, s.partnerId, id]);
  return rows[0];
}

/** Row lock for the rest of the transaction: a second writer with the same If-Match waits, then reads the bumped version and gets 409. */
export async function lock(s: Scope, id: string): Promise<Row | undefined> {
  const { rows } = await s.tx.query(`SELECT * FROM partners.manifests WHERE ${WHERE} AND id = $3 FOR UPDATE`, [s.tenantId, s.partnerId, id]);
  return rows[0];
}

export interface ListFilter { states?: string[]; from?: string; to?: string; sort: 'created_at' | 'submitted_at'; cursor?: { key: string; id: string }; limit: number }
export async function list(s: Scope, f: ListFilter): Promise<Row[]> {
  const vals: unknown[] = [s.tenantId, s.partnerId];
  const add = (v: unknown): string => { vals.push(v); return `$${vals.length}`; };
  const where = [WHERE];
  if (f.states) where.push(`state = ANY(${add(f.states)}::text[])`);
  if (f.from) where.push(`created_at >= ${add(f.from)}::timestamptz`);
  if (f.to) where.push(`created_at <= ${add(f.to)}::timestamptz`);
  if (f.sort === 'submitted_at') where.push('submitted_at IS NOT NULL'); // ponytail: drafts have no submitted_at; they are left out of this sort, not ranked last
  if (f.cursor) where.push(`(${f.sort}, id) < (${add(f.cursor.key)}::timestamptz, ${add(f.cursor.id)}::uuid)`);
  const key = "to_char(%c AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
  const { rows } = await s.tx.query(
    `SELECT *, ${key.replace('%c', 'created_at')} AS created_key, ${key.replace('%c', 'submitted_at')} AS submitted_key FROM partners.manifests WHERE ${where.join(' AND ')} ORDER BY ${f.sort} DESC, id DESC LIMIT ${add(f.limit + 1)}`, vals);
  return rows;
}

/** UPDATE ... WHERE version = $n (+ state guard); 0 rows = someone else changed it first. `sets` use $5.. for their own values (vals[0..4] = tenant, partner, id, version, actor). */
export async function change(s: Scope, id: string, version: number, sets: string[], extra: unknown[] = []): Promise<Row | undefined> {
  const { rows } = await s.tx.query(
    `UPDATE partners.manifests SET ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = $5 WHERE ${WHERE} AND id = $3 AND version = $4 AND state = 'draft' RETURNING *`,
    [s.tenantId, s.partnerId, id, version, s.actorId, ...extra]);
  return rows[0];
}

/** M8 / MS3: draft -> submitted, snapshot refreshed from the partner. Version + state guarded; 0 rows = lost the race. */
export async function submit(s: Scope, id: string, version: number, snap: { branchId: string; centreId: string; mode: string }): Promise<Row | undefined> {
  const { rows } = await s.tx.query(
    "UPDATE partners.manifests SET state = 'submitted', submitted_at = now(), submitted_by = $5, receiving_branch_id = $6, receiving_centre_id = $7, conversion_mode = $8, version = version + 1, updated_at = now(), updated_by = $5 "
    + `WHERE ${WHERE} AND id = $3 AND version = $4 AND state = 'draft' RETURNING *`,
    [s.tenantId, s.partnerId, id, version, s.actorId, snap.branchId, snap.centreId, snap.mode]);
  return rows[0];
}

/** M9 / MS5: submitted -> withdrawn. */
export async function withdraw(s: Scope, id: string, version: number, code: string, text: string | null): Promise<Row | undefined> {
  const { rows } = await s.tx.query(
    "UPDATE partners.manifests SET state = 'withdrawn', withdrawn_at = now(), withdrawn_by = $5, withdraw_reason_code = $6, withdraw_reason_text = $7, version = version + 1, updated_at = now(), updated_by = $5 "
    + `WHERE ${WHERE} AND id = $3 AND version = $4 AND state = 'submitted' RETURNING *`,
    [s.tenantId, s.partnerId, id, version, s.actorId, code, text]);
  return rows[0];
}

export async function partnerHeader(s: Scope): Promise<Row | undefined> {
  return (await s.tx.query('SELECT name, partner_code FROM partners.partners WHERE tenant_id = $1 AND id = $2', [s.tenantId, s.partnerId])).rows[0];
}

/** partners.g_cs_reasons row (global coded set, 05-SCHEMA §7) for one code of one set. */
export async function reason(s: Scope, setName: string, code: string): Promise<Row | undefined> {
  return (await s.tx.query('SELECT code, requires_text, is_active FROM partners.g_cs_reasons WHERE set_name = $1 AND code = $2', [setName, code])).rows.find((r: Row) => r['code'] === code);
}

/** Converted / failed line counts of non-draft manifests (drafts hold none). */
export async function lineCounts(s: Scope, ids: string[]): Promise<Map<string, { converted: number; failed: number }>> {
  const out = new Map<string, { converted: number; failed: number }>();
  if (ids.length === 0) return out;
  const { rows } = await s.tx.query(`SELECT manifest_id, state FROM partners.manifest_lines WHERE ${WHERE} AND manifest_id = ANY($3::uuid[])`, [s.tenantId, s.partnerId, ids]);
  for (const r of rows) {
    const c = out.get(r['manifest_id']) ?? { converted: 0, failed: 0 };
    if (r['state'] === 'converted') c.converted++;
    else if (r['state'] === 'conversion_failed') c.failed++;
    out.set(r['manifest_id'], c);
  }
  return out;
}

export type { Q, Scope };
