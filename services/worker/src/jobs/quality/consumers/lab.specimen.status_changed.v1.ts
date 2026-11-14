// lab.specimen.status_changed.v1 -> enqueue quality.tat_refresh_order (02-TRD §10.2, §10.3; 03-IC §3.7; AC-14.1, AC-14.4). Reads ONLY payload.order_id and payload.to_status; patient_id, specimen ids, centre and every
// unknown field are never read, stored, enqueued or logged (S-15). Enqueue only for to_status received | rejected | recollection_ordered | ordered; any other (incl. unknown) status is a no-op.
// One statement: app.enqueue_job dedupes on the job key `tat:<order_id>` and never moves run_at, so a duplicate delivery repeats the identical statement. The refresh reads the current views, so a stale seq is harmless.
// REQ-SEC-024: an event of another tenant is refused before any query; the job payload carries the JOB tenant. Malformed input throws a fixed message (nothing echoed). A failing enqueue rejects (retry, then dead letter).
import type { ConsumerHandler } from '../../../core/manifest.js';

const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';   // (identifier, payload, job_key, run_at, max_attempts) — same statement as core/fanout.ts
const MAX_ATTEMPTS = 5;                                                       // TRD §10.3
const DELAY_MS = 2000;                                                        // TRD §10.2: run_at = now + 2 s
const TRIGGERS = new Set(['received', 'rejected', 'recollection_ordered', 'ordered']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handle: ConsumerHandler = async (event, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !tenantId || event?.tenant_id !== tenantId) throw new Error('lab.specimen.status_changed.v1: event tenant does not match the job tenant');
  const p = (event as any).payload;
  if (typeof p !== 'object' || p === null || Array.isArray(p) || typeof p.order_id !== 'string' || !UUID.test(p.order_id) || typeof p.to_status !== 'string') {
    throw new Error('lab.specimen.status_changed.v1: malformed payload');   // fixed message: nothing of the payload is echoed
  }
  if (!TRIGGERS.has(p.to_status)) return;
  const runAt = new Date(Date.parse(ctx.now()) + DELAY_MS).toISOString();
  await ctx.tx.query(ENQUEUE_SQL, ['quality.tat_refresh_order', JSON.stringify({ tenant_id: tenantId, order_id: p.order_id }), `tat:${p.order_id}`, runAt, MAX_ATTEMPTS]);
};
