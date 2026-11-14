// C12.T-17 consumer `instruments.calibration.received.v1` -> per_calibration facts (02-TRD §8.1 table row; CR-C12-006, 08 R13; 07-SECURITY D-EVT, P-T6, LT-1).
// Reads only: instrument_message_id, instrument_id, centre_id, test_id, mapping_status, received_at. Writes no counter. The calibrator identity fields are never read.
import { createHash } from 'node:crypto';
import type { ConsumerHandler } from '../../../core/manifest.js';
import { openJob, optUuid, payloadOf, recordEventFact, reject, reqIso, reqUuid, switchIsOn, ymdIn } from './_received.js';

const EVENT = 'instruments.calibration.received.v1';

export const onCalibrationReceived: ConsumerHandler = async (event, jobCtx) => {
  const e = event as any;
  const job = await openJob(EVENT, e, jobCtx);
  if (job === null) return;
  const p = payloadOf(EVENT, e);
  reqUuid(EVENT, p, 'instrument_message_id');
  const instrumentId = reqUuid(EVENT, p, 'instrument_id'), centreId = optUuid(EVENT, p, 'centre_id'), testId = optUuid(EVENT, p, 'test_id');
  const at = reqIso(EVENT, p, 'received_at');
  if (p['mapping_status'] !== 'mapped' || testId === null) return; // step 4 filter
  if (!(await switchIsOn(job.rc, at.ms))) return; // step 5
  if (typeof e.idempotency_key !== 'string' || e.idempotency_key.length === 0) reject(EVENT, 'idempotency_key');

  // basis key `cal:<sha256 hex of the envelope idempotency_key>` (same value as basis.ts calibrationBasisKey; raw key never stored, AC-12.4)
  const basisKey = `cal:${createHash('sha256').update(e.idempotency_key, 'utf8').digest('hex')}`;
  await recordEventFact(job.rc, {
    kind: 'calibration', basisKey, eventId: e.event_id, eventType: EVENT, instrumentId, centreId, testId, analyteId: null, occurredAt: at.iso, businessDate: ymdIn(at.ms, job.tz), tz: job.tz, nowMs: Date.parse(job.ctx.now()),
  });
};
