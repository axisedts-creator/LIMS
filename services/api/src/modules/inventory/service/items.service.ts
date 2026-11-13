// C12.T-07 items / packs / barcodes (02-TRD §5.1 #1-#10, PRD AC-01.x / AC-02.x, 07-SECURITY P-1 A12 P-T1).
// Every statement goes through the T-03 repositories (tenant bound as $1, RLS on); a foreign or unknown id is the same 404 (no oracle).
// DB rejections are mapped here (P-1): unique -> 409 inventory.code_duplicate, FK / CHECK on a request field -> 400 naming the field, immutable trigger -> 409 common.immutable_record.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { fieldError, invalid, type ItemPatchInput, type ListQuery } from '../handlers/items.schemas.js';
import { listTaxCodes, listUom } from '../repository/codedSets.repo.js';
import { findActiveBarcode, getBarcode, getItem, getPack, insertBarcode, insertItem, insertPack, listBarcodes, listPacks, updateBarcode, updateItem, updatePack } from '../repository/items.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, limitOf, prefixOf, query } from '../repository/_base.js';

type Dto = Record<string, unknown>;
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const notFound = (): LimsError => new LimsError('common.not_found');
const conflict = (): LimsError => new LimsError('common.version_conflict');
const duplicate = (): LimsError => new LimsError('inventory.code_duplicate');

// ---------------------------------------------------------------- DB error mapping
const BY_CONSTRAINT: Record<string, () => LimsError> = {
  items__tenant_id_item_code__uq: duplicate,
  item_packs__tenant_id_item_code__uq: duplicate,
  item_packs__tenant_id_item_id_default__p_uq: duplicate, // [CONV] a second active purchase default on one item: 409 code_duplicate (no dedicated code in errors.yaml)
  item_barcodes__tenant_id_value__p_uq: duplicate,
  items__uom__fk: () => invalid(fieldError('/base_uom_code')),
  item_packs__uom__fk: () => invalid(fieldError('/uom_code')),
  items__expiry_requires_lot__ck: () => invalid(fieldError('/requires_expiry')),
  item_barcodes__pack__fk: notFound,
};
function translate(e: unknown): unknown {
  const pg = e as { constraint?: string; code?: string; message?: string } | null;
  const mapped = pg?.constraint ? BY_CONSTRAINT[pg.constraint] : undefined;
  if (mapped) return mapped();
  if (pg?.code === 'P0001' && /immutable/i.test(String(pg.message))) return new LimsError('common.immutable_record'); // tg_item_base_uom_lock, pack-size trigger (IT-2)
  return e;
}
const mapped = async <T>(p: Promise<T>): Promise<T> => { try { return await p; } catch (e) { throw translate(e); } };

// ---------------------------------------------------------------- DTOs (explicit allowlists: tenant_id / created_* / money never reach the wire; null is never sent, CV §4.2)
const SUMMARY = ['id', 'item_code', 'name', 'category', 'base_uom_code', 'storage_condition', 'is_lot_tracked', 'requires_expiry', 'is_active', 'version'];
const ITEM = ['id', 'item_code', 'name', 'category', 'base_uom_code', 'manufacturer', 'catalogue_no', 'storage_condition', 'open_stability_days', 'container_qty_base',
  'hs_code', 'default_tax_code', 'notes', 'is_lot_tracked', 'requires_expiry', 'is_active', 'version'];
const PACK = ['id', 'item_id', 'pack_code', 'label', 'uom_code', 'qty_in_base', 'is_purchase_default', 'is_active', 'version'];
const BARCODE = ['id', 'item_id', 'pack_id', 'barcode_value', 'is_active', 'version'];
const nn = (row: Row, keys: readonly string[]): Dto => Object.fromEntries(keys.filter((k) => row[k] !== null && row[k] !== undefined).map((k) => [k, row[k]]));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const packDto = (r: Row): Dto => nn(r, PACK);
const barcodeDto = (r: Row): Dto => nn(r, BARCODE);
const itemDto = (r: Row, packs: Row[], barcodes: Row[]): Dto => ({ ...nn(r, ITEM), packs: packs.map(packDto), barcodes: barcodes.map(barcodeDto), updated_at: iso(r['updated_at']) });
async function full(rc: RepoCtx, row: Row): Promise<Dto> {
  const [packs, barcodes] = await Promise.all([listPacks(rc, row['id'], { includeInactive: true }), listBarcodes(rc, row['id'], { includeInactive: true })]);
  return itemDto(row, packs, barcodes);
}

// ---------------------------------------------------------------- helpers
async function loadItem(rc: RepoCtx, id: string): Promise<Row> {
  return (isUuid(id) ? await getItem(rc, id) : null) ?? Promise.reject(notFound());
}
async function loadPack(rc: RepoCtx, itemId: string, packId: string): Promise<Row> {
  const p = isUuid(packId) ? await getPack(rc, packId) : null;
  if (p === null || p['item_id'] !== itemId) throw notFound(); // a pack of another item / tenant is "no such pack"
  return p;
}
const assertUom = async (rc: RepoCtx, code: string, path: string): Promise<void> => {
  if (!(await listUom(rc)).some((u) => u['code'] === code)) throw invalid(fieldError(path));
};
/** default_tax_code has no FK in 05 §2.6 (tenant + global tax codes): checked against the effective list. */
const assertTax = async (rc: RepoCtx, code: string): Promise<void> => {
  if (!(await listTaxCodes(rc)).some((t) => t['code'] === code)) throw invalid(fieldError('/default_tax_code'));
};
const checkVersion = (row: Row, expected: number): void => { if (row['version'] !== expected) throw conflict(); };

