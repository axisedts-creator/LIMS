// Task engagement.fetch_smart_summary {tenant_id, report_id, version_no} (02-TRD §4.11 `follow_up` row, §6.2, §8.1 max 5 / job key smart:<report_id>:<version_no>; 01-PRD US-EN-09.1, 09.3, 09.4, US-EN-24.1-3;
// 07-SECURITY rule 2 + rule 5; 08 A2.3 / A4.4: the approved snapshot rides on ReportingPort.openReleasedReportFile -> smartSummary; SmartReportPort is never called).
// As the system actor, in ONE transaction (a throw rolls everything back and the queue retries):
//   settings.smart_report_in_app off (re-checked now) -> nothing, no port call. patient_reports row missing -> nothing. Port common.not_found, no snapshot, or snapshot.status !== 'approved' -> nothing, no retry.
//   Any other port error -> rejects (retry). Approved -> ONE smart_summaries row (the snapshot minus every key ending Id / Ids, TRD §5 SmartSummaryView), kept as is for an older version when a newer one arrives (US-EN-09.4).
//   settings.auto_follow_up_reminders -> one `follow_up` reminder per follow-up: due = released_at + intervalDays - follow_up_reminder_lead_days; the reminder row carries no test name / text (REQ-SEC-070).
// [CONV] an approved snapshot without a valid approvedAt, or over the 256 KiB CHECK, can never succeed: it is skipped (logged without content), not retried.
// [CONV] reason_code = 'follow_up_test' (g_cs_reminder_reasons seed, 05-SCHEMA §7). Never logged: summary text, panel names, disclaimer.
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const MAX_BYTES = 262_144; // smart_summaries__size__ck
const REASON = 'follow_up_test';
const ID_KEY = /(?:Id|Ids|_id|_ids)$/;

/** The snapshot without any id-like key, at any depth. */
const stripIds = (v: unknown): unknown => Array.isArray(v) ? v.map(stripIds)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id' && !ID_KEY.test(k)).map(([k, x]) => [k, stripIds(x)])) : v;
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

export function createFetchSmartSummary(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any; const tenantId = ctx.tenantId; const tx = ctx.tx;
    const reportId = payload?.['report_id']; const versionNo = payload?.['version_no'];
    if (typeof tenantId !== 'string' || (payload?.['tenant_id'] !== undefined && payload['tenant_id'] !== tenantId) || typeof reportId !== 'string' || !UUID.test(reportId)
      || !Number.isInteger(versionNo) || versionNo < 1 || versionNo > 9999) { ctx.log?.warn?.({ event: 'fetch_smart_summary_skipped', reason: 'bad_payload' }); return; }

    const { rows: [settings] } = await tx.query('SELECT smart_report_in_app, auto_follow_up_reminders, follow_up_reminder_lead_days FROM engagement.settings WHERE tenant_id = $1', [tenantId]) as { rows: Row[] };
    if (settings?.['smart_report_in_app'] !== true) { ctx.log?.info?.({ event: 'fetch_smart_summary_noop', reason: 'feature_off' }); return; }
    const { rows: [rep] } = await tx.query('SELECT patient_id, order_id, released_at FROM engagement.patient_reports WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3', [tenantId, reportId, versionNo]) as { rows: Row[] };
    if (!rep) { ctx.log?.info?.({ event: 'fetch_smart_summary_noop', reason: 'no_report' }); return; }

    let snap: Row | undefined;
    try { snap = (await ctx.ports.ReportingPort.openReleasedReportFile(ctx, { reportId, versionNo }))?.smartSummary; }
    catch (e) {
      if ((e as { code?: unknown })?.code === 'common.not_found') { ctx.log?.info?.({ event: 'fetch_smart_summary_noop', reason: 'not_found' }); return; }
      throw Object.assign(new Error('fetch_smart_summary: ReportingPort unavailable'), { code: 'common.dependency_unavailable' }); // never echo the port's message
    }
    const approvedAt = snap?.['approvedAt'];
    if (!snap || typeof snap !== 'object' || snap['status'] !== 'approved') { ctx.log?.info?.({ event: 'fetch_smart_summary_noop', reason: 'not_approved' }); return; } // draft / absent: not stored (07 rule 5)
    const body = JSON.stringify(stripIds(snap));
    if (!Number.isFinite(ms(approvedAt)) || typeof snap['templateLibraryVersion'] !== 'string' || Buffer.byteLength(body) > MAX_BYTES) { ctx.log?.warn?.({ event: 'fetch_smart_summary_skipped', reason: 'unusable_snapshot' }); return; }

    const now: string = ctx.now(); const by: string = ctx.actor.id;
    await tx.query(
      `INSERT INTO engagement.smart_summaries (id, tenant_id, order_id, report_id, report_version_no, patient_id, summary, template_library_version, approved_at, fetched_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
      [uuidv7(), tenantId, rep['order_id'], reportId, versionNo, rep['patient_id'], body, snap['templateLibraryVersion'], new Date(ms(approvedAt)).toISOString(), now, by]); // retry: the first copy stays
    const { rows: [stored] } = await tx.query('SELECT id FROM engagement.smart_summaries WHERE tenant_id = $1 AND report_id = $2 AND report_version_no = $3', [tenantId, reportId, versionNo]) as { rows: Row[] };

    const followUps: Row[] = Array.isArray(snap['followUps']) ? snap['followUps'] : [];
    if (settings['auto_follow_up_reminders'] === true && stored) {
      const lead = Number.isInteger(settings['follow_up_reminder_lead_days']) ? settings['follow_up_reminder_lead_days'] : 3;
      for (const [i, f] of followUps.entries()) {
        const days = f?.['intervalDays']; if (!Number.isInteger(days) || days < 0 || days > 3650) continue;
        await tx.query(
          `INSERT INTO engagement.reminders (id, tenant_id, patient_id, kind, reason_code, source, source_ref_id, source_ref_seq, due_at, status, version, created_by, updated_by)
           VALUES ($1, $2, $3, 'follow_up', $4, 'smart_report', $5, $6, $7, 'scheduled', 1, $8, $8) ON CONFLICT DO NOTHING`,
          [uuidv7(), tenantId, rep['patient_id'], REASON, stored['id'], i, new Date(ms(rep['released_at']) + (days - lead) * DAY).toISOString(), by]);
      }
    }
    ctx.log?.info?.({ event: 'fetch_smart_summary_done', follow_ups: followUps.length });
  };
}
