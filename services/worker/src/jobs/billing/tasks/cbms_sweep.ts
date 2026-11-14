// billing.cbms_sweep (02-TRD §9, §10; PRD US-BL-13.2): every 15 min, per tenant. Re-queues billing.cbms_sync (job_key cbms:<kind>:<id>) for each PENDING document whose last attempt is
// older than min(2^attempts minutes, 6 h) [CONV, same cadence as cbmsBackoffMs]; a never-attempted document counts from its issue time. Covers invoices (cbms_*), invoice cancellations
// (invoices.cbms_cancel_*) and credit notes (cbms_*). It only READS documents and never gives up on one (no failed_permanent from here; only the client's rejected_permanent does that).
// Sets gauge lims_billing_cbms_pending_documents{tenant_id,state} for the alert rules (alerts/cbms.rules.yaml): state pending | stale_1h | attempts_10_plus.
// ponytail: 500 documents per run per tenant; the next run takes the rest.
import type { TaskHandler } from '../../../core/manifest.js';

export const CBMS_SWEEP = 'billing.cbms_sweep';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 500;

// all pending documents of the tenant: doc_at = when the document came into being (the clock of a never-attempted one);
// age_at = the page-alert age (TRD §"Alert rules for C1": created_at / cancelled_at, never the last attempt)
const PENDING = `
  SELECT 'invoice'::text AS document_kind, i.id AS document_id, i.cbms_attempts AS attempts, i.cbms_last_attempt_at AS last_attempt_at, i.issued_at AS doc_at, i.created_at AS age_at
    FROM billing.invoices i WHERE i.tenant_id = $1 AND i.cbms_state = 'pending'
  UNION ALL
  SELECT 'invoice_cancellation', i.id, i.cbms_cancel_attempts, i.cbms_cancel_last_attempt_at, i.cancelled_at, i.cancelled_at
    FROM billing.invoices i WHERE i.tenant_id = $1 AND i.cbms_cancel_state = 'pending'
  UNION ALL
  SELECT 'credit_note', n.id, n.cbms_attempts, n.cbms_last_attempt_at, n.issued_at, n.created_at
    FROM billing.credit_notes n WHERE n.tenant_id = $1 AND n.cbms_state = 'pending'`;

export const cbmsSweep: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  const pid = (payload as Record<string, unknown> | undefined)?.['tenant_id'];
  if (typeof tenantId !== 'string' || pid !== tenantId || !UUID.test(tenantId)) { // REQ-SEC-024: the payload can never widen the tenant scope
    ctx.log?.warn?.({ event: 'cbms_sweep_skipped', reason: 'bad_input' });
    return;
  }
  const now = ctx.now();
  const due = await ctx.tx.query(
    `SELECT d.document_kind, d.document_id FROM (${PENDING}) d
      WHERE COALESCE(d.last_attempt_at, d.doc_at) < $2::timestamptz - make_interval(mins => LEAST(power(2, LEAST(d.attempts, 9))::int, 360))
      ORDER BY COALESCE(d.last_attempt_at, d.doc_at) LIMIT ${BATCH}`, [tenantId, now]);
  const rows: Array<{ document_kind: string; document_id: string }> = Array.isArray(due?.rows) ? due.rows : [];
  for (const r of rows) {
    await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [
      'billing.cbms_sync', JSON.stringify({ tenant_id: tenantId, document_kind: r.document_kind, document_id: r.document_id }), `cbms:${r.document_kind}:${r.document_id}`]);
  }
  const g = await ctx.tx.query(
    `SELECT count(*) AS pending,
            count(*) FILTER (WHERE d.age_at < $2::timestamptz - interval '1 hour') AS stale_1h,
            count(*) FILTER (WHERE d.attempts >= 10) AS attempts_10_plus
       FROM (${PENDING}) d`, [tenantId, now]);
  const counts = { ...(g?.rows?.[0] ?? {}) };
  // TRD §"Alert rules for C1": the page alert is for live mode only; the stub (default) always leaves documents pending
  if ((process.env['LIMS_BILLING_CBMS_MODE'] ?? 'stub') !== 'live') counts.stale_1h = 0;
  for (const state of ['pending', 'stale_1h', 'attempts_10_plus']) ctx.metrics?.set?.('lims_billing_cbms_pending_documents', Number(counts[state] ?? 0), { tenant_id: tenantId, state });
  ctx.log?.info?.({ event: 'cbms_sweep_done', enqueued: rows.length });
};
