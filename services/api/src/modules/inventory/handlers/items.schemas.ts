// C12.T-07 request validation for #1-#10 (contracts/openapi/inventory.yaml: ItemCreate, ItemPatch, pack / barcode bodies, DecimalStringPositive; 02-CV §4.2 If-Match, no null on the wire).
// Strict: unknown keys are 400 common.unknown_field (mass assignment, 07-SECURITY A12); a JSON-undefined value counts as absent. Runs AFTER the permission gate, BEFORE any DB access.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isUuid } from '../repository/_base.js';

export type Rule = (v: unknown) => boolean;
export type Obj = Record<string, any>;
const MSG = { 'common.field_required': 'Field required', 'common.unknown_field': 'Unknown field', 'common.field_invalid': 'Field invalid' } as const;

export const fieldError = (path: string, code: keyof typeof MSG = 'common.field_invalid'): FieldError => ({ path, code, message: MSG[code] });
export const invalid = (...errs: FieldError[]): LimsError => new LimsError('common.validation_failed', undefined, errs);
const pointer = (k: string): string => `/${k.slice(0, 64).replaceAll('~', '~0').replaceAll('/', '~1')}`;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const cp = (s: string): number => [...s].length; // DB char_length counts code points
export const text = (min: number, max: number): Rule => (v) => typeof v === 'string' && cp(v) >= min && cp(v) <= max && (min === 0 || v.trim() !== '');
export const pat = (re: RegExp, max: number): Rule => (v) => typeof v === 'string' && v.length <= max && re.test(v);
export const oneOf = (...vals: string[]): Rule => (v) => typeof v === 'string' && vals.includes(v);
export const bool: Rule = (v) => typeof v === 'boolean';
export const int = (min: number, max: number): Rule => (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
/** DecimalStringPositive: numeric(18,6) as a string; the server also checks > 0. */
export const posDec: Rule = (v) => typeof v === 'string' && /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(v) && /[1-9]/.test(v);

export const ITEM_CODE = /^[A-Z0-9][A-Z0-9_.\-]{0,31}$/;
const UOM = pat(/^[a-z][a-z0-9_]{0,31}$/, 32);
export const CATEGORIES = ['reagent', 'kit', 'consumable', 'control', 'calibrator', 'other'];
export const UNSET_FIELDS = ['manufacturer', 'catalogue_no', 'storage_condition', 'open_stability_days', 'container_qty_base', 'hs_code', 'default_tax_code', 'notes'] as const;
const BARCODE_RAW = /^[\x21-\x7E]{1,64}$/; // checked on the RAW text: 'straße' / 'ıd' upper-case into ASCII and must not sneak past

export function parse(body: unknown, rules: Record<string, Rule>, required: readonly string[] = []): Obj {
  if (!isObj(body)) throw invalid(fieldError('/'));
  const errs: FieldError[] = [];
  const out: Obj = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    const rule = Object.hasOwn(rules, k) ? rules[k] : undefined;
    if (!rule) errs.push(fieldError(pointer(k), 'common.unknown_field'));
    else if (!rule(v)) errs.push(fieldError(pointer(k)));
    else out[k] = v;
  }
  for (const r of required) if (body[r] === undefined) errs.push(fieldError(`/${r}`, 'common.field_required'));
  if (errs.length > 0) throw invalid(...errs);
  return out;
}

/** If-Match: "<version>" (02-CV §4.2). Missing -> 428; malformed -> 400. */
export function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2_147_483_647) throw invalid(fieldError('If-Match'));
  return Number(m[1]);
}

const ITEM_FIELDS: Record<string, Rule> = {
  name: text(1, 200), category: oneOf(...CATEGORIES), manufacturer: text(0, 120), catalogue_no: text(0, 64),
  storage_condition: oneOf('ambient', 'refrigerated', 'frozen', 'other'), open_stability_days: int(1, 3650), container_qty_base: posDec,
  hs_code: pat(/^[0-9]{4,10}$/, 10), default_tax_code: pat(/^[A-Z0-9_]{1,16}$/, 16), notes: text(0, 1000), is_lot_tracked: bool, requires_expiry: bool,
};

