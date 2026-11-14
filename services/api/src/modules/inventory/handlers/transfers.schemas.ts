// C12.T-13 request validation for #56-#62 (contracts/openapi/inventory.yaml; 02-TRD §5.5). Strict like items.schemas.ts: unknown key -> 400 common.validation_failed, runs before any DB access.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isUuid } from '../repository/_base.js';
import { fieldError, int, invalid, oneOf, parse, pat, posDec, text, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const MAX_LINES = 200;
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
/** received_qty_base: numeric(18,6) >= 0 as a string (0 = everything lost in transit, 03-APP-FLOW §3.3). */
const nnDec: Rule = (v) => typeof v === 'string' && /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(v);
const reason = pat(/^[a-z0-9_]{1,32}$/, 32);

export interface TransferListQuery extends PageQuery { from_store_id?: string; to_store_id?: string; status?: string }
export function parseTransferList(query: unknown): TransferListQuery {
  const o = parse(query ?? {}, { from_store_id: isUuid, to_store_id: isUuid, status: oneOf('draft', 'dispatched', 'received', 'cancelled'), cursor, limit: int(1, 200) });
  return {
    limit: (o['limit'] as number | undefined) ?? 50,
    ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] as string }),
    ...(o['from_store_id'] === undefined ? {} : { from_store_id: o['from_store_id'] as string }),
    ...(o['to_store_id'] === undefined ? {} : { to_store_id: o['to_store_id'] as string }),
    ...(o['status'] === undefined ? {} : { status: o['status'] as string }),
  };
}

/** Run `parse` on element i of `path` and re-root its field errors at /<path>/<i>/... */
function parseAt<T extends Obj>(item: unknown, path: string, i: number, rules: Record<string, Rule>, required: readonly string[]): T {
  try { return parse(item, rules, required) as T; } catch (e) {
    if (e instanceof LimsError && e.errors) {
      throw invalid(...e.errors.map((f: FieldError) => ({ ...f, path: `/${path}/${i}${f.path === '/' ? '' : f.path}` })));
    }
    throw e;
  }
}
function arrayOf<T extends Obj>(v: unknown, path: string, rules: Record<string, Rule>, required: readonly string[]): T[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_LINES) throw invalid(fieldError(`/${path}`));
  return v.map((x, i) => parseAt<T>(x, path, i, rules, required));
}

export interface TransferLineInput { item_id: string; lot_id?: string; qty: string; pack_id?: string }
export interface TransferDraftInput { notes?: string; lines: TransferLineInput[] }
export interface TransferCreateInput extends TransferDraftInput { from_store_id: string; to_store_id: string }
const LINE_RULES: Record<string, Rule> = { item_id: isUuid, lot_id: isUuid, qty: posDec, pack_id: isUuid };
const draftOf = (o: Obj): TransferDraftInput => ({ ...(o['notes'] === undefined ? {} : { notes: o['notes'] as string }), lines: arrayOf<TransferLineInput & Obj>(o['lines'], 'lines', LINE_RULES, ['item_id', 'qty']) });

/** #57. A transfer between a store and itself is refused here (the DB CHECK is never the first line of defence). */
export function parseTransferCreate(body: unknown): TransferCreateInput {
  const o = parse(body, { from_store_id: isUuid, to_store_id: isUuid, notes: text(0, 1000), lines: (v) => Array.isArray(v) }, ['from_store_id', 'to_store_id', 'lines']);
  if (o['from_store_id'] === o['to_store_id']) throw invalid(fieldError('/to_store_id'));
  return { from_store_id: o['from_store_id'], to_store_id: o['to_store_id'], ...draftOf(o) };
}

/** #59: as create minus the stores (a draft cannot change its stores). */
export const parseTransferReplace = (body: unknown): TransferDraftInput => draftOf(parse(body, { notes: text(0, 1000), lines: (v) => Array.isArray(v) }, ['lines']));

/** #60 takes no body: anything with a key is refused. */
export const parseDispatch = (body: unknown): void => { if (body !== undefined && body !== null) parse(body, {}); };

export interface ReceiveLineInput { line_id: string; received_qty_base: string; discrepancy_reason_code?: string }
export function parseReceive(body: unknown): { lines: ReceiveLineInput[] } {
  const o = parse(body, { lines: (v) => Array.isArray(v) }, ['lines']);
  const lines = arrayOf<ReceiveLineInput & Obj>(o['lines'], 'lines', { line_id: isUuid, received_qty_base: nnDec, discrepancy_reason_code: reason }, ['line_id', 'received_qty_base']);
  const seen = new Set<string>();
  lines.forEach((l, i) => { if (seen.has(l.line_id)) throw invalid(fieldError(`/lines/${i}/line_id`)); seen.add(l.line_id); });
  return { lines };
}

export const parseCancel = (body: unknown): { reason_text: string } => ({ reason_text: parse(body, { reason_text: text(1, 500) }, ['reason_text'])['reason_text'] });
