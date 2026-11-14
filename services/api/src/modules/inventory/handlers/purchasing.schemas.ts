// C12.T-11 request validation for #80-#88 (contracts/openapi/inventory.yaml; 02-TRD §5.5, §4.2). Strict like items.schemas.ts: unknown key -> 400 common.validation_failed, runs before any DB access.
// Server-authority fields (totals, status, po_no, tax_rate_bp, qty_base, ...) are simply not in the schemas, so a client-sent total is refused (AC-05.1).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isValidYmd } from '../domain/ymd.js';
import { isUuid } from '../repository/_base.js';
import { bool, fieldError, int, invalid, oneOf, parse, pat, text, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const MAX_LINES = 200;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
export const isoUtc: Rule = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
/** DecimalStringPacks: numeric(12,3) as a string, > 0. */
export const packsQty: Rule = (v) => typeof v === 'string' && /^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(v) && /[1-9]/.test(v);
export const paisa = int(0, MAX_SAFE);
export const taxCode = pat(/^[A-Z0-9_]{1,16}$/, 16);
const reasonCode = pat(/^[a-z][a-z0-9_]{0,31}$/, 32);
export const PO_STATUSES = ['draft', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled'] as const;

export interface PoListQuery extends PageQuery { status?: string; supplier_id?: string; branch_id?: string; created_at_from?: string; created_at_to?: string }
export function parsePoList(query: unknown): PoListQuery {
  const o = parse(query ?? {}, { status: oneOf(...PO_STATUSES), supplier_id: isUuid, branch_id: isUuid, created_at_from: isoUtc, created_at_to: isoUtc, cursor, limit: int(1, 200) });
  const out: PoListQuery = { limit: (o['limit'] as number | undefined) ?? 50 };
  for (const k of ['cursor', 'status', 'supplier_id', 'branch_id', 'created_at_from', 'created_at_to'] as const) if (o[k] !== undefined) out[k] = o[k] as string;
  return out;
}

export interface PoLineInput { item_id: string; pack_id: string; qty_packs: string; unit_price_paisa?: number; discount_paisa?: number; tax_code?: string; is_exempt: boolean }
export interface PoDraftInput { supplier_id: string; store_id: string; expected_on?: string; notes?: string; lines: PoLineInput[] }

/** Re-root the field errors of one line at /lines/<i>/... */
function parseLine(item: unknown, i: number): PoLineInput {
  try {
    const o = parse(item, { item_id: isUuid, pack_id: isUuid, qty_packs: packsQty, unit_price_paisa: paisa, discount_paisa: paisa, tax_code: taxCode, is_exempt: bool }, ['item_id', 'pack_id', 'qty_packs']);
    if (o['is_exempt'] === true && o['tax_code'] !== undefined) throw invalid(fieldError('/tax_code')); // D-70: an exempt line carries no tax code
    return { ...o, is_exempt: o['is_exempt'] === true } as PoLineInput;
  } catch (e) {
    if (e instanceof LimsError && e.errors) throw invalid(...e.errors.map((f: FieldError) => ({ ...f, path: `/lines/${i}${f.path === '/' ? '' : f.path}` })));
    throw e;
  }
}

/** #81 / #83 body (the same shape: a draft may change its store and supplier). */
export function parsePoDraft(body: unknown): PoDraftInput {
  const o = parse(body, { supplier_id: isUuid, store_id: isUuid, expected_on: isValidYmd, notes: text(0, 1000), lines: (v) => Array.isArray(v) }, ['supplier_id', 'store_id', 'lines']);
  const lines = o['lines'] as unknown[];
  if (lines.length < 1 || lines.length > MAX_LINES) throw invalid(fieldError('/lines'));
  return { supplier_id: o['supplier_id'], store_id: o['store_id'], ...(o['expected_on'] === undefined ? {} : { expected_on: o['expected_on'] }), ...(o['notes'] === undefined ? {} : { notes: o['notes'] }), lines: lines.map(parseLine) };
}

/** #84 takes no body: anything with a key is refused. */
export const parseNoBody = (body: unknown): void => { if (body !== undefined && body !== null) parse(body, {}); };

export interface SentInput { sent_channel: string; sent_reference?: string }
export function parseSent(body: unknown): SentInput {
  const o = parse(body, { sent_channel: oneOf('email', 'phone', 'in_person', 'portal', 'other'), sent_reference: text(0, 120) }, ['sent_channel']);
  return { sent_channel: o['sent_channel'], ...(o['sent_reference'] === undefined ? {} : { sent_reference: o['sent_reference'] }) };
}

export interface ReasonInput { reason_code?: string; reason_text?: string }
const reasonOf = (o: Obj): ReasonInput => ({ ...(o['reason_code'] === undefined ? {} : { reason_code: o['reason_code'] }), ...(o['reason_text'] === undefined ? {} : { reason_text: o['reason_text'] }) });
/** #86: the reason code is required. */
export const parseCancel = (body: unknown): ReasonInput & { reason_code: string } => reasonOf(parse(body, { reason_code: reasonCode, reason_text: text(0, 500) }, ['reason_code'])) as ReasonInput & { reason_code: string };
/** #87: the reason is required only when open quantity > 0 (a row-dependent rule, checked in the service). */
export const parseClose = (body: unknown): ReasonInput => reasonOf(parse(body, { reason_code: reasonCode, reason_text: text(0, 500) }));

export interface ReorderInput { store_id: string; item_ids?: string[] }
export function parseReorder(body: unknown): ReorderInput {
  const o = parse(body, { store_id: isUuid, item_ids: (v) => Array.isArray(v) && v.length <= MAX_LINES && v.every(isUuid) }, ['store_id']);
  return { store_id: o['store_id'], ...(o['item_ids'] === undefined ? {} : { item_ids: o['item_ids'] }) };
}
