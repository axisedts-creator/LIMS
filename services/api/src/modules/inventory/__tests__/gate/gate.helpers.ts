// C12.T-26 chunk-gate helpers (not a test file). Synthetic data only.
// LEAD DECISIONS: LD-140 (UI only) does not apply to this backend/test task.
// What this gate proves (PRD AC-22.1 / AC-22.2 / AC-22.3, 07-SECURITY §6.1 / §6.2 / §8, 02-TRD §12):
//   * the operation list is READ FROM contracts/openapi/inventory.yaml (93 operations, TRD numbering = document order, #1 listInventoryItems ... #93 exportInventoryReport); requests are built from the
//     contract's own `examples.synthetic.value` (or synthesised from the schema) and every `*_id` field / path parameter is then replaced by the id of a REAL tenant-B row (seeded below).
//   * a tenant-A user (all permissions, aal2, all branches) calling any operation with those ids must get `404 common.not_found`, no tenant-B data in the body and no change in tenant B (P-T1 / P-T3).
// SEAMS (the spec leaves them open; the writer may dispute through the reviewer): same call convention as every earlier inventory test (`handlers[operationId](req, ctx)`, makeRepCtx ctx stub from
//   handlers/__tests__/reports.helpers.ts); a refusal is a thrown LimsError. The DB role is `lims_api` (07-SECURITY writes `lims_app`; the migrated roles are lims_api / lims_worker).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { A, B, BR1, BR2, BR_B, SYS, call, uid } from '../../handlers/__tests__/masters.helpers.js';
import { COST, makeRepCtx, NOW, type RepOpts } from '../../handlers/__tests__/reports.helpers.js';

export { A, B, BR1, BR2, BR_B, SYS, call, uid, LimsError, NOW };
export const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
export const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
export const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
export const live = Boolean(API_URL && ADMIN_URL);
export const FIXTURES = `${ROOT}tests/db/c12-t03/fixtures.sql`;
export const claims = (tenant: string, actor = 'system') => JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: actor });

// ------------------------------------------------------------------------------------------------------------------------------------------------ the contract
export interface Operation {
  n: number; op: string; method: string; path: string; permission: string | null; params: any[]; body: any | null; privileged: boolean;
}
const read = (f: string) => parse(readFileSync(`${ROOT}contracts/openapi/${f}`, 'utf8')) as any;
const DOC = read('inventory.yaml');
const COMMON = read('_common.yaml');
function deref(node: any, home: any = DOC): any {
  if (!node || typeof node !== 'object' || !node.$ref) return node;
  const [file, ptr] = String(node.$ref).split('#');
  const root = file === '_common.yaml' ? COMMON : DOC;
  const target = ptr!.split('/').slice(1).reduce((o: any, k: string) => o?.[k], root);
  return deref(target, root === home ? home : root);
}
export const OPERATIONS: Operation[] = [];
for (const [path, item] of Object.entries<any>(DOC.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const o = item[method];
    if (!o) continue;
    const media = o.requestBody ? deref(o.requestBody).content?.['application/json'] ?? null : null;
    OPERATIONS.push({ n: OPERATIONS.length + 1, op: o.operationId, method: method.toUpperCase(), path, permission: o['x-permission'] ?? null,
      params: [...(item.parameters ?? []), ...(o.parameters ?? [])].map((p: any) => deref(p)), body: media, privileged: (o['x-error-codes'] ?? []).includes('auth.mfa_required') });
  }
}
export const ALL_PERMISSIONS = [...new Set([...OPERATIONS.map((o) => o.permission).filter((p): p is string => Boolean(p)), COST, 'inventory.item.read'])];

// ------------------------------------------------------------------------------------------------------------------------------------------------ id mapping
/** request field / path parameter name -> table whose tenant-B row supplies the id. */
export function tableOfField(name: string): string | null {
  const m: [RegExp, string][] = [[/(^|_)store_id$/, 'inventory.stores'], [/(^|_)item_id$/, 'inventory.items'], [/^pack_id$/, 'inventory.item_packs'], [/^barcode_id$/, 'inventory.item_barcodes'],
    [/supplier_id$/, 'inventory.suppliers'], [/^instrument_id$/, 'instruments.instruments'], [/^lot_id$/, 'inventory.lots'], [/^container_id$/, 'inventory.opened_containers'],
    [/^document_id$/, 'inventory.stock_documents'], [/^grn_id$/, 'inventory.goods_receipts'], [/^transfer_id$/, 'inventory.transfers'], [/^count_id$/, 'inventory.stock_counts'],
    [/^rule_id$/, 'inventory.consumption_rules'], [/^fact_id$/, 'inventory.consumption_facts'], [/^po_id$/, 'inventory.purchase_orders'], [/^alert_id$/, 'inventory.alerts'],
    [/^test_id$/, 'catalog.tests'], [/^branch_id$/, 'core.branches']];
  return m.find(([re]) => re.test(name))?.[1] ?? null;
}
/** ids of the tenant-B rows (one per table), filled by seedTenantB. */
export const B_IDS = new Map<string, string>();
export const bId = (table: string): string => B_IDS.get(table) ?? randomUUID();

