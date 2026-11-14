// partners.enrich_report (02-TRD §7.2 step 4, §8.1; US-08.1). Payload {tenant_id, order_id, report_id, version_no}. Reads ReportingPort.getReleasedReports (system actor, 03-IC §4.7)
// with exactly { filter: { orderId, includeSuperseded: true } } and stores panel_names + enriched_at on the ONE stored version the job names (a summary C13 does not hold is never inserted;
// is_new / seen_* are never touched). No released version visible yet (C6 commit race) -> throws, the job retries (TRD §8.1). Port errors propagate for retry.
// Panel names are P3 (05-SCHEMA §9): never logged.
import type { JobContext, TaskHandler } from '../../../core/manifest.js';
import { scopeOf } from './partners.sync_price_list.js';
import { UUID } from './partners.reconcile_orders.js';

export const ENRICH_TASK = 'partners.enrich_report';
const MAX_PANELS = 50;   // order_reports__panels__ck
const MAX_PAGES = 20;    // ponytail: a single order has a handful of report versions; cap the cursor loop instead of trusting the port

interface Summary { reportId: string; versionNo: number; panelNames?: readonly string[] }
interface ReportingPort { getReleasedReports(ctx: unknown, input: { filter: { orderId: string; includeSuperseded: boolean }; cursor?: string }): Promise<{ items: readonly Summary[]; nextCursor?: string }> }

export const enrichReportTask: TaskHandler = async (payload, ctx: JobContext) => {
  const { tenantId } = scopeOf(payload, ctx);
  const { order_id: orderId, report_id: reportId, version_no: versionNo } = payload as Record<string, unknown>;
  if (typeof orderId !== 'string' || !UUID.test(orderId) || typeof reportId !== 'string' || !UUID.test(reportId)) throw new TypeError('partners.enrich_report: order_id / report_id is not a uuid');
  if (!Number.isInteger(versionNo) || (versionNo as number) < 1) throw new TypeError('partners.enrich_report: version_no is not a positive integer');

  const port = (ctx as unknown as { ports: { ReportingPort: ReportingPort } }).ports.ReportingPort;
  let found: Summary | undefined; let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && !found; page++) {
    const res = await port.getReleasedReports(ctx, { filter: { orderId, includeSuperseded: true }, ...(cursor ? { cursor } : {}) });
    found = res.items.find((s) => s.reportId === reportId && s.versionNo === versionNo);
    cursor = res.nextCursor; if (!cursor) break;
  }
  if (!found) throw new Error('partners.enrich_report: released version not visible yet, retry');

  const names = (found.panelNames ?? []).slice(0, MAX_PANELS);
  await ctx.tx.query('UPDATE partners.order_reports SET panel_names = $4, enriched_at = $5, updated_at = $5, updated_by = $6 WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3',
    [tenantId, reportId, versionNo, names, ctx.now(), ctx.actor.id]);
};
