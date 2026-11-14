// Consumer reporting.report.released.v1 (02-TRD §7.2, 03-IC §3.17; US-08.1, 07-SECURITY AB14). The C0 wrapper owns the inbox; this handler never touches partners.event_inbox.
// Only a PARTNER report is projected: payload.partner_id present AND audiences contains 'partner'; anything else is ignored_not_partner. The order must be a partner order of THIS
// tenant (else ignored_not_partner); event partner_id != the tracking row's partner_id -> nothing stored, metric outcome=mismatch (AB14; the log carries no ids).
// A stored (report_id, version_no) is a duplicate: no write (is_new / seen_* are never reset). supersedes_version_no marks that version 'superseded'. report_kind is stored as received
// (x-extensible, 02-CV §7.2; the derivation treats an unknown kind as amended). tracking_status is re-derived (T1-T7), report_count = valid versions, last_event_at = released_at forward only.
// partners.enrich_report {tenant_id, order_id, report_id, version_no} is enqueued with job_key enrich:<report_id>:<version_no>.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { countEvent, rederive, UUID } from '../tasks/partners.reconcile_orders.js';
import { ENRICH_TASK } from '../tasks/partners.enrich_report.js';

const EVENT = 'reporting.report.released.v1';

export const onReportReleased: ConsumerHandler = async (event, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || event?.tenant_id !== tenantId) throw new Error(`partners consumer ${EVENT}: envelope tenant differs from the job tenant`);
  const p = event.payload ?? {};
  if (typeof p.report_id !== 'string' || !UUID.test(p.report_id) || typeof p.order_id !== 'string' || !UUID.test(p.order_id) || !Number.isInteger(p.version_no) || p.version_no < 1
    || typeof p.report_kind !== 'string' || Number.isNaN(Date.parse(p.released_at))) throw new TypeError(`partners consumer ${EVENT}: malformed event`);
  if (typeof p.partner_id !== 'string' || !Array.isArray(p.audiences) || !p.audiences.includes('partner')) return countEvent(ctx, EVENT, 'ignored_not_partner');
  const tx = ctx.tx; const actor = ctx.actor.id; const now = ctx.now();

  const order = (await tx.query('SELECT partner_id, receiving_centre_id FROM partners.order_tracking WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [tenantId, p.order_id])).rows[0];
  if (!order) return countEvent(ctx, EVENT, 'ignored_not_partner');
  if (order.partner_id !== p.partner_id) { ctx.log.warn({ event_type: EVENT }, 'partner_id of the report differs from the partner of the order, event ignored'); return countEvent(ctx, EVENT, 'mismatch'); }

  const known = (await tx.query('SELECT version_no FROM partners.order_reports WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3', [tenantId, p.report_id, p.version_no])).rows[0];
  if (known) return countEvent(ctx, EVENT, 'duplicate');

  // a v1 that arrives after the v2 superseding it must not become the valid one
  const newer = (await tx.query('SELECT version_no FROM partners.order_reports WHERE tenant_id = $1 AND report_id = $2 AND version_no > $3', [tenantId, p.report_id, p.version_no])).rows.length > 0;
  await tx.query('INSERT INTO partners.order_reports (tenant_id, report_id, version_no, order_id, partner_id, receiving_centre_id, kind, status, released_at, is_new, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $10)',
  [tenantId, p.report_id, p.version_no, p.order_id, order.partner_id, order.receiving_centre_id, p.report_kind, newer ? 'superseded' : 'valid', p.released_at, actor]);
  if (Number.isInteger(p.supersedes_version_no) && p.supersedes_version_no >= 1) {
    await tx.query("UPDATE partners.order_reports SET status = 'superseded', updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3 AND status = 'valid'",
      [tenantId, p.report_id, p.supersedes_version_no, now, actor]);
  }

  await rederive(ctx, tenantId, p.order_id, { eventAt: p.released_at, countReports: true });
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [ENRICH_TASK, JSON.stringify({ tenant_id: tenantId, order_id: p.order_id, report_id: p.report_id, version_no: p.version_no }),
    `enrich:${p.report_id}:${p.version_no}`]);
  countEvent(ctx, EVENT, 'applied');
};
