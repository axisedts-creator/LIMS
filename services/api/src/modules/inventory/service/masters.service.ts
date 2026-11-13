// C12.T-08 stores / store item settings / suppliers / supplier items / instrument bindings (02-TRD §5.1 #11-#25, PRD AC-03.x / AC-04.x / AC-17.1, 07-SECURITY P-1 P-B1..P-B8 P-T1 A12).
// Every statement goes through the T-03 repositories (tenant bound as $1, RLS on); a foreign or unknown id is the same 404 (no oracle).
// Store-scope operations: load the store -> branch visible? else 404 -> assertRole({permission, branchId}) (scope.service, 404 beats 403, P-B8).
// DB rejections are mapped here (P-1): unique code -> 409 inventory.code_duplicate, unique race on a "one active row" index -> 409 common.version_conflict, FK / CHECK on a request field -> 400 naming the field.
// Supplier contact data is personal data (07 §5): nothing from a request body is ever logged or put into an error.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { BindingListQuery, ItemFilterQuery, PageQuery, SettingsListQuery, StoreListQuery, SupplierListQuery, SupplierPatchInput } from '../handlers/masters.schemas.js';
import { toSupplierDto, toSupplierItemDto, toSupplierSummaryDto } from '../mappers/supplier.dto.js';
import { listTaxCodes } from '../repository/codedSets.repo.js';
import { getItem, getPack } from '../repository/items.repo.js';
import { insertInstrumentBinding, insertStore, insertStoreItemSetting, updateInstrumentBinding, updateStore, updateStoreItemSetting } from '../repository/stores.repo.js';
import { getSupplier, insertSupplier, insertSupplierItem, updateSupplier, updateSupplierItem } from '../repository/suppliers.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, prefixOf, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { assertStoreAccess, listVisibleBranchIds, type Visible } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const conflict = (): LimsError => new LimsError('common.version_conflict');
const duplicate = (): LimsError => new LimsError('inventory.code_duplicate');
const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.masterManage;

// ---------------------------------------------------------------- DB error mapping
const BY_CONSTRAINT: Record<string, () => LimsError> = {
  stores__tenant_id_store_code__uq: duplicate,
  suppliers__tenant_id_supplier_code__uq: duplicate,
  stores__tenant_id_branch_id_default__p_uq: conflict, // a concurrent "make me the default" in the same branch lost the race
  store_item_settings__key__uq: conflict, // a concurrent first PUT of the same (store, item)
  supplier_items__key__uq: conflict,
  instrument_bindings__tenant_id_instrument__p_uq: conflict,
  stores__branch__fk: () => invalid(fieldError('/branch_id')),
  store_item_settings__supplier__fk: () => invalid(fieldError('/preferred_supplier_id')),
  store_item_settings__ck: () => invalid(fieldError('/max_level_base')),
  store_item_settings__store__fk: notFound,
  store_item_settings__item__fk: notFound,
  supplier_items__supplier__fk: notFound,
  supplier_items__pack__fk: notFound,
  instrument_bindings__instrument__fk: notFound, // 02-TRD #24: unknown / other-tenant instrument -> 404 (FK violation mapped)
  instrument_bindings__store__fk: notFound,
};
function translate(e: unknown): unknown {
  const pg = e as { constraint?: string } | null;
  const mapped = pg?.constraint ? BY_CONSTRAINT[pg.constraint] : undefined;
  return mapped ? mapped() : e;
}
const mapped = async <T>(p: Promise<T>): Promise<T> => { try { return await p; } catch (e) { throw translate(e); } };

// ---------------------------------------------------------------- DTOs (explicit allowlists; null is never sent, CV §4.2)
const nn = (row: Row, keys: readonly string[]): Dto => Object.fromEntries(keys.filter((k) => row[k] !== null && row[k] !== undefined).map((k) => [k, row[k]]));
const noNull = (row: Row): Dto => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const STORE = ['id', 'branch_id', 'store_code', 'name', 'store_kind', 'is_default_consumption', 'is_active', 'version'];
const SETTING = ['id', 'store_id', 'item_id', 'reorder_level_base', 'reorder_qty_base', 'max_level_base', 'preferred_supplier_id', 'is_stocked', 'is_active', 'version'];
const BINDING = ['id', 'instrument_id', 'store_id', 'is_active', 'version'];
const storeDto = (r: Row, branchName: string | undefined): Dto => ({ ...nn(r, STORE), ...(branchName === undefined ? {} : { branch_name: branchName }) });
const targetDto = (r: Row, branchName: string | undefined): Dto => ({ ...nn(r, ['id', 'store_code', 'name', 'branch_id']), ...(branchName === undefined ? {} : { branch_name: branchName }) });
const supplierDto = (r: Row): Dto => noNull(toSupplierDto({ ...r, updated_at: iso(r['updated_at']) }));
const supplierItemDto = (r: Row, perms: readonly string[]): Dto =>
  noNull(toSupplierItemDto({ ...r, last_unit_price_paisa: r['last_unit_price_paisa'] === null ? null : Number(r['last_unit_price_paisa']) }, perms));