/** AC-01.5: the base unit is locked once ANY pack (active or not), consumption rule or stock movement exists for the item. */
async function baseUnitLocked(rc: RepoCtx, itemId: string): Promise<boolean> {
  const r = await first(rc, `SELECT (EXISTS (SELECT 1 FROM inventory.item_packs WHERE tenant_id = $1 AND item_id = $2)
                                  OR EXISTS (SELECT 1 FROM inventory.consumption_rules WHERE tenant_id = $1 AND item_id = $2)
                                  OR EXISTS (SELECT 1 FROM inventory.stock_movements WHERE tenant_id = $1 AND item_id = $2)) AS locked`, [itemId]);
  return r?.['locked'] === true;
}
/** AC-01.3 (CR-C12-003): non-zero stock or a live (not soft-removed) line on an open PO blocks deactivation. */
async function inUse(rc: RepoCtx, itemId: string): Promise<boolean> {
  const r = await first(rc, `SELECT (EXISTS (SELECT 1 FROM inventory.stock_balances WHERE tenant_id = $1 AND item_id = $2 AND qty_base <> 0)
                                  OR EXISTS (SELECT 1 FROM inventory.purchase_order_lines l JOIN inventory.purchase_orders p ON p.tenant_id = l.tenant_id AND p.id = l.po_id
                                              WHERE l.tenant_id = $1 AND l.item_id = $2 AND l.removed_at IS NULL
                                                AND p.status IN ('draft', 'approved', 'sent', 'partially_received'))) AS in_use`, [itemId]);
  return r?.['in_use'] === true;
}

// ---------------------------------------------------------------- #1 list
const KEY = { item_code: 'item_code', name: 'lower(name)' } as const;
const ORDER = { item_code: 'item_code COLLATE "C", id', name: 'lower(name) COLLATE "C", id', '-updated_at': 'updated_at DESC, id DESC' } as const;
const cursorOf = (sort: string, id: string): string => Buffer.from(JSON.stringify({ s: sort, i: id })).toString('base64url');

