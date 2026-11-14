// C12.T-10 request validation for #40-#48 (contracts/openapi/inventory.yaml; 02-TRD §5.2 #40, §5.3 #41-#48). Strict like items.schemas.ts: unknown key -> 400, runs before any DB access.
// reason_code is NOT required here: an omitted code is 422 inventory.reason_required (AC-11.1, decided in the service); a MALFORMED code is 400.
import { LimsError } from '../../../core/errors.js';
import { isUuid } from '../repository/_base.js';
import { fieldError, int, invalid, oneOf, parse, pat, posDec, text, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const instant: Rule = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const reasonCode = pat(/^[a-z0-9_]{1,32}$/, 32);
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
const linesRule: Rule = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 200;
export const DOC_KINDS = ['issue', 'return_to_store', 'supplier_return', 'wastage', 'adjustment', 'expiry_writeoff'] as const;

export interface DocLineInput { item_id: string; lot_id?: string; qty: string; pack_id?: string; direction?: 'in' | 'out'; reason_code?: string }
export interface DocInput {
  store_id: string; occurred_at?: string; reason_code?: string; reason_text?: string; issued_to_kind?: string; department_id?: string; instrument_id?: string;
  supplier_id?: string; grn_id?: string; lines: DocLineInput[];
}

/** Each line is checked on its own so the 400 names the line (/lines/3/qty). */
function parseLines(v: unknown, rules: Record<string, Rule>, required: readonly string[]): DocLineInput[] {
  return (v as unknown[]).map((l, i) => {
    try { return parse(l, rules, required) as unknown as DocLineInput; } catch (e) {
      if (e instanceof LimsError && e.errors !== undefined) throw invalid(...e.errors.map((x) => ({ ...x, path: `/lines/${i}${x.path === '/' ? '' : x.path}` })));
      throw e;
    }
  });
}
const LINE: Record<string, Rule> = { item_id: isUuid, lot_id: isUuid, qty: posDec, pack_id: isUuid };
// occurred_at is NOT in the shared head: #45 supplier return has none in the contract (additionalProperties: false; 02-TRD §5.3) - T-10 review item 2.
const build = (body: unknown, head: Record<string, Rule>, required: readonly string[], line: Record<string, Rule>, lineRequired: readonly string[]): DocInput => {
  const o = parse(body, { store_id: isUuid, reason_text: text(0, 500), ...head, lines: linesRule }, ['store_id', 'lines', ...required]);
  return { ...o, lines: parseLines(o['lines'], line, lineRequired) } as DocInput;
};
const needs = (cond: boolean, path: string): void => { if (cond) throw invalid(fieldError(path, 'common.field_required')); };

/** #43: the target kind decides which id is needed (the DB CHECK is not the first line of defence). */
export function parseIssue(body: unknown): DocInput {
  const d = build(body, { occurred_at: instant, issued_to_kind: oneOf('department', 'instrument', 'general'), department_id: isUuid, instrument_id: isUuid }, ['issued_to_kind'], LINE, ['item_id', 'qty']);
  needs(d.issued_to_kind === 'department' && d.department_id === undefined, '/department_id');
  needs(d.issued_to_kind === 'instrument' && d.instrument_id === undefined, '/instrument_id');
  return d;
}
export const parseStoreReturn = (body: unknown): DocInput => build(body, { occurred_at: instant }, [], LINE, ['item_id', 'qty']);
export const parseSupplierReturn = (body: unknown): DocInput => build(body, { supplier_id: isUuid, grn_id: isUuid, reason_code: reasonCode }, ['supplier_id'], LINE, ['item_id', 'lot_id', 'qty']);
export const parseWastage = (body: unknown): DocInput => build(body, { occurred_at: instant, reason_code: reasonCode }, [], { ...LINE, reason_code: reasonCode }, ['item_id', 'qty']);
export const parseAdjustment = (body: unknown): DocInput =>
  build(body, { occurred_at: instant, reason_code: reasonCode }, [], { ...LINE, direction: oneOf('in', 'out') }, ['item_id', 'direction', 'qty']);

export interface WriteOffInput { store_id: string; lot_ids: string[] }
/** #47: the server reads the full balance; the same lot twice would write it off twice -> 400. */
export const parseWriteOff = (body: unknown): WriteOffInput => {
  const ids: Rule = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every(isUuid) && new Set(v).size === v.length;
  const o = parse(body, { store_id: isUuid, lot_ids: ids }, ['store_id', 'lot_ids']);
  return { store_id: o['store_id'], lot_ids: o['lot_ids'] };
};

export interface DiscardInput { qty_base: string; reason_code?: string; reason_text?: string }
export const parseDiscard = (body: unknown): DiscardInput => {
  const o = parse(body, { qty_base: posDec, reason_code: reasonCode, reason_text: text(0, 500) }, ['qty_base']);
  return { qty_base: o['qty_base'], ...(o['reason_code'] === undefined ? {} : { reason_code: o['reason_code'] }), ...(o['reason_text'] === undefined ? {} : { reason_text: o['reason_text'] }) };
};

export interface DocListQuery extends PageQuery { store_id?: string; doc_kind?: string; occurred_at_from?: string; occurred_at_to?: string }
export function parseDocList(query: unknown): DocListQuery {
  const o: Obj = parse(query ?? {}, { store_id: isUuid, doc_kind: oneOf(...DOC_KINDS), occurred_at_from: instant, occurred_at_to: instant, cursor, limit: int(1, 200) });
  const keep = (['store_id', 'doc_kind', 'occurred_at_from', 'occurred_at_to', 'cursor'] as const).filter((k) => o[k] !== undefined).map((k) => [k, o[k]]);
  return { ...Object.fromEntries(keep), limit: o['limit'] ?? 50 } as DocListQuery;
}
