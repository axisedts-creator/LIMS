// instruments.qc.received.v1 -> lab.qc_results (02-TRD §7.2 row 5: system actor, inbox + idempotency_key; 06 row T-25; AC-19.1).
// REQ-SEC-024 / P-11: the job's tenant is the only tenant; the service refuses an envelope of another tenant (or a job without one) before any query. Logs nothing of the payload (REQ-SEC-098).
// A failure rejects: the job retries and dead-letters, never a silent ack.
import { applyQcReceived, type QcEnvelope } from '../../../../../api/src/modules/lab/service/qc.service.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event: QcEnvelope, ctx: JobContext) => {
  await applyQcReceived(ctx as never, event);
};
