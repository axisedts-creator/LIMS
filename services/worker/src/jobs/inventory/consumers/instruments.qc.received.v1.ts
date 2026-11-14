// C12.T-17 consumer `instruments.qc.received.v1` -> qc facts (02-TRD §8.1 steps 2-7 + table row; PRD AC-14.1..14.4, AC-21.7 counter part; 08 A17 D-74; 07-SECURITY D-EVT, P-T6, LT-1).
// Reads only: instrument_message_id, instrument_id, centre_id, analyte_id, mapping_status, received_at. Control / value / unit fields are never read.
import { createHash } from 'node:crypto';
import { query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import type { ConsumerHandler } from '../../../core/manifest.js';
import { bumpTestCounter, openJob, optUuid, payloadOf, recordEventFact, reject, reqIso, reqUuid, switchIsOn, ymdIn } from './_received.js';

const EVENT = 'instruments.qc.received.v1';

export const onQcReceived: ConsumerHandler = async (event, jobCtx) => {
  const e = event as any;
  const job = await openJob(EVENT, e, jobCtx);
  if (job === null) return;
  const { rc } = job;
  const p = payloadOf(EVENT, e);
  reqUuid(EVENT, p, 'instrument_message_id');
  const instrumentId = reqUuid(EVENT, p, 'instrument_id'), centreId = optUuid(EVENT, p, 'centre_id'), analyteId = optUuid(EVENT, p, 'analyte_id');
  const mapping = typeof p['mapping_status'] === 'string' ? p['mapping_status'] : reject(EVENT, 'mapping_status');
  if (typeof e.idempotency_key !== 'string' || e.idempotency_key.length === 0) reject(EVENT, 'idempotency_key');
  const at = reqIso(EVENT, p, 'received_at');
  const businessDate = ymdIn(at.ms, job.tz);

  // step 3 (D-74): every non-duplicate QC event, mapped or not, BEFORE the filter and the switch gate; the row is created on first use (P-22)
  await query(rc, `INSERT INTO inventory.instrument_qc_daily (tenant_id, business_date, instrument_id, qc_observations, created_by, updated_by)
    VALUES ($1, $2::date, $3::uuid, 1, $4::uuid, $4::uuid)
    ON CONFLICT (tenant_id, business_date, instrument_id) DO UPDATE SET qc_observations = inventory.instrument_qc_daily.qc_observations + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
  [businessDate, instrumentId, rc.actorId]);

  if (mapping !== 'mapped' || analyteId === null) return; // step 4 filter
  if (!(await switchIsOn(rc, at.ms))) return; // step 5

  // basis key `qc:<sha256 hex of the envelope idempotency_key>` (same value as basis.ts qcBasisKey; the raw key is never stored, AC-12.4)
  const basisKey = `qc:${createHash('sha256').update(e.idempotency_key, 'utf8').digest('hex')}`;
  const tests = await recordEventFact(rc, {
    kind: 'qc', basisKey, eventId: e.event_id, eventType: EVENT, instrumentId, centreId, testId: null, analyteId, occurredAt: at.iso, businessDate, tz: job.tz, nowMs: Date.parse(job.ctx.now()),
  });
  for (const testId of tests ?? []) await bumpTestCounter(rc, { businessDate, instrumentId, testId, col: 'qc_events' }); // step 7: +1 per DISTINCT attributed test of a newly inserted fact; none on no_rule
};