/** Keyset cursor = base64url {s: sort, i: last id}; the sort key is re-read from that row (tenant-bound), so a forged / foreign cursor is a 400, never rows of another tenant. */
async function after(rc: RepoCtx, q: Q, f: ListQuery, cursor: string): Promise<string> {
  let id: string | undefined;
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; i?: unknown } | null;
    if (o?.s === f.sort && isUuid(o.i)) id = o.i;
  } catch { /* falls through to the 400 */ }
  const bad = (): LimsError => invalid(fieldError('/cursor'));
  if (id === undefined) throw bad();
  const keyExpr = f.sort === '-updated_at' ? 'updated_at' : `${KEY[f.sort]} COLLATE "C"`;
  // updated_at goes through text with microseconds (a JS Date would cut to ms and break the keyset equality)
  const sel = f.sort === '-updated_at' ? `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : keyExpr;
  const cur = await first(rc, `SELECT ${sel} AS k FROM inventory.items WHERE tenant_id = $1 AND id = $2`, [id]);
  if (cur === null) throw bad();
  const k = q.p(cur['k']);
  const i = q.p(id);
  return f.sort === '-updated_at'
    ? ` AND (updated_at < ${k}::timestamptz OR (updated_at = ${k}::timestamptz AND id < ${i}::uuid))`
    : ` AND (${keyExpr} > ${k}::text COLLATE "C" OR (${keyExpr} = ${k}::text COLLATE "C" AND id > ${i}::uuid))`;
}

export async function listItems(ctx: HandlerContext, f: ListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  let w = f.is_active === undefined ? ' AND is_active' : ` AND is_active = ${q.p(f.is_active)}`; // default: active only; is_active=false: inactive only
  if (f.category !== undefined) w += ` AND category = ${q.p(f.category)}`;
  if (f.q !== undefined) w += ` AND (item_code LIKE ${q.p(prefixOf(f.q))} OR lower(name) LIKE lower(${q.p(prefixOf(f.q))}))`; // prefix only, % _ \ literal
  if (f.cursor !== undefined) w += await after(rc, q, f, f.cursor);
  const limit = limitOf(f.limit);
  const rows = await query(rc, `SELECT * FROM inventory.items WHERE tenant_id = $1${w} ORDER BY ${ORDER[f.sort]} LIMIT ${q.p(limit + 1)}`, q.vals);
  const page = rows.slice(0, limit);
  return { data: page.map((r) => nn(r, SUMMARY)), page: { limit, ...(rows.length > limit ? { next_cursor: cursorOf(f.sort, page[page.length - 1]!['id']) } : {}) } };
}

// ---------------------------------------------------------------- #2 #3 #4 #5 items
export async function createItem(ctx: HandlerContext, input: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertUom(rc, input['base_uom_code'], '/base_uom_code');
  if (input['default_tax_code'] !== undefined) await assertTax(rc, input['default_tax_code']);
  const row = await mapped(insertItem(rc, { id: uuidv7(), ...input }));
  return itemDto(row, [], []);
}

export async function getItemFull(ctx: HandlerContext, id: string): Promise<Dto> {
  const rc = rcOf(ctx);
  return full(rc, await loadItem(rc, id));
}

export async function patchItem(ctx: HandlerContext, id: string, ifMatch: number, input: ItemPatchInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await loadItem(rc, id);
  checkVersion(cur, ifMatch);
  const set: Record<string, any> = { ...input.set };
  for (const f of input.unset) set[f] = null; // CV §4.2: clearing is unset[], never null
  if (set['base_uom_code'] !== undefined) {
    if (set['base_uom_code'] === cur['base_uom_code']) delete set['base_uom_code'];
    else {
      await assertUom(rc, set['base_uom_code'], '/base_uom_code');
      if (await baseUnitLocked(rc, id)) throw new LimsError('common.immutable_record'); // AC-01.5; tg_item_base_uom_lock is layer 2
    }
  }
  if (typeof set['default_tax_code'] === 'string') await assertTax(rc, set['default_tax_code']);
  const lot = set['is_lot_tracked'] ?? cur['is_lot_tracked'];
  const exp = set['requires_expiry'] ?? cur['requires_expiry'];
  if (exp === true && lot === false) throw invalid(fieldError(set['requires_expiry'] === undefined ? '/is_lot_tracked' : '/requires_expiry')); // items__expiry_requires_lot__ck
  if (Object.keys(set).length === 0) return full(rc, cur); // nothing left to change (e.g. the same base unit)
  return full(rc, await mapped(updateItem(rc, id, ifMatch, set)));
}

export async function setItemActive(ctx: HandlerContext, id: string, ifMatch: number, active: boolean): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await loadItem(rc, id);
  checkVersion(cur, ifMatch);
  if (cur['is_active'] === active) return full(rc, cur);
  if (!active && (await inUse(rc, id))) throw new LimsError('inventory.item_in_use');
  return full(rc, await updateItem(rc, id, ifMatch, { is_active: active }));
}

// ---------------------------------------------------------------- #6 #7 packs
export async function createPack(ctx: HandlerContext, itemId: string, input: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  await loadItem(rc, itemId);
  await assertUom(rc, input['uom_code'], '/uom_code');
  return packDto(await mapped(insertPack(rc, { id: uuidv7(), item_id: itemId, is_purchase_default: false, ...input })));
}

/** AC-02.2: qty_in_base cannot be in `patch` (the schema refused it); the pack-size trigger is layer 2. */
export async function patchPack(ctx: HandlerContext, itemId: string, packId: string, ifMatch: number, patch: Record<string, any>): Promise<Dto> {
  const rc = rcOf(ctx);
  await loadItem(rc, itemId);
  checkVersion(await loadPack(rc, itemId, packId), ifMatch);
  if (patch['uom_code'] !== undefined) await assertUom(rc, patch['uom_code'], '/uom_code');
  return packDto(await mapped(updatePack(rc, packId, ifMatch, patch)));
}

// ---------------------------------------------------------------- #8 #9 #10 barcodes (values arrive upper-cased and shape-checked)
export async function addBarcode(ctx: HandlerContext, itemId: string, input: { barcode_value: string; pack_id?: string }): Promise<Dto> {
  const rc = rcOf(ctx);
  await loadItem(rc, itemId);
  if (input.pack_id !== undefined) await loadPack(rc, itemId, input.pack_id); // a pack of another item / tenant is 404, not an FK error
  return barcodeDto(await mapped(insertBarcode(rc, { id: uuidv7(), item_id: itemId, ...input })));
}

export async function deactivateBarcode(ctx: HandlerContext, itemId: string, barcodeId: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  await loadItem(rc, itemId);
  const b = isUuid(barcodeId) ? await getBarcode(rc, barcodeId) : null;
  if (b === null || b['item_id'] !== itemId) throw notFound();
  checkVersion(b, ifMatch);
  return barcodeDto(b['is_active'] === false ? b : await updateBarcode(rc, barcodeId, ifMatch, { is_active: false }));
}

/** Equality on the active value only (no pattern, no oracle): unknown, inactive and other-tenant values are the same 404. */
export async function lookupBarcode(ctx: HandlerContext, value: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const b = await findActiveBarcode(rc, value);
  const item = b === null ? null : await getItem(rc, b['item_id']);
  if (b === null || item === null) throw notFound();
  const pack = b['pack_id'] ? await getPack(rc, b['pack_id']) : null;
  return { item: nn(item, SUMMARY), ...(pack === null ? {} : { pack: packDto(pack) }) };
}