// ------------------------------------------------------------------------------------------------------------------------------------------------ request builder
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function synth(schema: any, depth = 0): unknown {
  const s = deref(schema);
  if (!s) return null;
  if (s.example !== undefined) return clone(s.example);
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: any) => synth(x, depth)));
  if (s.oneOf || s.anyOf) return synth((s.oneOf ?? s.anyOf)[0], depth);
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'object': { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries<any>(s.properties ?? {})) if ((s.required ?? []).includes(k)) o[k] = synth(v, depth + 1); return o; }
    case 'array': return depth > 4 ? [] : [synth(s.items, depth + 1)];
    case 'integer': return s.minimum ?? 1;
    case 'number': return s.minimum ?? 1;
    case 'boolean': return false;
    default: {
      if (s.format === 'uuid' || /uuid/i.test(String(s.description ?? ''))) return randomUUID();
      if (s.format === 'date') return '2026-06-15';
      if (s.format === 'date-time') return NOW;
      return 'x'.repeat(Math.max(1, s.minLength ?? 1));
    }
  }
}
/** Replaces every `*_id` string (and `*_ids` array) with the id of tenant B's row; returns how many ids were replaced and the (B,A) id pairs for bulk mixing. */
export function swapIds(v: unknown, who: 'B' | 'A', aIds: Map<string, string>, stats = { n: 0 }): unknown {
  const pick = (k: string) => { const t = tableOfField(k); if (!t) return null; stats.n++; return who === 'B' ? bId(t) : (aIds.get(t) ?? randomUUID()); };
  if (Array.isArray(v)) return v.map((x) => swapIds(x, who, aIds, stats));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /_id$/.test(k)) o[k] = pick(k) ?? x;
      else if (Array.isArray(x) && /_ids$/.test(k)) o[k] = x.map(() => pick(k.replace(/_ids$/, '_id')) ?? randomUUID());
      else o[k] = swapIds(x, who, aIds, stats);
    }
    return o;
  }
  return v;
}
export interface BuiltRequest { req: { params: Record<string, unknown>; query: Record<string, unknown>; headers: Record<string, string>; body?: unknown }; bIds: number; queryIds: number }
/** The request of `o` with tenant-B ids (who='B') or tenant-A ids (who='A'). */
export function buildRequest(o: Operation, who: 'B' | 'A', aIds: Map<string, string> = new Map()): BuiltRequest {
  const stats = { n: 0 }; let queryIds = 0; // n = ids in path / body (must 404); queryIds = list filters (404 or an empty page, both leak nothing)
  const params: Record<string, unknown> = {}; const query: Record<string, unknown> = {}; const headers: Record<string, string> = {};
  for (const p of o.params) {
    const name = String(p.name);
    if (p.in === 'header') { if (/^if-match$/i.test(name) && p.required) headers['if-match'] = '"1"'; else if (/^idempotency-key$/i.test(name) && p.required) headers['idempotency-key'] = randomUUID(); continue; }
    if (p.in === 'query' && !p.required && !/(_id|_ids)$/.test(name)) continue;
    let val: unknown = p.example ?? synth(p.schema);
    const t = tableOfField(name);
    if (t && (p.in === 'path' || p.in === 'query')) { val = who === 'B' ? bId(t) : (aIds.get(t) ?? randomUUID()); if (p.in === 'path') stats.n++; else queryIds++; }
    (p.in === 'path' ? params : query)[name] = val;
  }
  if (o.op === 'lookupInventoryBarcode') { query['code'] = who === 'B' ? B_BARCODE : 'T26-NOT-A-BARCODE'; if (who === 'B') stats.n++; }
  let body: unknown;
  if (o.body) {
    const ex = o.body.examples ? Object.values<any>(o.body.examples)[0]?.value : o.body.example;
    body = swapIds(ex !== undefined ? clone(ex) : synth(o.body.schema), who, aIds, stats);
  }
  return { req: { params, query, headers, ...(body !== undefined ? { body } : {}) }, bIds: stats.n, queryIds };
}
export const B_BARCODE = 'T26-B-BARCODE-0001';

