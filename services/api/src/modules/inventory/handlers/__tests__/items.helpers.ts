// C12.T-07 test helpers (not a test file). Synthetic data only.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer):
//   * Operations #1-#10 are called through the handler map: `handlers[operationId](req, ctx)` from handlers/index.ts, req = { params, query, headers, body }.
//     Success => { status, body }; failure => the handler THROWS a LimsError (core/errors.ts: code, statusCode, errors[].path).
//   * Header keys are lower-case; If-Match = `"<version>"` (02-CV §4.2, as parseIfMatch in analytics). Idempotency-Key is the core's job (not tested here).
//     Query values arrive already typed (the pipeline coerces booleans / integers before the handler).
//   * Permission gate (tenant scope, 02-TRD §5 "tenant"): `ctx.ports.IdentityPort.assertRole(ctx, { permission })` with NO branchId, FIRST: before any tx statement,
//     before body validation and before the If-Match check (a stranger learns nothing). Reads #1 #3 #10 = inventory.item.read, writes #2 #4-#9 = inventory.master.manage.
//   * ctx = { tenantId, actor: { type, id }, requestId, tx: { query }, now, db: { tx(fn) = SAVEPOINT }, ports: { IdentityPort } } like core/module.ts HandlerContext.
//   * The response bodies follow contracts/openapi/inventory.yaml (Item, ItemSummary, Pack, Barcode; lists `{ data, page }`); the server generates the ids.
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

export const A = '01a1a98a-ac40-7000-8000-00000000a001';
export const B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const READ = 'inventory.item.read';
export const MANAGE = 'inventory.master.manage';

/** operationId -> permission the handler must assert (TRD §5.1). */
export const PERMISSION: Record<string, string> = {
  listInventoryItems: READ, getInventoryItem: READ, lookupInventoryBarcode: READ,
  createInventoryItem: MANAGE, updateInventoryItem: MANAGE, setInventoryItemActive: MANAGE, createInventoryItemPack: MANAGE,
  updateInventoryItemPack: MANAGE, addInventoryItemBarcode: MANAGE, deactivateInventoryItemBarcode: MANAGE,
};

export interface Req { params?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown }
export const ifm = (version: number) => ({ 'if-match': `"${version}"` });

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Stub { ctx: any; roleCalls: any[] }

/** ctx over `tx` for `tenantId`; the IdentityPort stub grants exactly `permissions` and records every assertRole request. */
export function makeCtx(tx: Tx, tenantId: string, permissions: string[] = [READ, MANAGE]): Stub {
  const roleCalls: any[] = [];
  const profile = { centreScope: { all: true, centreIds: [] as string[] }, branchIds: [] as string[], permissions, mfaLevel: 'aal2' };
  const IdentityPort = {
    async getActor() { return profile; },
    async assertRole(_c: unknown, req: { permission: string; branchId?: string }) {
      roleCalls.push(req);
      if (!permissions.includes(req.permission)) throw new LimsError('auth.forbidden');
    },
  };
  let sp = 0;
  const ctx: any = { tenantId, actor: { type: 'user', id: SYS }, requestId: 'r-t07', tx, now: () => new Date().toISOString(), ports: { IdentityPort } };
  ctx.db = { async tx(fn: (c: unknown) => Promise<unknown>) { // SAVEPOINT inside the request transaction (02-TRD §6.3)
    const name = `t07_sp_${++sp}`;
    await tx.query(`SAVEPOINT ${name}`);
    try { const r = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${name}`); return r; }
    catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  } };
  return { ctx, roleCalls };
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

// ------------------------------------------------------------------ contract shapes (inventory.yaml components)
export const ITEM_KEYS = ['id', 'item_code', 'name', 'category', 'base_uom_code', 'manufacturer', 'catalogue_no', 'storage_condition', 'is_lot_tracked', 'requires_expiry',
  'open_stability_days', 'container_qty_base', 'hs_code', 'default_tax_code', 'notes', 'is_active', 'version', 'packs', 'barcodes', 'updated_at'];
export const SUMMARY_KEYS = ['id', 'item_code', 'name', 'category', 'base_uom_code', 'storage_condition', 'is_lot_tracked', 'requires_expiry', 'is_active', 'version'];
export const PACK_KEYS = ['id', 'item_id', 'pack_code', 'label', 'uom_code', 'qty_in_base', 'is_purchase_default', 'is_active', 'version'];
export const BARCODE_KEYS = ['id', 'item_id', 'pack_id', 'barcode_value', 'is_active', 'version'];
export const onlyKeys = (o: object, allowed: string[]) => Object.keys(o).filter((k) => !allowed.includes(k));
/** Money / audit / tenant columns must never reach the wire (AC-01.1; REQ-SEC-024). */
export const LEAK = /paisa|price|cost|value_basis|tenant|created_by|updated_by|created_at/i;

export const newItem = (over: Record<string, unknown> = {}) => ({ item_code: 'T07-NEW', name: 'T07 synthetic reagent', category: 'reagent', base_uom_code: 'test', ...over });
export const newPack = (over: Record<string, unknown> = {}) => ({ pack_code: 'BOX', label: 'Box of 400', uom_code: 'box', qty_in_base: '400', ...over });
