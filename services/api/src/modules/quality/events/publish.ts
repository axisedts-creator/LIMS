// C9 T-10: typed publisher for quality.qc_run.rejected.v1 (02-TRD §7.7, §10.1; 03-IC §3.21). The payload goes through verbatim: core validates the whole envelope against
// contracts/events/quality.qc_run.rejected.v1.schema.json (additionalProperties false) BEFORE the INSERT and fails closed with common.internal, so a value, an observation id or any
// non-IC key never leaves the module (REQ-SEC-006). Runs on ctx.tx: the event commits or rolls back with the run (outbox, 02-CV §7.3).
import { LimsError } from '../../../core/errors.js';
import type { PublishInput } from '../../../core/events/publish.js';

interface Events { publish(ctx: never, type: string, input: PublishInput): Promise<{ eventId: string; duplicate: boolean }> }
type Ctx = Parameters<Events['publish']>[0];

const REJECTED = 'quality.qc_run.rejected.v1';

export function createQualityEvents(events: Events) {
  return {
    /** Key `<qc_run_id>:rejected`, aggregate qc_run seq = the run version after the rejection (not a payload field: the schema forbids extra keys). One event per run; replays are duplicates. */
    publishQcRunRejected: async (ctx: Ctx, payload: Readonly<Record<string, unknown>>, o: { runVersion: number }): Promise<{ eventId: string; duplicate: boolean }> => {
      const runId = payload['qc_run_id'];
      if (typeof runId !== 'string' || !Number.isSafeInteger(o.runVersion) || o.runVersion < 1) throw new LimsError('common.internal');
      return events.publish(ctx, REJECTED, { aggregate: { type: 'qc_run', id: runId, seq: o.runVersion }, idempotencyKey: `${runId}:rejected`, payload });
    },
  };
}
export type QualityEvents = ReturnType<typeof createQualityEvents>;
