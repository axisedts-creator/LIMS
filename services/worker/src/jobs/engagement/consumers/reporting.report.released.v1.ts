// reporting.report.released.v1 -> engagement (02-TRD §4.4, §4.5, §4.9 report_ready, §7.2 row 3; 01-PRD US-EN-08.1/2; 08 A13 P-4; 03-IC §3.17). Only when 'patient' is in audiences and the patient has an active/suspended link.
// Panel names + smart flag come from ReportingPort.getReleasedReports({filter:{orderId}}) as the system actor (a C6 failure throws: rolled back, retried). The version is stored `valid` unless a newer version of the
// report is already stored (then `superseded`); a newer version flips every older valid one. report_kind is stored as sent (<= 32 chars); unknown kinds count as neither final nor partial (stage rule in domain/stage.ts).
// A (report, version) already stored is a no-op (the whole delivery is one transaction). report_ready goes to ACTIVE links whose visible_from <= released_at, once per (account, report, version).
// smart summary available + settings.smart_report_in_app -> task engagement.fetch_smart_summary, key smart:<report_id>:<version_no>.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { UUID, createProjectionService, projectionCtx } from '../../../../../api/src/modules/engagement/service/projection.service.js';
import { createNotificationService } from '../../../../../api/src/modules/engagement/service/notification.service.js';

const projection = createProjectionService(), notifications = createNotificationService();
const PAGE = 100; // the C6 port caps a page at 100
const SMART_MAX_ATTEMPTS = 5; // TRD §8.1
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export const handle: ConsumerHandler = async (event, ctx) => {
  const p = event?.payload ?? {}; const { report_id: reportId, order_id: orderId, patient_id: patientId, version_no: versionNo, report_kind: kind, released_at: releasedAt } = p;
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event.tenant_id !== ctx.tenantId) return;
  if (![reportId, orderId, patientId].every((v) => typeof v === 'string' && UUID.test(v)) || !Number.isInteger(versionNo) || versionNo < 1 || typeof kind !== 'string' || !kind
    || typeof releasedAt !== 'string' || Number.isNaN(Date.parse(releasedAt)) || !Array.isArray(p.audiences) || !p.audiences.includes('patient')) return;

  const pctx = projectionCtx(ctx);
  const links = await projection.liveLinks(pctx, patientId);
  if (links.length === 0) return;
  if (!(await projection.ensureOrder(pctx, { orderId, patientId }))) return;
  const stored = await projection.versionsOfReport(pctx, reportId);
  if (stored.some((r) => Number(r['version_no']) === versionNo)) return; // already applied

  let found: Record<string, any> | undefined;
  for (let cursor: string | undefined; ;) {
    const page = await (ctx as any).ports.ReportingPort.getReleasedReports(ctx, { filter: { orderId, includeSuperseded: true }, limit: PAGE, ...(cursor ? { cursor } : {}) });
    found = (page.items as Array<Record<string, any>>).find((r) => r['reportId'] === reportId && r['versionNo'] === versionNo) ?? found;
    cursor = page.nextCursor;
    if (found || !cursor) break;
  }
  if (!found) throw new Error('report_version_not_in_c6'); // released event ahead of the read: retry
  if (found['patientId'] !== patientId) return;

  const superseded = stored.some((r) => Number(r['version_no']) > versionNo);
  const smart = found['smartSummaryAvailable'] === true;
  const supersedes = Number.isInteger(p.supersedes_version_no) && p.supersedes_version_no >= 1 ? p.supersedes_version_no : null;
  await projection.upsertReports(pctx, [{ reportId, versionNo, orderId, patientId, kind, status: superseded ? 'superseded' : 'valid', releasedAt, panelNames: found['panelNames'] ?? [], smartSummaryAvailable: smart, supersedesVersionNo: supersedes }]);
  await projection.supersedeBelow(pctx, reportId, versionNo);
  await projection.recomputeStages(pctx, [orderId]);
  if (superseded) return; // an outdated version raises neither a notification nor a summary fetch

  const visible = (l: Record<string, any>) => l['status'] === 'active' && (l['visible_from'] == null || Date.parse(releasedAt) >= Date.parse(iso(l['visible_from'])!));
  await notifications.create(pctx, links.filter(visible).map((l) => ({ accountId: l['account_id'], patientId, kind: 'report_ready' as const, entityType: 'report' as const, entityId: reportId, entitySeq: versionNo, routeId: 'patient_app.report' as const })));
  if (smart && (await projection.settingsOf(pctx)).smartReportInApp) {
    await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, $4::timestamptz, $5)',
      ['engagement.fetch_smart_summary', JSON.stringify({ tenant_id: ctx.tenantId, report_id: reportId, version_no: versionNo }), `smart:${reportId}:${versionNo}`, null, SMART_MAX_ATTEMPTS]);
  }
};
