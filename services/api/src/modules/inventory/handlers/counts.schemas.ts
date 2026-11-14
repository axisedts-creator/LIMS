// C12.T-14 request validation for #63-#68 (contracts/openapi/inventory.yaml; 02-TRD §5.6). Strict like items.schemas.ts: unknown key -> 400 common.validation_failed, runs before any DB access.
import { isUuid } from '../repository/_base.js';
import { CATEGORIES, fieldError, int, invalid, oneOf, parse, pat, text, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const MAX_LINES = 200;
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
/** counted_qty_base: numeric(18,6) >= 0 as a string ("0" = nothing on the shelf). */
const nnDec: Rule = (v) => typeof v === 'string' && /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(v);
/** IsoUtc: date-time with a literal Z. */
const isoUtc: Rule = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const reason = pat(/^[a-z0-9_]{1,32}$/, 32);
const pageOf = (o: Obj, dflt: number): PageQuery => ({ limit: (o['limit'] as number | undefined) ?? dflt, ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] as string }) });

export interface CountListQuery extends PageQuery { store_id?: string; status?: string }
export function parseCountList(query: unknown): CountListQuery {
  const o = parse(query ?? {}, { store_id: isUuid, status: oneOf('open', 'posted', 'cancelled'), cursor, limit: int(1, 200) });
  return { ...pageOf(o, 50), ...(o['store_id'] === undefined ? {} : { store_id: o['store_id'] as string }), ...(o['status'] === undefined ? {} : { status: o['status'] as string }) };
}

/** #65: limit / cursor page the LINES (default and maximum page = 200 = Count.lines maxItems). */
export const parseCountGet = (query: unknown): PageQuery => pageOf(parse(query ?? {}, { cursor, limit: int(1, 200) }), 200);

export interface CountOpenInput { store_id: string; scope_category?: string; notes?: string }
export function parseCountOpen(body: unknown): CountOpenInput {
  const o = parse(body, { store_id: isUuid, scope_category: oneOf(...CATEGORIES), notes: text(0, 1000) }, ['store_id']);
  return { store_id: o['store_id'], ...(o['scope_category'] === undefined ? {} : { scope_category: o['scope_category'] }), ...(o['notes'] === undefined ? {} : { notes: o['notes'] }) };
}

export interface CountLineInput { line_id?: string; item_id: string; lot_id?: string; counted_qty_base: string; counted_at?: string; reason_code?: string }
export function parseCountRecord(body: unknown): { lines: CountLineInput[] } {
  const o = parse(body, { lines: (v) => Array.isArray(v) }, ['lines']);
  const raw = o['lines'] as unknown[];
  if (raw.length < 1 || raw.length > MAX_LINES) throw invalid(fieldError('/lines'));
  const rules: Record<string, Rule> = { line_id: isUuid, item_id: isUuid, lot_id: isUuid, counted_qty_base: nnDec, counted_at: isoUtc, reason_code: reason };
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const lines = raw.map((x, i) => {
    let l: Obj;
    try { l = parse(x, rules, ['item_id', 'counted_qty_base']); } catch (e) {
      const errs = (e as { errors?: { path: string; code: string; message: string }[] }).errors;
      if (errs) throw invalid(...errs.map((f) => ({ ...f, path: `/lines/${i}${f.path === '/' ? '' : f.path}` }) as ReturnType<typeof fieldError>));
      throw e;
    }
    const pair = `${l['item_id']}|${l['lot_id'] ?? ''}`;
    if (pairs.has(pair)) throw invalid(fieldError(`/lines/${i}/item_id`));
    pairs.add(pair);
    if (l['line_id'] !== undefined) { if (ids.has(l['line_id'])) throw invalid(fieldError(`/lines/${i}/line_id`)); ids.add(l['line_id']); }
    return l as CountLineInput;
  });
  return { lines };
}

export const parseCountPost = (body: unknown): { uncounted_policy: 'skip' | 'zero' } =>
  ({ uncounted_policy: parse(body, { uncounted_policy: oneOf('skip', 'zero') }, ['uncounted_policy'])['uncounted_policy'] });

/** #68 takes no body: anything with a key is refused. */
export const parseCountCancel = (body: unknown): void => { if (body !== undefined && body !== null) parse(body, {}); };
