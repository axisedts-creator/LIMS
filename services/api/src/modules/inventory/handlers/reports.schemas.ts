// C12.T-19 request validation for #92 / #93 (contracts/openapi/inventory.yaml getInventoryReport; 02-TRD §5.5, 07-SECURITY abuse controls). Strict: an unknown key, a bad uuid / date / integer -> 400
// common.validation_failed before any DB access; the date range cap is checked afterwards (422 inventory.range_too_large, CR-C12-003) with the cap read at call time (config.ts).
import { LimsError } from '../../../core/errors.js';
import { loadInventoryConfig } from '../config.js';
import { isValidYmd } from '../domain/ymd.js';
import { isUuid } from '../repository/_base.js';
import { fieldError, int, invalid, parse, pat } from './items.schemas.js';

export const REPORT_CODES = ['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'expiry', 'stock_valuation', 'consumption_reconciliation'] as const;
export type ReportCode = (typeof REPORT_CODES)[number];
/** Reports over a business-date window (the other two are "as of now / as_of"). */
export const WINDOWED: ReadonlySet<string> = new Set(['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'consumption_reconciliation']);

export interface ReportQuery {
  business_date_from?: string; business_date_to?: string; store_id?: string; branch_id?: string; instrument_id?: string; test_id?: string; item_id?: string; as_of?: string; within_days?: number; group_by?: string;
}

export function parseReportCode(params: unknown): ReportCode {
  const v = typeof params === 'object' && params !== null ? (params as Record<string, unknown>)['report_code'] : undefined;
  if (typeof v !== 'string' || !(REPORT_CODES as readonly string[]).includes(v)) throw invalid(fieldError('/report_code'));
  return v as ReportCode;
}

/** [CONV] `group_by` is pattern-checked like the contract; the TRD enumerates no per-report value, so every value is refused (400 /group_by) until one is specified. */
export function parseReportQuery(code: ReportCode, query: unknown): ReportQuery {
  const o = parse(query ?? {}, {
    business_date_from: isValidYmd, business_date_to: isValidYmd, store_id: isUuid, branch_id: isUuid, instrument_id: isUuid, test_id: isUuid, item_id: isUuid, as_of: isValidYmd,
    within_days: int(1, 365), group_by: pat(/^[a-z][a-z0-9_]{0,31}$/, 32),
  }, WINDOWED.has(code) ? ['business_date_from', 'business_date_to'] : []);
  if (o['group_by'] !== undefined) throw invalid(fieldError('/group_by'));
  if (o['business_date_from'] !== undefined && o['business_date_to'] !== undefined && o['business_date_to'] <= o['business_date_from']) throw invalid(fieldError('/business_date_to'));
  return o as ReportQuery;
}

/** Window length in days (half-open: from inclusive, to exclusive) <= LIMS_INVENTORY_REPORT_MAX_DAYS (default 366). */
export async function assertRange(q: ReportQuery): Promise<void> {
  if (q.business_date_from === undefined || q.business_date_to === undefined) return;
  const days = (Date.parse(`${q.business_date_to}T00:00:00Z`) - Date.parse(`${q.business_date_from}T00:00:00Z`)) / 86_400_000;
  if (days > (await loadInventoryConfig()).reportMaxDays) throw new LimsError('inventory.range_too_large');
}
