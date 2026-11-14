// C12.T-17 consumer `instruments.result.received.v1` -> rerun facts (02-TRD §8.1 table row; PRD AC-13.1..13.3; 07-SECURITY D-EVT, P-T6, LT-1).
// Reads only: instrument_message_id, instrument_id, centre_id, test_id, mapping_status, is_rerun, received_at. Result events write NO event-level counter.
import { rerunBasisKey } from '../../../../../api/src/modules/inventory/domain/basis.js';
import type { ConsumerHandler } from '../../../core/manifest.js';
import { bumpTestCounter, openJob, optUuid, payloadOf, recordEventFact, reqIso, reqUuid, switchIsOn, ymdIn } from './_received.js';

const EVENT = 'instruments.result.received.v1';

export const onResultReceived: ConsumerHandler = async (event, jobCtx) => {
  const e = event as any;
  const job = await openJob(EVENT, e, jobCtx);
  if (job === null) return;
  const p = payloadOf(EVENT, e);
  const messageId = reqUuid(EVENT, p, 'instrument_message_id'), instrumentId = reqUuid(EVENT, p, 'instrument_id'), centreId = optUuid(EVENT, p, 'centre_id'), testId = optUuid(EVENT, p, 'test_id');
  const at = reqIso(EVENT, p, 'received_at');
  if (p['is_rerun'] !== true || p['mapping_status'] !== 'mapped' || testId === null) return; // step 4 filter (AC-13.2; an absent is_rerun is "not a rerun", AC-13.3)
  if (!(await switchIsOn(job.rc, at.ms))) return; // step 5

  const businessDate = ymdIn(at.ms, job.tz);
  const tests = await recordEventFact(job.rc, {
    kind: 'rerun', basisKey: rerunBasisKey(messageId, testId), eventId: e.event_id, eventType: EVENT, instrumentId, centreId, testId, analyteId: null, occurredAt: at.iso, businessDate, tz: job.tz, nowMs: Date.parse(job.ctx.now()),
  });
  if (tests !== null) await bumpTestCounter(job.rc, { businessDate, instrumentId, testId, col: 'rerun_events' }); // step 7: newly inserted fact only, whatever its status
};
