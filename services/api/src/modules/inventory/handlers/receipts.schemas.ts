// C12.T-12 request validation for #49-#55 (contracts/openapi/inventory.yaml; 02-TRD §5.4, §4.2). Strict like purchasing.schemas.ts: unknown key -> 400 common.validation_failed, runs before any DB access.
// Server-authority fields (grn_no, status, totals, tax_rate_bp, qty_base, lot_id, capitalised_value_paisa, ...) are not in any schema, so a client-sent value is refused (AC-06.1).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isValidYmd } from '../domain/ymd.js';
import { isUuid } from '../repository/_base.js';
import { bool, fieldError, int, invalid, oneOf, parse, pat, text, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';
import { isoUtc, packsQty, paisa, taxCode } from './purchasing.schemas.js';

const MAX_LINES = 200;
const MAX_RANGE_MS = 366 * 86_400_000; // #55: posted_at range <= 366 days
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
const lotNo = pat(/^[\x21-\x7E]{1,64}$/, 64); // lots__ck
export const GRN_STATUSES = ['draft', 'posted', 'cancelled'] as const;

export interface GrnListQuery extends PageQuery { store_id?: string; status?: string; supplier_id?: string; po_id?: string; received_at_from?: string; received_at_to?: string }
export function parseGrnList(query: unknown): GrnListQuery {
  const o = parse(query ?? {}, { store_id: isUuid, status: oneOf(...GRN_STATUSES), supplier_id: isUuid, po_id: isUuid, received_at_from: isoUtc, received_at_to: isoUtc, cursor, limit: int(1, 200) });
  const out: GrnListQuery = { limit: (o['limit'] as number | undefined) ?? 50 };
  for (const k of ['cursor', 'store_id', 'status', 'supplier_id', 'po_id', 'received_at_from', 'received_at_to'] as const) if (o[k] !== undefined) out[k] = o[k] as string;
  return out;
}

export interface GrnLineInput {
  item_id: string; pack_id: string; qty_packs: string; po_line_id?: string; lot_no?: string; expiry_on?: string; manufactured_on?: string;
  unit_price_paisa?: number; discount_paisa?: number; tax_code?: string; is_exempt: boolean;
}
export interface GrnDraftInput {
  supplier_id?: string; po_id?: string; received_at?: string; supplier_invoice_no?: string; supplier_invoice_on?: string; supplier_invoice_total_paisa?: number; notes?: string; lines: GrnLineInput[];
}
export interface GrnCreateInput extends GrnDraftInput { kind: 'purchase' | 'opening_balance'; store_id: string }

/** Re-root the field errors of one line at /lines/<i>/... */
function parseLine(item: unknown, i: number): GrnLineInput {
  try {
    const o = parse(item, {
      po_line_id: isUuid, item_id: isUuid, pack_id: isUuid, qty_packs: packsQty, lot_no: lotNo, expiry_on: isValidYmd, manufactured_on: isValidYmd,
      unit_price_paisa: paisa, discount_paisa: paisa, tax_code: taxCode, is_exempt: bool,
    }, ['item_id', 'pack_id', 'qty_packs']);
    if (o['is_exempt'] === true && o['tax_code'] !== undefined) throw invalid(fieldError('/tax_code')); // D-70: an exempt line carries no tax code
    return { ...o, is_exempt: o['is_exempt'] === true } as GrnLineInput;
  } catch (e) {
    if (e instanceof LimsError && e.errors) throw invalid(...e.errors.map((f: FieldError) => ({ ...f, path: `/lines/${i}${f.path === '/' ? '' : f.path}` })));
    throw e;
  }
}

const DRAFT_RULES: Record<string, Rule> = {
  supplier_id: isUuid, po_id: isUuid, received_at: isoUtc, supplier_invoice_no: text(0, 64), supplier_invoice_on: isValidYmd, supplier_invoice_total_paisa: paisa, notes: text(0, 1000),
  lines: (v) => Array.isArray(v),
};
function draftOf(o: Record<string, any>): GrnDraftInput {
  const lines = o['lines'] as unknown[];
  if (lines.length < 1 || lines.length > MAX_LINES) throw invalid(fieldError('/lines'));
  const out: Record<string, unknown> = {};
  for (const k of ['supplier_id', 'po_id', 'received_at', 'supplier_invoice_no', 'supplier_invoice_on', 'supplier_invoice_total_paisa', 'notes']) if (o[k] !== undefined) out[k] = o[k];
  return { ...out, lines: lines.map(parseLine) } as unknown as GrnDraftInput;
}

/** #50 body: GrnDraft + kind + store_id. */
export function parseGrnCreate(body: unknown): GrnCreateInput {
  const o = parse(body, { ...DRAFT_RULES, kind: oneOf('purchase', 'opening_balance'), store_id: isUuid }, ['kind', 'store_id', 'lines']);
  return { ...draftOf(o), kind: o['kind'], store_id: o['store_id'] };
}
/** #52 body: GrnDraft minus kind and store_id. */
export const parseGrnReplace = (body: unknown): GrnDraftInput => draftOf(parse(body, DRAFT_RULES, ['lines']));

export const parseGrnCancel = (body: unknown): { reason_text: string } => ({ reason_text: parse(body, { reason_text: text(1, 500) }, ['reason_text'])['reason_text'] });

export interface GrnExportQuery { posted_at_from: string; posted_at_to: string; store_id?: string }
export function parseGrnExport(query: unknown): GrnExportQuery {
  const o = parse(query, { posted_at_from: isoUtc, posted_at_to: isoUtc, store_id: isUuid }, ['posted_at_from', 'posted_at_to']);
  const span = Date.parse(o['posted_at_to']) - Date.parse(o['posted_at_from']);
  if (span <= 0 || span > MAX_RANGE_MS) throw invalid(fieldError('/posted_at_to')); // reversed / empty range, or over 366 days
  return { posted_at_from: o['posted_at_from'], posted_at_to: o['posted_at_to'], ...(o['store_id'] === undefined ? {} : { store_id: o['store_id'] }) };
}
