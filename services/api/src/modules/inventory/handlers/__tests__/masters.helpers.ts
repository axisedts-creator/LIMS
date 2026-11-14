// C12.T-08 test helpers (not a test file). Synthetic data only. Operations #11-#25: stores, store item settings, suppliers, supplier items, instrument bindings.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention as T-07 (items.helpers.ts):
//   * `handlers[operationId](req, ctx)` from handlers/index.ts, req = { params, query, headers, body }; success => { status, body }; failure => the handler THROWS a LimsError.
//   * Header keys lower-case; If-Match = `"<version>"`. Query values arrive already typed (the pipeline coerces booleans / integers); the handler still validates them (enums, uuids, limit 1..200).
//   * GATE ORDER. Tenant-scope operations (#17-#22) and the two visible-branch lists (#11, #23): `ctx.ports.IdentityPort.assertRole(ctx, { permission })` with NO branchId is the FIRST
//     thing, before any tx statement and before body / query validation (a stranger learns nothing). Store-scope operations (#12-#16, #24, #25, TRD §5 "branch(...)"): body / header /
//     query validation (400, 428) first, with the tx untouched; then 02-TRD §5 Scope: load the store (or the branch / binding) -> branch not visible => 404 common.not_found ->
//     assertRole({ permission, branchId }) => 403 (P-B8: 404 beats 403).
//   * ctx.core = the real core repository (createCoreRepo) over the same tx: `ctx.core.branch(ctx, { branchId })` / `ctx.core.branches(ctx)` give `branch_name` (02-TRD §6.2 Store).
//   * Visible branches come from IdentityPort.getActor(): `centreScope.all` => every branch, else `branchIds` (T-04 scope.service.ts). Permissions: getActor().permissions (cost allowlist, T-04 mappers).
//   * ENQUEUE (02-TRD §9 table, 03-APP-FLOW §6): the handler calls `ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [task, JSON.stringify(payload), jobKey])` IN THE REQUEST TRANSACTION
//     (the C0 wrapper, as identity/billing do), task `inventory.resolve_unresolved`, payload carries `tenant_id` (extra keys allowed), job_key `resolve:<tenant>:<instrument_id>` after #24 and
//     `resolve:<tenant>:all` after #14 sets is_default_consumption = true. The task itself is a stub until T-15 (services/worker/src/jobs/inventory).
import { LimsError } from '../../../../core/errors.js';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { handlers } from '../index.js';

export const A = '01a1a98a-ac40-7000-8000-00000000a001';
export const B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const BR1 = '01a1a98a-ac40-7000-8000-00000000a101'; // tenant A branches (db/seeds/010): "BR-1" / "BR-2" of the PRD
export const BR2 = '01a1a98a-ac40-7000-8000-00000000a102';
export const BR_B = '01a1a98a-ac40-7000-8000-00000000b101';
export const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const READ = 'inventory.item.read';
export const MANAGE = 'inventory.master.manage';
export const COST = 'inventory.cost.read';
export const TASK = 'inventory.resolve_unresolved';

/** operationId -> permission the handler must assert (TRD §5). */
export const PERMISSION: Record<string, string> = {
  listInventoryStores: READ, getInventoryStore: READ, listStoreItemSettings: READ, listInventorySuppliers: READ, getInventorySupplier: READ, listSupplierItems: READ, listInstrumentBindings: READ,
  createInventoryStore: MANAGE, updateInventoryStore: MANAGE, putStoreItemSetting: MANAGE, createInventorySupplier: MANAGE, updateInventorySupplier: MANAGE, putSupplierItem: MANAGE,
  putInstrumentBinding: MANAGE, deactivateInstrumentBinding: MANAGE,
};

export interface Req { params?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown }
export const ifm = (version: number) => ({ 'if-match': `"${version}"` });

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Stub { ctx: any; roleCalls: any[]; logs: unknown[] }
export interface Opts { permissions?: string[]; all?: boolean; branchIds?: string[] }