interface BranchInfo { readonly id: string; readonly name: string; readonly isActive: boolean }
async function branches(ctx: HandlerContext): Promise<readonly BranchInfo[]> {
  return (ctx.core as { branches(c: unknown): Promise<readonly BranchInfo[]> }).branches(ctx);
}
const branchNames = async (ctx: HandlerContext): Promise<Map<string, string>> => new Map((await branches(ctx)).map((b) => [b.id, b.name]));
const permissionsOf = async (ctx: HandlerContext): Promise<readonly string[]> => (await (ctx.ports.IdentityPort as any).getActor(ctx)).permissions ?? [];
const checkVersion = (row: Row, expected: number): void => { if (row['version'] !== expected) throw conflict(); };

// ---------------------------------------------------------------- keyset paging (cursor = base64url {i: last id}; the sort key is re-read tenant-bound, so a forged / foreign cursor is a 400)
const cursorOf = (id: string): string => Buffer.from(JSON.stringify({ i: id })).toString('base64url');
interface Paged { readonly rows: Row[]; readonly page: { limit: number; next_cursor?: string } }
async function paged(rc: RepoCtx, table: string, where: string, q: Q, key: string, p: PageQuery): Promise<Paged> {
  const bad = (): LimsError => invalid(fieldError('/cursor'));
  let w = where;
  if (p.cursor !== undefined) {
    let id: unknown;
    try { id = (JSON.parse(Buffer.from(p.cursor, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* falls through to the 400 */ }
    if (!isUuid(id)) throw bad();
    const cur = await first(rc, `SELECT ${key} AS k FROM ${table} WHERE tenant_id = $1 AND id = $2`, [id]);
    if (cur === null) throw bad();
    const k = q.p(cur['k']);
    const i = q.p(id);
    w += ` AND (${key} COLLATE "C" > ${k}::text COLLATE "C" OR (${key} COLLATE "C" = ${k}::text COLLATE "C" AND id > ${i}::uuid))`;
  }
  const rows = await query(rc, `SELECT * FROM ${table} WHERE tenant_id = $1${w} ORDER BY ${key} COLLATE "C", id LIMIT ${q.p(p.limit + 1)}`, q.vals);
  const page = rows.slice(0, p.limit);
  return { rows: page, page: { limit: p.limit, ...(rows.length > p.limit ? { next_cursor: cursorOf(page[page.length - 1]!['id']) } : {}) } };
}
const inBranches = (q: Q, v: Visible, col = 'branch_id'): string => (v.all ? '' : ` AND ${col} = ANY(${q.p([...v.branchIds])}::uuid[])`);

/** AC-17.1 / E10 (03-APP-FLOW §6): same request transaction, so the job exists only if the binding / default flag commits. The task itself is a stub until T-15. */
const TASK = 'inventory.resolve_unresolved';
async function enqueueResolve(ctx: HandlerContext, scopeKey: string): Promise<void> {
  await (ctx.tx as RepoCtx['tx']).query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [TASK, JSON.stringify({ tenant_id: ctx.tenantId }), `resolve:${ctx.tenantId}:${scopeKey}`]);
}

// ---------------------------------------------------------------- #11 list stores
export async function listStores(ctx: HandlerContext, f: StoreListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  const transfer = f.purpose === 'transfer_target';
  let w = transfer ? ' AND is_active' : f.is_active === undefined ? '' : ` AND is_active = ${q.p(f.is_active)}`;
  if (transfer && f.is_active === false) w = ' AND false'; // the target list is active stores only
  if (!transfer) w += inBranches(q, await listVisibleBranchIds(sc(ctx))); // P-B5: transfer targets span all branches of the tenant
  if (f.branch_id !== undefined) w += ` AND branch_id = ${q.p(f.branch_id)}`;
  if (f.store_kind !== undefined) w += ` AND store_kind = ${q.p(f.store_kind)}`;
  const [{ rows, page }, names] = await Promise.all([paged(rc, 'inventory.stores', w, q, 'store_code', f), branchNames(ctx)]);
  return { data: rows.map((r) => (transfer ? targetDto : storeDto)(r, names.get(r['branch_id']))), page };
}

// ---------------------------------------------------------------- #12 #13 #14 stores
/** One default per branch (stores__tenant_id_branch_id_default__p_uq): clear the current one before another store takes the flag. */
async function clearDefault(rc: RepoCtx, branchId: string, exceptId: string | null): Promise<void> {
  await query(rc, `UPDATE inventory.stores SET is_default_consumption = false, version = version + 1, updated_at = now(), updated_by = $2
                    WHERE tenant_id = $1 AND branch_id = $3 AND is_default_consumption AND is_active AND ($4::uuid IS NULL OR id <> $4::uuid)`, [rc.actorId, branchId, exceptId]);
}

export async function createStore(ctx: HandlerContext, input: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  const branchId = input['branch_id'] as string;
  const v = await listVisibleBranchIds(sc(ctx));
  if (!v.all && !v.branchIds.includes(branchId)) throw notFound(); // P-B2: a branch the actor cannot see is "no such branch"
  const b = (await branches(ctx)).find((x) => x.id === branchId);
  if (b === undefined || !b.isActive) throw invalid(fieldError('/branch_id')); // unknown, other-tenant and inactive branches look alike (P-1)
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: MANAGE, branchId });
  if (input['is_default_consumption'] === true) await clearDefault(rc, branchId, null);
  return storeDto(await mapped(insertStore(rc, { id: uuidv7(), ...input })), b.name);
}

