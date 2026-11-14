// C12.T-08 request validation for #11-#25 (contracts/openapi/inventory.yaml: Store, SupplierCreate, SupplierPatch; 05-SCHEMA §2.9-2.12, §2.22 CHECKs; 02-CV §4.2 no null on the wire).
// Same rules as items.schemas.ts: strict (unknown key -> 400 common.unknown_field), runs after the permission gate and before any DB access.
import { isUuid } from '../repository/_base.js';
import { bool, fieldError, int, invalid, isObj, oneOf, parse, parseIfMatch, pat, posDec, text, type Obj, type Rule } from './items.schemas.js';

const CODE = /^[A-Z0-9][A-Z0-9_\-]{0,15}$/; // stores__ck / suppliers__ck
const STORE_KINDS = ['main', 'bench', 'other'];
/** numeric(18,6) >= 0 as a string. */
const nnDec: Rule = (v) => typeof v === 'string' && /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(v);
const scaled = (s: string): bigint => { const [i = '0', f = ''] = s.split('.'); return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0')); };
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
const limit = int(1, 200);

/** If-Match that may be absent (PUT on a row that may not exist yet): present -> must be well formed (400). */
export const parseOptionalIfMatch = (headers: unknown): number | undefined =>
  isObj(headers) && headers['if-match'] !== undefined ? parseIfMatch(headers) : undefined;

export interface PageQuery { cursor?: string; limit: number }
const pageOf = (o: Obj): PageQuery => ({ ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] as string }), limit: (o['limit'] as number | undefined) ?? 50 });

// ---------------------------------------------------------------- stores
export interface StoreListQuery extends PageQuery { branch_id?: string; is_active?: boolean; store_kind?: string; purpose: 'manage' | 'transfer_target' }
export function parseStoreList(query: unknown): StoreListQuery {
  const o = parse(query ?? {}, { branch_id: isUuid, is_active: bool, store_kind: oneOf(...STORE_KINDS), purpose: oneOf('manage', 'transfer_target'), cursor, limit });
  return { ...pageOf(o), purpose: o['purpose'] ?? 'manage',
    ...(o['branch_id'] === undefined ? {} : { branch_id: o['branch_id'] as string }), ...(o['is_active'] === undefined ? {} : { is_active: o['is_active'] as boolean }),
    ...(o['store_kind'] === undefined ? {} : { store_kind: o['store_kind'] as string }) };
}

/** #12 StoreCreate. */
export function parseStoreCreate(body: unknown): Obj {
  const o = parse(body, { branch_id: isUuid, store_code: pat(CODE, 16), name: text(1, 120), store_kind: oneOf(...STORE_KINDS), is_default_consumption: bool }, ['branch_id', 'store_code', 'name', 'store_kind']);
  o['is_default_consumption'] ??= false;
  return o;
}

/** #14: store_code and branch_id are not in the patch (immutable). */
export function parseStorePatch(body: unknown): Obj {
  const o = parse(body, { name: text(1, 120), store_kind: oneOf(...STORE_KINDS), is_default_consumption: bool, is_active: bool });
  if (Object.keys(o).length === 0) throw invalid(fieldError('/'));
  return o;
}

// ---------------------------------------------------------------- store item settings
export interface SettingsListQuery extends PageQuery { below_reorder?: boolean; item_id?: string }
export function parseSettingsList(query: unknown): SettingsListQuery {
  const o = parse(query ?? {}, { below_reorder: bool, item_id: isUuid, cursor, limit });
  return { ...pageOf(o), ...(o['below_reorder'] === undefined ? {} : { below_reorder: o['below_reorder'] as boolean }), ...(o['item_id'] === undefined ? {} : { item_id: o['item_id'] as string }) };
}

