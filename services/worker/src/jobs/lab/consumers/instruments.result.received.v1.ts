// instruments.result.received.v1 -> lab ingest pipeline (02-TRD §4.5, §7.2 row "instruments.result.received.v1": system actor, inbox + result-level key (04 N10); 06 row T-22; AC-14.1..14.4, 14.7, 14.8).
// REQ-SEC-024 / 07-SECURITY P-08: the job's tenant is the only tenant; an envelope of another tenant (or a job without one) is refused before any query, port or event.
// The service re-checks the same guard. REQ-SEC-098: this handler logs nothing of the payload (barcode and value are patient-linked).
import { LimsError } from '../../../../../api/src/core/errors.js';
import { loadLabConfig } from '../../../../../api/src/modules/lab/config.js';
import { applyInstrumentResultEvent, sqlIngestStore, type IngestCtx, type InstrumentResultEnvelope } from '../../../../../api/src/modules/lab/service/ingest.service.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';

export const handle: ConsumerHandler = async (event: InstrumentResultEnvelope, ctx: JobContext) => {
  if (typeof ctx.tenantId !== 'string' || event?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
  const given = (ctx as unknown as { store?: Partial<IngestCtx['store']> }).store;
  const store = given && typeof given.claimKey === 'function' ? (given as IngestCtx['store']) : sqlIngestStore(ctx.actor.id, given);   // job tx; result-side store = core pipeline (T-14/T-16)
  const config = (ctx as unknown as { config?: IngestCtx['config'] }).config ?? loadLabConfig();   // LIMS_LAB_AUTOVERIFY_HOOK_ENABLED, false in Phase 1
  // JobContext.now() is an ISO string, the service wants a Date. A failure rejects: the job retries and dead-letters, never a silent ack.
  await applyInstrumentResultEvent({ ...(ctx as unknown as IngestCtx), store, config, now: () => new Date(ctx.now()) }, event);
};