/** #2 ItemCreate. [CONV] requires_expiry defaults to is_lot_tracked (the contract default `true` would break items__expiry_requires_lot__ck for a non-lot-tracked item). */
export function parseItemCreate(body: unknown): Obj {
  const o = parse(body, { item_code: pat(ITEM_CODE, 32), base_uom_code: UOM, ...ITEM_FIELDS }, ['item_code', 'name', 'category', 'base_uom_code']);
  o['is_lot_tracked'] ??= true;
  o['requires_expiry'] ??= o['is_lot_tracked'];
  if (o['requires_expiry'] === true && o['is_lot_tracked'] === false) throw invalid(fieldError('/requires_expiry'));
  return o;
}

export interface ItemPatchInput { readonly set: Obj; readonly unset: readonly string[] }
/** #4 ItemPatch + unset[]. `base_uom_code` is accepted here (PRD AC-01.5: the service answers 409 when locked; contract ItemPatch lacks it, see .orchestra/notes/C12.T-07-impl.md). */
export function parseItemPatch(body: unknown): ItemPatchInput {
  const unsetRule: Rule = (v) => Array.isArray(v) && v.length <= 8 && new Set(v).size === v.length && v.every((x) => typeof x === 'string' && (UNSET_FIELDS as readonly string[]).includes(x));
  const { unset = [], ...set } = parse(body, { ...ITEM_FIELDS, base_uom_code: UOM, unset: unsetRule });
  const clash = (unset as string[]).filter((f) => f in set);
  if (clash.length > 0) throw invalid(...clash.map((f) => fieldError(`/${f}`)));
  if (Object.keys(set).length + (unset as string[]).length === 0) throw invalid(fieldError('/'));
  return { set, unset };
}

export const parseActive = (body: unknown): boolean => parse(body, { is_active: bool }, ['is_active'])['is_active'];

/** #6 pack create. */
export const parsePackCreate = (body: unknown): Obj =>
  parse(body, { pack_code: pat(/^[A-Z0-9_]{1,16}$/, 16), label: text(1, 60), uom_code: UOM, qty_in_base: posDec, is_purchase_default: bool }, ['pack_code', 'label', 'uom_code', 'qty_in_base']);

/** #7 pack patch: qty_in_base (the size) is NOT in the schema -> 400 (AC-02.2 layer 1). */
export function parsePackPatch(body: unknown): Obj {
  const o = parse(body, { label: text(1, 60), uom_code: UOM, is_purchase_default: bool, is_active: bool });
  if (Object.keys(o).length === 0) throw invalid(fieldError('/'));
  return o;
}

/** #8: raw value must be printable ASCII (1-64); the stored / compared value is its upper case. */
export function parseBarcodeAdd(body: unknown): { barcode_value: string; pack_id?: string } {
  const o = parse(body, { barcode_value: pat(BARCODE_RAW, 64), pack_id: isUuid }, ['barcode_value']);
  return { barcode_value: String(o['barcode_value']).toUpperCase(), ...(o['pack_id'] === undefined ? {} : { pack_id: o['pack_id'] as string }) };
}
export const parseBarcodeLookup = (body: unknown): string => String(parse(body, { barcode_value: pat(BARCODE_RAW, 64) }, ['barcode_value'])['barcode_value']).toUpperCase();

export type ItemSort = 'item_code' | 'name' | '-updated_at';
export interface ListQuery { category?: string; is_active?: boolean; q?: string; sort: ItemSort; cursor?: string; limit: number }
/** #1 query: only the contract parameters; `barcode` is not one of them (use #10). Values arrive typed from the pipeline. */
export function parseListQuery(query: unknown): ListQuery {
  const o = parse(query ?? {}, {
    category: oneOf(...CATEGORIES), is_active: bool, q: text(0, 60), sort: oneOf('item_code', 'name', '-updated_at'),
    cursor: pat(/^[A-Za-z0-9_-]+$/, 512), limit: int(1, 200),
  });
  return {
    ...(o['category'] === undefined ? {} : { category: o['category'] }),
    ...(o['is_active'] === undefined ? {} : { is_active: o['is_active'] }),
    ...(o['q'] === undefined || o['q'] === '' ? {} : { q: o['q'] }),
    sort: o['sort'] ?? 'item_code',
    ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] }),
    limit: o['limit'] ?? 50,
  };
}
