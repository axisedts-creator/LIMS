// PG-T02 — TRD §7.2.4 eSewa status -> GatewayOutcome table, every cell (US-PG-03 AC4–6, REQ-SEC-048).
// Input: { statusRaw: string | null, amountMatches, beforeDeadline, intentStatus }; statusRaw null = no answer
// (`{"code":0}`, HTTP 5xx, timeout, network). Outcome: { kind } | { kind:'fail'|'hold', reason } | { kind:'finding', finding }.
import { describe, expect, it } from 'vitest';
import { mapEsewaStatus } from '../../../domain/mapping.esewa.js';

type O = { kind: string; reason?: string; finding?: string };
const settle: O = { kind: 'settle' }, stay: O = { kind: 'stay' }, retry: O = { kind: 'retry' }, expire: O = { kind: 'expire' };
const ok: O = { kind: 'ok' };
const hold = (reason: string): O => ({ kind: 'hold', reason });
const fail = (reason: string): O => ({ kind: 'fail', reason });
const finding = (f: string): O => ({ kind: 'finding', finding: f });

// Columns: openBefore, openAfter, held, failedOrExpired, settledOrRefunded
type Row = { name: string; status: string | null; amountMatches: boolean; cells: [O, O, O, O, O]; openBeforePending?: O };
const ROWS: Row[] = [
  { name: 'COMPLETE + equal', status: 'COMPLETE', amountMatches: true,
    cells: [settle, settle, settle, hold('late_payment_found'), ok] },
  { name: 'COMPLETE + differs', status: 'COMPLETE', amountMatches: false,
    cells: [hold('amount_mismatch'), hold('amount_mismatch'), stay, hold('amount_mismatch'), finding('amount_mismatch')] },
  { name: 'AMBIGUOUS', status: 'AMBIGUOUS', amountMatches: true,
    cells: [hold('gateway_ambiguous'), hold('gateway_ambiguous'), stay, hold('gateway_ambiguous'), finding('status_divergence')] },
  { name: 'AMBIGIOUS (documented misspelling)', status: 'AMBIGIOUS', amountMatches: true,
    cells: [hold('gateway_ambiguous'), hold('gateway_ambiguous'), stay, hold('gateway_ambiguous'), finding('status_divergence')] },
  { name: 'FULL_REFUND', status: 'FULL_REFUND', amountMatches: true,
    cells: [hold('gateway_refunded_before_settle'), hold('gateway_refunded_before_settle'), stay, stay, finding('gateway_refund_unrecorded')] },
  { name: 'PARTIAL_REFUND', status: 'PARTIAL_REFUND', amountMatches: true,
    cells: [hold('gateway_refunded_before_settle'), hold('gateway_refunded_before_settle'), stay, stay, finding('gateway_refund_unrecorded')] },
  { name: 'NOT_FOUND', status: 'NOT_FOUND', amountMatches: true,
    cells: [stay, expire, stay, stay, finding('status_divergence')] },
  { name: 'CANCELED', status: 'CANCELED', amountMatches: true,
    cells: [fail('gateway_cancelled'), fail('gateway_cancelled'), stay, stay, finding('status_divergence')] },
  { name: 'no answer ({"code":0}, 5xx, timeout, network)', status: null, amountMatches: true,
    cells: [retry, retry, retry, retry, retry] },
  { name: 'other status (unknown)', status: 'SOMETHING_NEW', amountMatches: true,
    cells: [retry, retry, stay, stay, finding('status_divergence')] },
];

// Column -> (intentStatus, beforeDeadline) probes. Open column is probed with both open statuses.
const COLS: Array<{ col: string; statuses: string[]; beforeDeadline: boolean }> = [
  { col: 'open before deadline', statuses: ['initiated', 'pending'], beforeDeadline: true },
  { col: 'open after deadline', statuses: ['initiated', 'pending'], beforeDeadline: false },
  { col: 'held_for_review', statuses: ['held_for_review'], beforeDeadline: true },
  { col: 'held_for_review (after deadline)', statuses: ['held_for_review'], beforeDeadline: false },
  { col: 'failed/expired', statuses: ['failed', 'expired'], beforeDeadline: false },
  { col: 'settled/refunded', statuses: ['settled', 'partially_refunded', 'refunded'], beforeDeadline: false },
];
const cellIndex = (i: number) => (i <= 1 ? i : i === 2 ? 2 : i === 3 ? 2 : i === 4 ? 3 : 4);

