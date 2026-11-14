// C12.T-15 request validation for #69-#79 (contracts/openapi/inventory.yaml; 02-TRD §5.5, §6.1; 05-SCHEMA §2.23 consumption_rules__shape__ck, §2.24).
// Strict like items.schemas.ts: unknown key -> 400 common.validation_failed, runs after the permission gate and before any DB access.
import { isUuid } from '../repository/_base.js';
import { bool, fieldError, int, invalid, oneOf, parse, pat, posDec, text, type Obj, type Rule } from './items.schemas.js';
import type { PageQuery } from './masters.schemas.js';

const RULE_KINDS = ['per_test', 'per_analyte', 'per_rerun', 'per_qc', 'per_calibration', 'per_day'];
const FACT_KINDS = ['test', 'analyte', 'rerun', 'qc', 'calibration', 'fixed'];
const FACT_STATUSES = ['posted', 'no_rule', 'unresolved', 'dismissed', 'reversed'];
const cursor = pat(/^[A-Za-z0-9_-]+$/, 512);
const limit = int(1, 200);
const reason = pat(/^[a-z0-9_]{1,32}$/, 32);
const notes = text(0, 500);
/** IsoUtc: date-time with a literal Z. */
const isoUtc: Rule = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const ymd: Rule = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const pageOf = (o: Obj): PageQuery => ({ ...(o['cursor'] === undefined ? {} : { cursor: o['cursor'] as string }), limit: (o['limit'] as number | undefined) ?? 50 });
const only = <T extends object>(o: Obj, keys: readonly (keyof T & string)[]): Partial<T> => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Partial<T>;

// ---------------------------------------------------------------- #69 / #75 lists
export interface RuleListQuery extends PageQuery { rule_kind?: string; test_id?: string; instrument_id?: string; item_id?: string; current_only: boolean }
export function parseRuleList(query: unknown): RuleListQuery {
  const o = parse(query ?? {}, { rule_kind: oneOf(...RULE_KINDS), test_id: isUuid, instrument_id: isUuid, item_id: isUuid, current_only: bool, cursor, limit });
  return { ...pageOf(o), current_only: (o['current_only'] as boolean | undefined) ?? true, ...only<RuleListQuery>(o, ['rule_kind', 'test_id', 'instrument_id', 'item_id']) };
}

export interface FactListQuery extends PageQuery { status?: string; fact_kind?: string; instrument_id?: string; test_id?: string; business_date_from?: string; business_date_to?: string }
export function parseFactList(query: unknown): FactListQuery {
  const o = parse(query ?? {}, { status: oneOf(...FACT_STATUSES), fact_kind: oneOf(...FACT_KINDS), instrument_id: isUuid, test_id: isUuid, business_date_from: ymd, business_date_to: ymd, cursor, limit });
  return { ...pageOf(o), ...only<FactListQuery>(o, ['status', 'fact_kind', 'instrument_id', 'test_id', 'business_date_from', 'business_date_to']) };
}

// ---------------------------------------------------------------- #70 create (rule shape = consumption_rules__shape__ck)
export interface RuleCreateInput { rule_kind: string; test_id?: string; analyte_id?: string; instrument_id?: string; item_id: string; qty: string; pack_id?: string; notes?: string }
export function parseRuleCreate(body: unknown): RuleCreateInput {
  const o = parse(body, { rule_kind: oneOf(...RULE_KINDS), test_id: isUuid, analyte_id: isUuid, instrument_id: isUuid, item_id: isUuid, qty: posDec, pack_id: isUuid, notes }, ['rule_kind', 'item_id', 'qty']);
  const has = (k: string): boolean => o[k] !== undefined;
  const errs: string[] = [];
  const need = (k: string): void => { if (!has(k)) errs.push(`/${k}`); };
  const forbid = (k: string): void => { if (has(k)) errs.push(`/${k}`); };
  switch (o['rule_kind']) {
    case 'per_test': case 'per_rerun': case 'per_calibration': need('test_id'); forbid('analyte_id'); break;
    case 'per_analyte': need('test_id'); need('analyte_id'); break;
    case 'per_qc': need('test_id'); break; // analyte optional (null = every QC observation of the instrument)
    case 'per_day': need('instrument_id'); forbid('test_id'); forbid('analyte_id'); break;
  }
  if (errs.length > 0) throw invalid(...errs.map((p) => fieldError(p)));
  return { rule_kind: o['rule_kind'], item_id: o['item_id'], qty: o['qty'], ...only<RuleCreateInput>(o, ['test_id', 'analyte_id', 'instrument_id', 'pack_id', 'notes']) };
}

// ---------------------------------------------------------------- #72 supersede / #73 deactivate
export interface RuleSupersedeInput { qty: string; pack_id?: string; notes?: string }
export function parseRuleSupersede(body: unknown): RuleSupersedeInput {
  const o = parse(body, { qty: posDec, pack_id: isUuid, notes }, ['qty']);
  return { qty: o['qty'], ...only<RuleSupersedeInput>(o, ['pack_id', 'notes']) };
}
/** #73 takes no body: anything with a key is refused. */
export const parseRuleDeactivate = (body: unknown): void => { if (body !== undefined && body !== null) parse(body, {}); };

// ---------------------------------------------------------------- #74 preview
export interface PreviewInput { fact_kind: string; test_id?: string; analyte_id?: string; instrument_id?: string; at?: string }
export function parsePreview(body: unknown): PreviewInput {
  const o = parse(body, { fact_kind: oneOf(...FACT_KINDS), test_id: isUuid, analyte_id: isUuid, instrument_id: isUuid, at: isoUtc }, ['fact_kind']);
  return { fact_kind: o['fact_kind'], ...only<PreviewInput>(o, ['test_id', 'analyte_id', 'instrument_id', 'at']) };
}

// ---------------------------------------------------------------- #76 manual log
export interface LogEventInput { fact_kind: 'calibration' | 'qc'; instrument_id?: string; test_id: string; analyte_id?: string; occurred_at: string; observations?: number; reason_code?: string; note?: string }
export function parseLogEvent(body: unknown): LogEventInput {
  const o = parse(body, { fact_kind: oneOf('calibration', 'qc'), instrument_id: isUuid, test_id: isUuid, analyte_id: isUuid, occurred_at: isoUtc, observations: int(1, 50), reason_code: reason, note: text(0, 500) },
    ['fact_kind', 'test_id', 'occurred_at']);
  if (o['fact_kind'] === 'calibration') {
    if (o['reason_code'] === undefined) throw invalid(fieldError('/reason_code', 'common.field_required'));
    if (o['observations'] !== undefined) throw invalid(fieldError('/observations'));
  }
  return { fact_kind: o['fact_kind'], test_id: o['test_id'], occurred_at: o['occurred_at'], ...only<LogEventInput>(o, ['instrument_id', 'analyte_id', 'observations', 'reason_code', 'note']) };
}

// ---------------------------------------------------------------- #77 / #78 / #79
export const parseResolve = (body: unknown): string => String(parse(body, { store_id: isUuid }, ['store_id'])['store_id']);
export const parseReason = (body: unknown): string => String(parse(body, { reason_code: reason }, ['reason_code'])['reason_code']);