/** #16: PUT replaces the optional fields. max_level_base >= reorder_level_base is checked here (store_item_settings__ck is layer 2). */
export function parseSettingPut(body: unknown): Obj {
  const o = parse(body, { reorder_level_base: nnDec, reorder_qty_base: posDec, max_level_base: nnDec, preferred_supplier_id: isUuid, is_stocked: bool }, ['is_stocked']);
  if (o['max_level_base'] !== undefined && o['reorder_level_base'] !== undefined && scaled(o['max_level_base']) < scaled(o['reorder_level_base'])) throw invalid(fieldError('/max_level_base'));
  return o;
}

// ---------------------------------------------------------------- suppliers
export interface SupplierListQuery extends PageQuery { is_active?: boolean; q?: string }
export function parseSupplierList(query: unknown): SupplierListQuery {
  const o = parse(query ?? {}, { is_active: bool, q: text(0, 60), cursor, limit });
  return { ...pageOf(o), ...(o['is_active'] === undefined ? {} : { is_active: o['is_active'] as boolean }), ...(o['q'] === undefined || o['q'] === '' ? {} : { q: o['q'] as string }) };
}

const SUPPLIER_OPTIONAL: Record<string, Rule> = {
  pan_text: pat(/^[A-Za-z0-9]{1,20}$/, 20), contact_name: text(0, 120), phone_display: text(0, 40), email: text(0, 254), address_text: text(0, 500),
  payment_terms_days: int(0, 365), notes: text(0, 1000),
};
export const SUPPLIER_UNSET = Object.keys(SUPPLIER_OPTIONAL);

/** #18 SupplierCreate. */
export const parseSupplierCreate = (body: unknown): Obj =>
  parse(body, { supplier_code: pat(CODE, 16), name: text(1, 200), ...SUPPLIER_OPTIONAL }, ['supplier_code', 'name']);

export interface SupplierPatchInput { readonly set: Obj; readonly unset: readonly string[] }
/** #20 SupplierPatch + unset[]: supplier_code is immutable (not in the schema); clearing is unset[], never null. */
export function parseSupplierPatch(body: unknown): SupplierPatchInput {
  const unsetRule: Rule = (v) => Array.isArray(v) && v.length <= SUPPLIER_UNSET.length && new Set(v).size === v.length && v.every((x) => typeof x === 'string' && SUPPLIER_UNSET.includes(x));
  const { unset = [], ...set } = parse(body, { name: text(1, 200), ...SUPPLIER_OPTIONAL, unset: unsetRule });
  const clash = (unset as string[]).filter((f) => f in set);
  if (clash.length > 0) throw invalid(...clash.map((f) => fieldError(`/${f}`)));
  if (Object.keys(set).length + (unset as string[]).length === 0) throw invalid(fieldError('/'));
  return { set, unset };
}

// ---------------------------------------------------------------- supplier items
export interface ItemFilterQuery extends PageQuery { item_id?: string }
export function parseSupplierItemList(query: unknown): ItemFilterQuery {
  const o = parse(query ?? {}, { item_id: isUuid, cursor, limit });
  return { ...pageOf(o), ...(o['item_id'] === undefined ? {} : { item_id: o['item_id'] as string }) };
}

/** #22: PUT replaces the optional fields. */
export const parseSupplierItemPut = (body: unknown): Obj =>
  parse(body, { supplier_item_code: text(0, 64), last_unit_price_paisa: int(0, Number.MAX_SAFE_INTEGER), lead_time_days: int(0, 365), default_tax_code: pat(/^[A-Z0-9_]{1,16}$/, 16), is_active: bool }, ['is_active']);

// ---------------------------------------------------------------- bindings
export interface BindingListQuery extends PageQuery { store_id?: string }
export function parseBindingList(query: unknown): BindingListQuery {
  const o = parse(query ?? {}, { store_id: isUuid, cursor, limit });
  return { ...pageOf(o), ...(o['store_id'] === undefined ? {} : { store_id: o['store_id'] as string }) };
}
export const parseBindingPut = (body: unknown): string => String(parse(body, { store_id: isUuid }, ['store_id'])['store_id']);