describe('mapEsewaStatus — §7.2.4', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      COLS.forEach((c, i) => {
        for (const intentStatus of c.statuses) {
          // eSewa PENDING has its own block below; excluded from ROWS.
          it(`${c.col} [${intentStatus}]`, () => {
            const got = mapEsewaStatus({ statusRaw: row.status, amountMatches: row.amountMatches, beforeDeadline: c.beforeDeadline, intentStatus: intentStatus as never });
            expect(got).toEqual(row.cells[cellIndex(i)]);
          });
        }
      });
    });
  }

  describe('PENDING', () => {
    const base = { statusRaw: 'PENDING', amountMatches: true };
    it('open before deadline: initiated -> to_pending (I3)', () => {
      expect(mapEsewaStatus({ ...base, beforeDeadline: true, intentStatus: 'initiated' })).toEqual({ kind: 'to_pending' });
    });
    it('open before deadline: already pending -> stay', () => {
      expect(mapEsewaStatus({ ...base, beforeDeadline: true, intentStatus: 'pending' })).toEqual({ kind: 'stay' });
    });
    it.each(['initiated', 'pending'])('open after deadline [%s] -> hold(gateway_pending_after_expiry)', (s) => {
      expect(mapEsewaStatus({ ...base, beforeDeadline: false, intentStatus: s as never })).toEqual(hold('gateway_pending_after_expiry'));
    });
    it.each([true, false])('held_for_review (beforeDeadline=%s) -> stay', (b) => {
      expect(mapEsewaStatus({ ...base, beforeDeadline: b, intentStatus: 'held_for_review' })).toEqual(stay);
    });
    it.each(['failed', 'expired'])('%s -> stay', (s) => {
      expect(mapEsewaStatus({ ...base, beforeDeadline: false, intentStatus: s as never })).toEqual(stay);
    });
    it.each(['settled', 'partially_refunded', 'refunded'])('%s -> finding status_divergence', (s) => {
      expect(mapEsewaStatus({ ...base, beforeDeadline: false, intentStatus: s as never })).toEqual(finding('status_divergence'));
    });
  });

  it('amountMatches is irrelevant for non-COMPLETE statuses', () => {
    for (const st of ['PENDING', 'AMBIGUOUS', 'NOT_FOUND', 'CANCELED', 'FULL_REFUND']) {
      const a = mapEsewaStatus({ statusRaw: st, amountMatches: true, beforeDeadline: true, intentStatus: 'initiated' });
      const b = mapEsewaStatus({ statusRaw: st, amountMatches: false, beforeDeadline: true, intentStatus: 'initiated' });
      expect(b, st).toEqual(a);
    }
  });

  it('status strings are compared exactly (case-sensitive) after trimming', () => {
    const ctx = { amountMatches: true, beforeDeadline: true, intentStatus: 'initiated' as never };
    expect(mapEsewaStatus({ ...ctx, statusRaw: '  COMPLETE\n' })).toEqual(settle);
    expect(mapEsewaStatus({ ...ctx, statusRaw: 'complete' })).toEqual(retry); // unknown string, not COMPLETE
    expect(mapEsewaStatus({ ...ctx, statusRaw: 'Complete' })).toEqual(retry);
    expect(mapEsewaStatus({ ...ctx, statusRaw: 'canceled' })).toEqual(retry);
  });

  it('a COMPLETE answer with an off-by-one-paisa amount never settles (ST-03)', () => {
    for (const s of ['initiated', 'pending', 'held_for_review'] as const) {
      const got = mapEsewaStatus({ statusRaw: 'COMPLETE', amountMatches: false, beforeDeadline: true, intentStatus: s });
      expect(got.kind).not.toBe('settle');
    }
  });
});
