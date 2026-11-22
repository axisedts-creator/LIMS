// T0D-BUILD-4 (LD-447; closes CR item 8 of .orchestra/notes/T0D-MISREPORTS-1-cr-needed.md): GET /v1/analytics/mis-reports/{report_code}, the HTTP read of the
// MIS report definitions. Serves runMisReport (no SQL of its own). Gate order, the same as the export of the code (exports.ts) and the referral read:
// registry (404 analytics.report_unknown; a registered non MIS code -> operation_pending 501) -> permission of the definition (403, aal2 on the money codes)
// -> tenant flag of the definition (403 common.feature_disabled) -> input (400) -> scope (404 foreign centre) -> data -> access log (money codes only, A39 / LD-342).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { getReport, isMisCode, MIS_ALL_DEFS, MONEY_REPORT_CODES } from '../domain/reportRegistry.js';
import { resolveScope } from '../service/context.service.js';
import { checkMisFilters, checkMisRange, runMisReport, type MisCtx, type MisPage } from '../service/misReports.service.js';
import { checkInt, invalidField } from '../service/reports.service.js';
import type { AnalyticsPermission } from '../permissions.js';
import { authorise, queryOf } from './reportRequest.js';

type Gated = { audit: { access(e: object): Promise<void> }; ports: { IdentityPort: { getTenantSettings(ctx: unknown, i: { keys: string[] }): Promise<Record<string, unknown>> } } };
const FILTER_KEYS = ['party_id', 'representative_id', 'referrer_id', 'department_id', 'collector_id', 'visit_type'] as const;
const TOTALS_CHUNK = 1000; // runMisReport's own max page; the row cap (<= 5000) bounds the loop

export const getMisReportPage: Handler = async (req, ctx) => {
  const code = (req.params as { report_code?: unknown } | undefined)?.report_code as string;
  if (!isMisCode(code)) {
    // permission first (REQ-SEC-062): a code that is not an MIS definition asks the contract x-permission before it answers 404 / 501
    await authorise(ctx, 'analytics.dashboard.read');
    getReport(code); // unknown / prototype keys -> 404 analytics.report_unknown
    throw new LimsError('operation_pending'); // a registered report without an MIS read (the core renders 501)
  }
  const report = getReport(code);
  const c = await authorise(ctx, report.permission as AnalyticsPermission);
  const { audit, ports } = c as unknown as Gated;
  if (report.flag) {
    const s = await ports.IdentityPort.getTenantSettings(c, { keys: [report.flag] });
    if (s[report.flag] !== true) throw new LimsError('common.feature_disabled');
  }

  const q = queryOf(req);
  const range = checkMisRange({ from: q.business_date_from, to: q.business_date_to }, ['business_date_from', 'business_date_to']);
  const filters: Record<string, unknown> = {};
  for (const k of FILTER_KEYS) if (q[k] !== undefined) filters[k] = q[k];
  // T0D-FIX-8 (LD-455): the contract default min_repeat_count=2 reaches every request; a report that does not list it drops it (any value) before checkMisFilters.
  const takesMinRepeat = (MIS_ALL_DEFS[code]!.params as readonly string[]).includes('min_repeat_count');
  if (takesMinRepeat && q.min_repeat_count !== undefined) filters.min_repeat_count = checkInt(q.min_repeat_count, 'min_repeat_count', 2, 1000, 2);
  checkMisFilters(code, filters, 'query');
  const limit = checkInt(q.limit, 'limit', 1, 200, 50);
  if (q.cursor !== undefined && (typeof q.cursor !== 'string' || q.cursor.length > 512)) throw new LimsError('common.invalid_cursor');
  if (q.centre_id !== undefined && !(MIS_ALL_DEFS[code]!.params as readonly string[]).includes('centre_id')) throw invalidField('centre_id');
  const scope = await resolveScope(c, { centreIds: q.centre_id }); // > 20 -> 400; foreign / out of scope -> 404

  const m = c as unknown as MisCtx;
  const page = await runMisReport(m, code, { range, scope, filters, limit, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}) });
  // Totals over the WHOLE filtered set (not the page): every paisa and count column, summed from runMisReport pages (no basis points, no text).
  const keys = page.columns.filter((x) => x.kind === 'paisa' || x.kind === 'count').map((x) => x.key);
  const totals: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const add = (p: MisPage) => { for (const r of p.rows) for (const k of keys) totals[k]! += Number(r[k] ?? 0); };
  if (q.cursor === undefined && !page.next_cursor) add(page); // the page is the whole set
  else {
    let cursor: string | undefined;
    do {
      const p = await runMisReport(m, code, { range, scope, filters, limit: TOTALS_CHUNK, ...(cursor ? { cursor } : {}) });
      add(p);
      cursor = p.next_cursor;
    } while (cursor);
  }

  if (MONEY_REPORT_CODES.includes(code)) { // A39-2c: one entry per served page, before the body leaves; a failed write fails the request. No figures.
    await audit.access({ action: 'referral_report.view', entityType: 'analytics_report', outcome: 'allowed', detail: { report_code: code, from: range.from, to: range.to } });
  }
  return { status: 200, body: { columns: page.columns, rows: page.rows, totals, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) } };
};