/** ctx over `tx` for `tenantId`. The IdentityPort stub grants exactly `permissions`, records every assertRole request and reports the branch scope (`all`, default true, or `branchIds`). */
export function makeCtx(tx: Tx, tenantId: string, o: Opts = {}): Stub {
  const permissions = o.permissions ?? [READ, MANAGE];
  const roleCalls: any[] = [];
  const logs: unknown[] = []; // every ctx.log call (07-SECURITY §5: supplier contact data is never logged)
  const profile = { centreScope: { all: o.all ?? true, centreIds: [] as string[] }, branchIds: o.branchIds ?? [], permissions, mfaLevel: 'aal2' };
  const IdentityPort = {
    async getActor() { return profile; },
    async assertRole(_c: unknown, req: { permission: string; branchId?: string }) {
      roleCalls.push(req);
      if (!permissions.includes(req.permission)) throw new LimsError('auth.forbidden');
    },
  };
  const core = createCoreRepo({ withTenantScope: async (_t, _tenant, _actor, fn) => fn(), systemActorOf: () => SYS });
  let sp = 0;
  const ctx: any = { tenantId, actor: { type: 'user', id: SYS }, requestId: 'r-t08', tx, now: () => new Date().toISOString(), ports: { IdentityPort }, core,
    log: { info: (o: unknown, m?: string) => logs.push([o, m]), warn: (o: unknown, m?: string) => logs.push([o, m]), error: (o: unknown, m?: string) => logs.push([o, m]) } };
  ctx.db = { async tx(fn: (c: unknown) => Promise<unknown>) { // SAVEPOINT inside the request transaction (02-TRD §6.3)
    const name = `t08_sp_${++sp}`;
    await tx.query(`SAVEPOINT ${name}`);
    try { const r = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${name}`); return r; }
    catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  } };
  return { ctx, roleCalls, logs };
}

/** A tx that must never be touched (validation / permission tests): any statement fails the test loudly. */
export function deadTx(): Tx & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async query(text: string) { calls.push(text); throw new Error(`tx touched: ${text.slice(0, 80)}`); } };
}

export async function call(op: string, ctx: any, req: Req = {}): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  const h = (handlers as Record<string, (r: unknown, c: unknown) => Promise<any>>)[op];
  if (!h) throw new Error(`no handler ${op}`);
  return h({ params: {}, query: {}, headers: {}, body: undefined, ...req }, ctx);
}

export async function rej(p: Promise<unknown>): Promise<LimsError> {
  try { await p; } catch (e) { return e as LimsError; }
  throw new Error('expected a rejection, but it resolved');
}
export async function expectLims(p: Promise<unknown>, code: string, status: number): Promise<LimsError> {
  const e = await rej(p);
  if (!(e instanceof LimsError)) throw new Error(`expected LimsError ${code}, got ${String((e as Error)?.stack ?? e)}`);
  if (e.code !== code || e.statusCode !== status) throw new Error(`expected ${code} (${status}), got ${e.code} (${e.statusCode}) ${e.detail ?? ''}`);
  return e;
}

// ------------------------------------------------------------------ contract shapes (inventory.yaml components; no tenant / audit columns ever)
export const STORE_KEYS = ['id', 'branch_id', 'branch_name', 'store_code', 'name', 'store_kind', 'is_default_consumption', 'is_active', 'version'];
export const TARGET_KEYS = ['id', 'store_code', 'name', 'branch_id', 'branch_name', 'store_kind']; // purpose=transfer_target: TRD #11 "only id, store_code, name, branch_id, branch_name" (+ contract's optional store_kind)
export const SETTING_KEYS = ['id', 'store_id', 'item_id', 'reorder_level_base', 'reorder_qty_base', 'max_level_base', 'preferred_supplier_id', 'is_stocked', 'is_active', 'version'];
export const SUPPLIER_KEYS = ['id', 'supplier_code', 'name', 'pan_text', 'contact_name', 'phone_display', 'email', 'address_text', 'payment_terms_days', 'notes', 'is_active', 'version', 'updated_at'];
export const SUPPLIER_SUMMARY_KEYS = ['id', 'supplier_code', 'name', 'is_active', 'version'];
export const SUPPLIER_ITEM_KEYS = ['id', 'supplier_id', 'item_id', 'pack_id', 'supplier_item_code', 'last_unit_price_paisa', 'lead_time_days', 'default_tax_code', 'is_active', 'version'];
export const BINDING_KEYS = ['id', 'instrument_id', 'store_id', 'is_active', 'version'];
export const onlyKeys = (o: object, allowed: string[]) => Object.keys(o).filter((k) => !allowed.includes(k));
/** Audit / tenant columns (and, off the cost allowlist, money) must never reach the wire. */
export const LEAK = /tenant|created_by|updated_by|created_at/i;

export const newStore = (over: Record<string, unknown> = {}) => ({ branch_id: BR1, store_code: 'T08-NEW', name: 'T08 synthetic store', store_kind: 'bench', ...over });
export const newSupplier = (over: Record<string, unknown> = {}) => ({ supplier_code: 'T08-SUP', name: 'T08 synthetic supplier', ...over });
export const putSetting = (over: Record<string, unknown> = {}) => ({ is_stocked: true, ...over });
export const putSupplierItemBody = (over: Record<string, unknown> = {}) => ({ is_active: true, ...over });