export async function getStoreFull(ctx: HandlerContext, id: string): Promise<Dto> {
  const store = await assertStoreAccess(sc(ctx), id, READ);
  return storeDto(store, (await branchNames(ctx)).get(store['branch_id']));
}

/** AC-03.3 (CR-C12-003): a non-zero balance (also negative) blocks deactivation. */
async function hasStock(rc: RepoCtx, storeId: string): Promise<boolean> {
  return (await first(rc, 'SELECT 1 AS x FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND qty_base <> 0 LIMIT 1', [storeId])) !== null;
}

export async function patchStore(ctx: HandlerContext, id: string, ifMatch: number, input: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await assertStoreAccess(sc(ctx), id, MANAGE);
  checkVersion(cur, ifMatch);
  const name = (await branchNames(ctx)).get(cur['branch_id']);
  const patch: Record<string, any> = Object.fromEntries(Object.entries(input).filter(([k, val]) => cur[k] !== val));
  if (Object.keys(patch).length === 0) return storeDto(cur, name); // nothing changes: no version bump, no job
  const active = (patch['is_active'] ?? cur['is_active']) as boolean;
  const makesDefault = patch['is_default_consumption'] === true;
  if (makesDefault && !active) throw invalid(fieldError('/is_default_consumption')); // an inactive store cannot be the consumption default
  const deactivates = patch['is_active'] === false;
  if (deactivates) {
    if (await hasStock(rc, id)) throw new LimsError('inventory.store_not_empty');
    if (cur['is_default_consumption'] === true) patch['is_default_consumption'] = false; // [CONV] a deactivated store gives up the default flag
  }
  if (makesDefault) await clearDefault(rc, cur['branch_id'], id);
  const row = await mapped(updateStore(rc, id, ifMatch, patch));
  if (deactivates) { // E10: bindings to a closed store are closed with it
    await query(rc, `UPDATE inventory.instrument_bindings SET is_active = false, version = version + 1, updated_at = now(), updated_by = $2
                      WHERE tenant_id = $1 AND store_id = $3 AND is_active`, [rc.actorId, id]);
  }
  if (makesDefault) await enqueueResolve(ctx, 'all'); // AC-17.2: facts that were waiting for a default store
  return storeDto(row, name);
}

