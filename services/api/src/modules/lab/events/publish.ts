// C5 T-04: typed publishers for the 7 lab events (02-TRD §7.1; 03-IC §3.7–§3.13).
// Payloads go through verbatim (core validates against contracts/events/*.schema.json, additionalProperties false, so any
// non-IC key — barcode, value, comment — fails closed with common.internal and nothing is stored; S-12 / REQ-SEC-006).
import { createHash } from 'node:crypto';
import type { PublishInput } from '../../../core/events/publish.js';
import { labMetrics } from '../service/metrics.js';

interface Events { publish(ctx: never, type: string, input: PublishInput): Promise<{ eventId: string; duplicate: boolean }> }
type Ctx = Parameters<Events['publish']>[0];
type Payload = Readonly<Record<string, unknown>>;
export interface ApprovedEntry { readonly result_id: string; readonly version_no: number }
export interface CanonicalValue { readonly kind: 'n' | 'o' | 't'; readonly value: string }

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** SHA-256 hex over string-sorted `result_id:version_no` lines joined by "\n" (02-TRD §4.7). */
export function approvedSetHash(set: readonly ApprovedEntry[]): string {
  return sha256(set.map((e) => `${e.result_id}:${e.version_no}`).sort().join('\n'));
}

/** First 16 hex of SHA-256 over `n:<decimal>` / `o:<code>` / `t:<text>` (02-TRD §7.1 [CONV]). */
export function valueSha256Prefix16(v: CanonicalValue): string {
  return sha256(`${v.kind}:${v.value}`).slice(0, 16);
}

export function createLabEvents(events: Events) {
  const pub = (ctx: Ctx, type: string, payload: Payload, aggType: string, aggId: unknown, seq: number, key: string) =>
    events.publish(ctx, type, { aggregate: { type: aggType, id: aggId as string, seq }, idempotencyKey: key, payload });

  return {
    // T-31 (02-TRD §11): counters follow a successful publish (a thrown publish rolls the transaction back); labels are codes only.
    specimenStatusChanged: async (ctx: Ctx, p: Payload, m: { specimenVersion: number }) => {
      const r = await pub(ctx, 'lab.specimen.status_changed.v1', p, 'specimen', p.specimen_id, m.specimenVersion, `${p.specimen_id}:${p.to_status}:${m.specimenVersion}`);
      labMetrics.specimenTransition(ctx, p.to_status);
      return r;
    },
    specimenRejected: (ctx: Ctx, p: Payload, m: { specimenVersion: number }) =>
      pub(ctx, 'lab.specimen.rejected.v1', p, 'specimen', p.specimen_id, m.specimenVersion, `${p.specimen_id}:rejected`),
    resultVerified: (ctx: Ctx, p: Payload, m: { resultRowVersion: number }) =>
      pub(ctx, 'lab.result.verified.v1', p, 'result', p.result_id, m.resultRowVersion,
        `${p.result_id}:verified:${p.result_version_no}:${m.resultRowVersion}`),
    // Key literal `:approved:1` per §7.1; the schema pins result_version_no = 1.
    resultApproved: (ctx: Ctx, p: Payload, m: { resultRowVersion: number }) =>
      pub(ctx, 'lab.result.approved.v1', p, 'result', p.result_id, m.resultRowVersion, `${p.result_id}:approved:1`),
    resultAmended: (ctx: Ctx, p: Payload, m: { resultRowVersion: number }) =>
      pub(ctx, 'lab.result.amended.v1', p, 'result', p.result_id, m.resultRowVersion,
        `${p.result_id}:amended:${p.new_version_no}`),
    orderReadyForReport: async (ctx: Ctx, p: Payload, m: { approvedSet: readonly ApprovedEntry[]; readinessSeq: number }) => {
      const h = approvedSetHash(m.approvedSet);
      const r = await pub(ctx, 'lab.order.ready_for_report.v1', { ...p, approved_set_hash: h }, 'order', p.order_id, m.readinessSeq, `${p.order_id}:ready:${h}`);
      labMetrics.readinessEmitted(ctx, p.completeness);
      return r;
    },
    // The value only feeds the key hash; it never enters the payload.
    criticalValueDetected: async (ctx: Ctx, p: Payload, m: { value: CanonicalValue; resultRowVersion: number }) => {
      const r = await pub(ctx, 'lab.critical_value.detected.v1', p, 'result', p.result_id, m.resultRowVersion, `${p.result_id}:critical:${p.result_version_no}:${valueSha256Prefix16(m.value)}`);
      labMetrics.criticalDetected(ctx, p.direction);
      return r;
    },
  };
}
