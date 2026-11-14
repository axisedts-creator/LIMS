// instruments.qc.received.v1 -> quality (02-TRD §6.1, §6.2, §10.2; AC-05.2). A TRIGGER only: nothing of the payload is read, stored or logged (C5 owns the row; C9 imports from lab.v_pub_qc_result).
// One statement: enqueue quality.sync_qc_observations with job_key qcsync:<tenant>, run_at = now + LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS. app.enqueue_job uses unsafe_dedupe, so a second delivery or a
// stream of events adds nothing and never moves run_at. REQ-SEC-024: an event of another tenant is refused before any query. A failing enqueue rejects (retry, then dead letter).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { loadQualityConfig } from '../../../../../api/src/modules/quality/config.js';

const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';   // (identifier, payload, job_key, run_at, max_attempts) — same statement as core/fanout.ts
const MAX_ATTEMPTS = 5;                                                       // TRD §10.3

export const handle: ConsumerHandler = async (event, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !tenantId || event?.tenant_id !== tenantId) throw new Error('instruments.qc.received.v1: event tenant does not match the job tenant');
  const runAt = new Date(Date.parse(ctx.now()) + loadQualityConfig().syncDebounceSeconds * 1000).toISOString();
  await ctx.tx.query(ENQUEUE_SQL, ['quality.sync_qc_observations', JSON.stringify({ tenant_id: tenantId }), `qcsync:${tenantId}`, runAt, MAX_ATTEMPTS]);
};