// ---------------------------------------------------------------- #15 #16 store item settings
export async function listStoreItemSettings(ctx: HandlerContext, storeId: string, f: SettingsListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), storeId, READ);
  const q = new Q();
  let w = ` AND store_id = ${q.p(storeId)}`;
  if (f.item_id !== undefined) w += ` AND item_id = ${q.p(f.item_id)}`;
  if (f.below_reorder === true) { // on-hand (all lots) under the reorder level; a row without a level is never below
    w += ` AND is_active AND is_stocked AND reorder_level_base IS NOT NULL
           AND coalesce((SELECT sum(b.qty_base) FROM inventory.stock_balances b WHERE b.tenant_id = $1 AND b.store_id = store_item_settings.store_id AND b.item_id = store_item_settings.item_id), 0) < reorder_level_base`;
  }
  const { rows, page } = await paged(rc, 'inventory.store_item_settings', w, q, 'id::text', f);
  return { data: rows.map((r) => nn(r, SETTING)), page };
}

/** PUT replaces the optional fields (reorder_level_base, reorder_qty_base, max_level_base, preferred_supplier_id) and (re)activates the row. If-Match is needed only when the row exists. */
export async function putStoreItemSetting(ctx: HandlerContext, storeId: string, itemId: string, ifMatch: number | undefined, input: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), storeId, MANAGE);
  if (!isUuid(itemId) || (await getItem(rc, itemId)) === null) throw notFound();
  if (input['preferred_supplier_id'] !== undefined && (await getSupplier(rc, input['preferred_supplier_id'])) === null) throw invalid(fieldError('/preferred_supplier_id'));
  const body = { reorder_level_base: null, reorder_qty_base: null, max_level_base: null, preferred_supplier_id: null, ...input, is_active: true };
  const cur = await first(rc, 'SELECT * FROM inventory.store_item_settings WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [storeId, itemId]);
  if (cur === null) return nn(await mapped(insertStoreItemSetting(rc, { id: uuidv7(), store_id: storeId, item_id: itemId, ...body })), SETTING);
  if (ifMatch === undefined) throw new LimsError('common.precondition_required');
  checkVersion(cur, ifMatch);
  return nn(await mapped(updateStoreItemSetting(rc, cur['id'], ifMatch, body)), SETTING);
}

// ---------------------------------------------------------------- #17 #18 #19 #20 suppliers (tenant scope)
export async function listSuppliers(ctx: HandlerContext, f: SupplierListQuery): Promise<Dto> {
  const q = new Q();
  let w = f.is_active === undefined ? '' : ` AND is_active = ${q.p(f.is_active)}`;
  if (f.q !== undefined) w += ` AND lower(name) LIKE lower(${q.p(prefixOf(f.q))})`; // prefix only, % _ \ literal
  const { rows, page } = await paged(rcOf(ctx), 'inventory.suppliers', w, q, 'name', f);
  return { data: rows.map((r) => noNull(toSupplierSummaryDto(r))), page };
}

export async function createSupplier(ctx: HandlerContext, input: Record<string, any>): Promise<Dto> {
  return supplierDto(await mapped(insertSupplier(rcOf(ctx), { id: uuidv7(), ...input })));
}

const loadSupplier = async (rc: RepoCtx, id: string): Promise<Row> => (isUuid(id) ? await getSupplier(rc, id) : null) ?? Promise.reject(notFound());

export async function getSupplierFull(ctx: HandlerContext, id: string): Promise<Dto> {
  return supplierDto(await loadSupplier(rcOf(ctx), id));
}

export async function patchSupplier(ctx: HandlerContext, id: string, ifMatch: number, input: SupplierPatchInput): Promise<Dto> {
  const rc = rcOf(ctx);
  checkVersion(await loadSupplier(rc, id), ifMatch);
  const set: Record<string, any> = { ...input.set };
  for (const f of input.unset) set[f] = null; // CV §4.2: clearing is unset[], never null
  return supplierDto(await mapped(updateSupplier(rc, id, ifMatch, set)));
}

// ---------------------------------------------------------------- #21 #22 supplier items (tenant scope)
export async function listSupplierItemsOf(ctx: HandlerContext, supplierId: string, f: ItemFilterQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  await loadSupplier(rc, supplierId);
  const q = new Q();
  let w = ` AND supplier_id = ${q.p(supplierId)}`;
  if (f.item_id !== undefined) w += ` AND item_id = ${q.p(f.item_id)}`;
  const [{ rows, page }, perms] = await Promise.all([paged(rc, 'inventory.supplier_items', w, q, 'id::text', f), permissionsOf(ctx)]);
  return { data: rows.map((r) => supplierItemDto(r, perms)), page };
}