// ------------------------------------------------------------------------------------------------------------------------------------------------ sessions (one request-shaped transaction, ROLLED BACK)
export interface Sess {
  client: pg.PoolClient;
  /** runs the handler inside a SAVEPOINT as tenant `t`; rethrows after rolling the savepoint back */
  go(op: string, req: Record<string, unknown>, o?: RepOpts, t?: string): Promise<{ status: number; body: any; headers?: Record<string, string> }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
}
export function sessionOn(client: pg.PoolClient): Sess {
  let k = 0;
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  return {
    client,
    async go(op, req, o = {}, t = A) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makeRepCtx(tx, t, { permissions: ALL_PERMISSIONS, all: true, ...o });
      const sp = `t26_h${++k}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, st.ctx, req); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
  };
}
export async function withSession<T>(pool: pg.Pool, fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); return await fn(sessionOn(client)); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------ superuser seeding (T-19 pattern: replica role, jsonb_populate_recordset)
const colCache = new Map<string, { column_name: string; data_type: string }[]>();
const chkCache = new Map<string, Record<string, string>>();
async function required(c: pg.PoolClient, table: string) {
  if (!colCache.has(table)) {
    const [schema, name] = table.split('.');
    colCache.set(table, (await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND is_nullable = 'NO' AND column_default IS NULL
      AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows);
  }
  return colCache.get(table)!;
}
/** first allowed literal of every `col IN (...)` CHECK of `table` (pg renders it as `col = ANY (ARRAY['a'::text, ...])`) */
async function allowed(c: pg.PoolClient, table: string): Promise<Record<string, string>> {
  if (!chkCache.has(table)) {
    const out: Record<string, string> = {};
    const defs = (await c.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [table])).rows;
    for (const { d } of defs) for (const m of String(d).matchAll(/\(?\(?(\w+)\)?(?:::\w+(?: \w+)*)? = ANY \(\(?ARRAY\['([^']*)'/g)) out[m[1]!] ??= m[2]!;
    chkCache.set(table, out);
  }
  return chkCache.get(table)!;
}
let seq = 0;
async function dummy(c: pg.PoolClient, table: string, type: string, col: string): Promise<unknown> {
  const ok = (await allowed(c, table))[col];
  if (ok !== undefined) return ok;
  switch (type) {
    case 'uuid': return /(^|_)by$/.test(col) ? SYS : randomUUID();
    case 'text': case 'character varying': return /barcode/.test(col) ? `T26-DUMMY-${++seq}` : /code|_no$/.test(col) ? `T26-${++seq}` : `t26 ${col}`;
    case 'integer': case 'smallint': case 'bigint': case 'numeric': return 1;
    case 'boolean': return false;
    case 'timestamp with time zone': return NOW;
    case 'date': return '2026-01-01';
    case 'jsonb': return {};
    case 'ARRAY': return '{}';
    case 'bytea': return '\\x01';
    default: throw new Error(`t26 fixture: no dummy for ${type} (${table}.${col})`);
  }
}
/** Inserts `rows` (omitted NOT NULL columns without default get dummies; CHECK/FK/triggers are NOT enforced for FKs/triggers: replica) ; returns an error text or null. */
export async function put(c: pg.PoolClient, table: string, rows: Record<string, unknown>[]): Promise<string | null> {
  await c.query('SAVEPOINT t26_put');
  try {
    const req = await required(c, table);
    const base = Object.fromEntries(await Promise.all(req.map(async (k) => [k.column_name, await dummy(c, table, k.data_type, k.column_name)] as const)));
    const full = rows.map((r) => ({ ...base, ...r }));
    const cols = [...new Set(full.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < full.length; i += 250) {
      const batch = full.slice(i, i + 250).map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]])));
      const list = cols.map((k) => `"${k}"`).join(',');
      await c.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(batch)]);
    }
    await c.query('RELEASE SAVEPOINT t26_put');
    return null;
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT t26_put'); return `${table}: ${(e as Error).message}`; }
}

/** One synthetic row per id-bearing table in tenant B (+ the tenant-A rows' ids for bulk mixing). Returns the tables that could not be seeded. */
export async function seedTenantB(admin: pg.Pool): Promise<string[]> {
  const c = await admin.connect();
  const failed: string[] = [];
  const tb = { tenant_id: B };
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims(B)]);
    const id = (table: string) => { const v = uid(26000 + B_IDS.size + 1); B_IDS.set(table, v); return v; };
    const testId = id('catalog.tests');
    const rows: [string, Record<string, unknown>][] = [
      ['inventory.stores', { id: id('inventory.stores'), ...tb, branch_id: BR_B, store_code: 'T26-BS1', name: 'T26 store B', store_kind: 'bench', is_default_consumption: false, is_active: true }],
      ['inventory.items', { id: id('inventory.items'), ...tb, item_code: 'T26-BI1', name: 'T26 item B', category: 'reagent', base_uom_code: 'piece', is_lot_tracked: false, requires_expiry: false, is_active: true }],
      ['inventory.item_packs', { id: id('inventory.item_packs'), ...tb, item_id: bId('inventory.items'), pack_code: 'T26PACK', label: 'T26 pack B', uom_code: 'piece', qty_in_base: 1, is_active: true }],
      ['inventory.item_barcodes', { id: id('inventory.item_barcodes'), ...tb, item_id: bId('inventory.items'), barcode_value: B_BARCODE, is_active: true }],
      ['inventory.suppliers', { id: id('inventory.suppliers'), ...tb, supplier_code: 'T26-BSUP', name: 'T26 supplier B', is_active: true }],
      ['inventory.lots', { id: id('inventory.lots'), ...tb, item_id: bId('inventory.items'), lot_no: 'T26-BLOT', expiry_on: '2027-01-01', status: 'available' }],
      ['inventory.opened_containers', { id: id('inventory.opened_containers'), ...tb, store_id: bId('inventory.stores'), item_id: bId('inventory.items'), status: 'open' }],
      ['inventory.stock_documents', { id: id('inventory.stock_documents'), ...tb, store_id: bId('inventory.stores') }],
      ['inventory.goods_receipts', { id: id('inventory.goods_receipts'), ...tb, grn_no: 'T26-GRN-B1', kind: 'opening_balance', status: 'draft', store_id: bId('inventory.stores'), supplier_id: null, po_id: null, received_at: NOW }],
      ['inventory.transfers', { id: id('inventory.transfers'), ...tb }],
      ['inventory.stock_counts', { id: id('inventory.stock_counts'), ...tb, store_id: bId('inventory.stores') }],
      ['inventory.consumption_rules', { id: id('inventory.consumption_rules'), ...tb, rule_kind: 'per_test', test_id: testId, item_id: bId('inventory.items'), qty_base: 1, entered_qty: 1, effective_from: '2026-01-01T00:00:00Z', is_active: true }],
      ['inventory.consumption_facts', { id: id('inventory.consumption_facts'), ...tb, fact_kind: 'test', basis_key: 't26-b-fact', source: 'manual', occurred_at: NOW, business_date: '2026-06-15', status: 'unresolved', rules_applied: 0 }],
      ['inventory.purchase_orders', { id: id('inventory.purchase_orders'), ...tb, supplier_id: bId('inventory.suppliers'), store_id: bId('inventory.stores') }],
      ['inventory.alerts', { id: id('inventory.alerts'), ...tb, alert_kind: 'below_reorder', dedupe_key: 't26-b-alert', status: 'open', first_raised_at: NOW, last_raised_at: NOW }],
      ['catalog.tests', { id: testId, ...tb, workflow_type: 'standard' }],
      ['instruments.instruments', { id: id('instruments.instruments'), ...tb, centre_id: '01a1a98a-ac40-7000-8000-00000000b201', agent_id: randomUUID(), instrument_code: 'T26-BX1', display_name: 'T26 analyser B', vendor: 'Synthetic',
        model: 'SX-1', protocol: 'astm', driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: 'Asia/Kathmandu', state: 'draft' }],
    ];
    B_IDS.set('core.branches', BR_B);
    for (const [table, row] of rows) { const err = await put(c, table, [row]); if (err) { failed.push(err); B_IDS.delete(table); } }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  return failed;
}

/** tests/db/c12-t03/fixtures.sql, once per database (a second test file in the same run finds it applied: duplicate key 23505) */
export async function applyFixtures(admin: pg.Pool): Promise<void> {
  try { await admin.query(readFileSync(FIXTURES, 'utf8')); } catch (e) { if ((e as { code?: string }).code !== '23505') throw e; }
}

/** every inventory table with a tenant_id column (the tenant tables incl. event_inbox) */
export async function tenantTables(admin: pg.Pool): Promise<string[]> {
  return (await admin.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'inventory' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name as string);
}
/** md5 per tenant-B table as seen THROUGH RLS inside the open transaction (so uncommitted changes of the same transaction show up) */
export async function snapshotB(s: Sess, tables: string[]): Promise<string> {
  const parts = tables.map((t) => `SELECT '${t}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM inventory.${t} x WHERE tenant_id = '${B}'`);
  const rows = await s.sql(B, parts.join(' UNION ALL ') + ' ORDER BY 1');
  return JSON.stringify(rows);
}
export function p95(ms: number[]): number { const a = [...ms].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(0.95 * a.length) - 1)]!; }
