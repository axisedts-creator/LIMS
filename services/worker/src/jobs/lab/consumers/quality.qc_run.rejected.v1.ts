// quality.qc_run.rejected.v1 -> holdResultsSince (02-TRD §6.1, §7.2 row 7; 06 row T-25; AC-19.4). Idempotent on (tenant, qc_run_id).
// REQ-SEC-024 / P-11: same tenant guard as the qc.received consumer. A failure rejects: retry, then dead letter.
import { applyQcRejected, type QcEnvelope } from '../../../../../api/src/modules/lab/service/qc.service.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event: QcEnvelope, ctx: JobContext) => {
  await applyQcRejected(ctx as never, event);
};