/** PUT replaces the optional fields. A pack of another item -> 422 inventory.uom_mismatch; a pack that does not exist for this tenant is the same 404 as an unknown one. */
export async function putSupplierItemOf(ctx: HandlerContext, supplierId: string, itemId: string, packId: string, ifMatch: number | undefined, input: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  await loadSupplier(rc, supplierId);
  if (!isUuid(itemId) || (await getItem(rc, itemId)) === null) throw notFound();
  const pack = isUuid(packId) ? await getPack(rc, packId) : null;
  if (pack === null) throw notFound();
  if (pack['item_id'] !== itemId) throw new LimsError('inventory.uom_mismatch');
  if (input['default_tax_code'] !== undefined && !(await listTaxCodes(rc)).some((t) => t['code'] === input['default_tax_code'])) throw invalid(fieldError('/default_tax_code'));
  const perms = await permissionsOf(ctx);
  const body = { supplier_item_code: null, last_unit_price_paisa: null, lead_time_days: null, default_tax_code: null, ...input };
  const cur = await first(rc, 'SELECT * FROM inventory.supplier_items WHERE tenant_id = $1 AND supplier_id = $2 AND item_id = $3 AND pack_id = $4', [supplierId, itemId, packId]);
  if (cur === null) return supplierItemDto(await mapped(insertSupplierItem(rc, { id: uuidv7(), supplier_id: supplierId, item_id: itemId, pack_id: packId, ...body })), perms);
  if (ifMatch === undefined) throw new LimsError('common.precondition_required');
  checkVersion(cur, ifMatch);
  return supplierItemDto(await mapped(updateSupplierItem(rc, cur['id'], ifMatch, body)), perms);
}

// ---------------------------------------------------------------- #23 #24 #25 instrument bindings
export async function listBindings(ctx: HandlerContext, f: BindingListQuery): Promise<Dto> {
  const q = new Q();
  const v = await listVisibleBranchIds(sc(ctx));
  let w = '';
  if (!v.all) w += ` AND store_id IN (SELECT id FROM inventory.stores WHERE tenant_id = $1${inBranches(q, v)})`; // P-B1: bindings of visible branches only
  if (f.store_id !== undefined) w += ` AND store_id = ${q.p(f.store_id)}`;
  const { rows, page } = await paged(rcOf(ctx), 'inventory.instrument_bindings', w, q, 'id::text', f);
  return { data: rows.map((r) => nn(r, BINDING)), page };
}

const activeBinding = (rc: RepoCtx, instrumentId: string): Promise<Row | null> =>
  isUuid(instrumentId) ? first(rc, 'SELECT * FROM inventory.instrument_bindings WHERE tenant_id = $1 AND instrument_id = $2 AND is_active', [instrumentId]) : Promise.resolve(null);

/** AC-17.1: one active binding per instrument. A re-bind updates that row (If-Match required); an unknown instrument fails the FK -> 404. Enqueues resolve:<tenant>:<instrument>. */
export async function putBinding(ctx: HandlerContext, instrumentId: string, storeId: string, ifMatch: number | undefined): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), storeId, MANAGE);
  if (!isUuid(instrumentId)) throw notFound();
  const cur = await activeBinding(rc, instrumentId);
  let row: Row;
  if (cur === null) row = await mapped(insertInstrumentBinding(rc, { id: uuidv7(), instrument_id: instrumentId, store_id: storeId }));
  else {
    await assertStoreAccess(sc(ctx), cur['store_id'], MANAGE); // the binding being replaced must be in the actor's scope too (P-B2)
    if (ifMatch === undefined) throw new LimsError('common.precondition_required');
    checkVersion(cur, ifMatch);
    row = await mapped(updateInstrumentBinding(rc, cur['id'], ifMatch, { store_id: storeId }));
  }
  await enqueueResolve(ctx, instrumentId);
  return nn(row, BINDING);
}

export async function deactivateBinding(ctx: HandlerContext, instrumentId: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  const b = (await activeBinding(rc, instrumentId))
    ?? (isUuid(instrumentId) ? await first(rc, 'SELECT * FROM inventory.instrument_bindings WHERE tenant_id = $1 AND instrument_id = $2 ORDER BY updated_at DESC, id DESC LIMIT 1', [instrumentId]) : null);
  if (b === null) throw notFound();
  await assertStoreAccess(sc(ctx), b['store_id'], MANAGE);
  checkVersion(b, ifMatch);
  return nn(b['is_active'] === false ? b : await updateInstrumentBinding(rc, b['id'], ifMatch, { is_active: false }), BINDING);
}
