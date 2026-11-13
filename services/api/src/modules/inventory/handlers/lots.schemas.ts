// C12.T-09 request validation for #30-#39 (contracts/openapi/inventory.yaml; 02-TRD §5.2). Strict like items.schemas.ts: unknown key -> 400, runs before any DB access.
// Query values arrive typed (numbers, booleans); a csv (#35 movement_kind) is a string.
import { isValidYmd } from '../domain/ymd.js';
import { isUuid } from '../repository/_base.js';
import { bool, CATEGORIES, int, oneOf, parse, pat, posDec, text, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
const limit = int(1, 200);
const ymd: Rule = isValidYmd;
/** ISO-8601 UTC instant, e.g. 2026-11-13T04:15:00.000Z (offsets are not accepted: the wire carries UTC only). */
const instant: Rule = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const reasonCode = pat(/^[a-z0-9_]{1,32}$/, 32);
const pageOf = (o: Obj): PageQuery => ({ ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] as string }), limit: (o['limit'] as number | undefined) ?? 50 });
const MOVEMENT_KINDS = ['receive', 'opening_balance', 'supplier_return', 'issue', 'return_to_store', 'transfer_out', 'transfer_in', 'consume_test', 'consume_analyte', 'consume_rerun', 'consume_qc',
  'consume_calibration', 'consume_fixed', 'consume_reversal', 'wastage', 'expiry_writeoff', 'adjust_in', 'adjust_out', 'count_adjust_in', 'count_adjust_out'];
const DOC_TYPES = ['goods_receipt', 'stock_document', 'transfer', 'stock_count', 'consumption_fact'];
const csvOf = (allowed: readonly string[]): Rule => (v) => typeof v === 'string' && v.length <= 400 && v.split(',').every((k) => allowed.includes(k));
const only = <T extends Obj>(o: Obj, keys: readonly string[]): T => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as T;

export interface LotListQuery extends PageQuery { item_id: string; status?: string; expiring_before?: string }
export function parseLotList(query: unknown): LotListQuery {
  const o = parse(query ?? {}, { item_id: isUuid, status: oneOf('available', 'quarantined', 'blocked'), expiring_before: ymd, cursor, limit }, ['item_id']);
  return { ...pageOf(o), ...only<Obj>(o, ['item_id', 'status', 'expiring_before']) } as LotListQuery;
}

export interface LotStatusInput { status: string; reason_code: string }
export const parseLotStatus = (body: unknown): LotStatusInput =>
  only<LotStatusInput>(parse(body, { status: oneOf('available', 'quarantined', 'blocked'), reason_code: reasonCode }, ['status', 'reason_code']), ['status', 'reason_code']);

export interface LotExpiryInput { expiry_on: string; reason_code: string }
export const parseLotExpiry = (body: unknown): LotExpiryInput =>
  only<LotExpiryInput>(parse(body, { expiry_on: ymd, reason_code: reasonCode }, ['expiry_on', 'reason_code']), ['expiry_on', 'reason_code']);

export interface BalanceQuery extends PageQuery {
  store_id?: string; item_id?: string; category?: string; below_reorder: boolean; expiring_within_days?: number; expired_only: boolean; include_zero: boolean;
}
export function parseBalanceQuery(query: unknown): BalanceQuery {
  const o = parse(query ?? {}, {
    store_id: isUuid, item_id: isUuid, category: oneOf(...CATEGORIES), below_reorder: bool, expiring_within_days: int(1, 365), expired_only: bool, include_zero: bool, cursor, limit,
  });
  return { ...pageOf(o), ...only<Obj>(o, ['store_id', 'item_id', 'category', 'expiring_within_days']), below_reorder: o['below_reorder'] ?? false, expired_only: o['expired_only'] ?? false, include_zero: o['include_zero'] ?? false } as BalanceQuery;
}

export interface MovementQuery extends PageQuery {
  store_id?: string; item_id?: string; lot_id?: string; movement_kind?: string[]; occurred_at_from?: string; occurred_at_to?: string; doc_type?: string; doc_id?: string; instrument_id?: string; attributed_test_id?: string;
}
export function parseMovementQuery(query: unknown): MovementQuery {
  const o = parse(query ?? {}, {
    store_id: isUuid, item_id: isUuid, lot_id: isUuid, movement_kind: csvOf(MOVEMENT_KINDS), occurred_at_from: instant, occurred_at_to: instant, doc_type: oneOf(...DOC_TYPES), doc_id: isUuid,
    instrument_id: isUuid, attributed_test_id: isUuid, sort: oneOf('-occurred_at'), cursor, limit,
  });
  return { ...pageOf(o), ...only<Obj>(o, ['store_id', 'item_id', 'lot_id', 'occurred_at_from', 'occurred_at_to', 'doc_type', 'doc_id', 'instrument_id', 'attributed_test_id']),
    ...(o['movement_kind'] === undefined ? {} : { movement_kind: (o['movement_kind'] as string).split(',') }) } as MovementQuery;
}

export interface FefoQuery { store_id: string; item_id: string; qty_base: string }
export const parseFefoQuery = (query: unknown): FefoQuery =>
  only<FefoQuery>(parse(query ?? {}, { store_id: isUuid, item_id: isUuid, qty_base: posDec }, ['store_id', 'item_id', 'qty_base']), ['store_id', 'item_id', 'qty_base']);

export interface ContainerListQuery extends PageQuery { store_id: string; instrument_id?: string; status: string }
export function parseContainerList(query: unknown): ContainerListQuery {
  const o = parse(query ?? {}, { store_id: isUuid, instrument_id: isUuid, status: oneOf('open', 'finished', 'discarded'), cursor, limit }, ['store_id']);
  return { ...pageOf(o), ...only<Obj>(o, ['store_id', 'instrument_id']), status: o['status'] ?? 'open' } as ContainerListQuery;
}

export interface ContainerOpenInput { store_id: string; item_id: string; lot_id?: string; instrument_id?: string; opened_at?: string; notes?: string }
/** #38: server authority (CV §4.7): status, open_expiry_at, opened_by, version, finished_* are not accepted. */
export const parseContainerOpen = (body: unknown): ContainerOpenInput => {
  const o = parse(body, { store_id: isUuid, item_id: isUuid, lot_id: isUuid, instrument_id: isUuid, opened_at: instant, notes: text(0, 500) }, ['store_id', 'item_id']);
  return only<ContainerOpenInput>(o, ['store_id', 'item_id', 'lot_id', 'instrument_id', 'opened_at', 'notes']);
};

export interface ContainerFinishInput { finished_at?: string }
export const parseContainerFinish = (body: unknown): ContainerFinishInput => only<ContainerFinishInput>(parse(body ?? {}, { finished_at: instant }), ['finished_at']);
