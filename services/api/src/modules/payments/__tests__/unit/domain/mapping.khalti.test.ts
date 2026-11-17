// PG-T02 — TRD §7.3.4 Khalti lookup status -> GatewayOutcome table, every cell (US-PG-04 AC2–6, REQ-SEC-048).
// Input: { statusRaw: string | null, amountMatches, beforeDeadline, intentStatus }; statusRaw null = no `status` in body
// answer (5xx/timeout/network) -> retry. The HTTP code is never an input: the body status is the signal (04 P4).
import { describe, expect, it } from 'vitest';
import { mapKhaltiStatus } from '../../../domain/mapping.khalti.js';

type O = { kind: string; reason?: string; finding?: string };
const settle: O = { kind: 'settle' }, stay: O = { kind: 'stay' }, retry: O = { kind: 'retry' }, expire: O = { kind: 'expire' };
const ok: O = { kind: 'ok' };
const hold = (reason: string): O => ({ kind: 'hold', reason });
const fail = (reason: string): O => ({ kind: 'fail', reason });
const finding = (f: string): O => ({ kind: 'finding', finding: f });

// Columns: openBefore, openAfter, held, failedOrExpired, settledOrRefunded
type Row = { name: string; status: string | null; amountMatches: boolean; cells: [O, O, O, O, O] };
const div = finding('status_divergence');
const ROWS: Row[] = [
  { name: 'Completed + equal', status: 'Completed', amountMatches: true,
    cells: [settle, settle, settle, hold('late_payment_found'), ok] },
  { name: 'Completed + differs', status: 'Completed', amountMatches: false,
    cells: [hold('amount_mismatch'), hold('amount_mismatch'), stay, hold('amount_mismatch'), finding('amount_mismatch')] },
  { name: 'Pending', status: 'Pending', amountMatches: true,
    cells: [hold('gateway_pending'), hold('gateway_pending'), stay, stay, div] },
  { name: 'Initiated (CR-C15-001 refinement)', status: 'Initiated', amountMatches: true,
    cells: [stay, hold('gateway_initiated_after_expiry'), stay, stay, div] },
  { name: 'Refunded', status: 'Refunded', amountMatches: true,
    cells: [hold('gateway_refunded_before_settle'), hold('gateway_refunded_before_settle'), stay, stay, finding('gateway_refund_unrecorded')] },
  { name: 'Partially Refunded', status: 'Partially Refunded', amountMatches: true,
    cells: [hold('gateway_refunded_before_settle'), hold('gateway_refunded_before_settle'), stay, stay, finding('gateway_refund_unrecorded')] },
  { name: 'Expired', status: 'Expired', amountMatches: true,
    cells: [expire, expire, stay, stay, div] },
  { name: 'User canceled', status: 'User canceled', amountMatches: true,
    cells: [fail('gateway_cancelled'), fail('gateway_cancelled'), stay, stay, div] },
  { name: 'Canceled', status: 'Canceled', amountMatches: true,
    cells: [fail('gateway_cancelled'), fail('gateway_cancelled'), stay, stay, div] },
  { name: 'Failed', status: 'Failed', amountMatches: true,
    cells: [fail('gateway_cancelled'), fail('gateway_cancelled'), stay, stay, div] },
  { name: 'any other string', status: 'Something Else', amountMatches: true,
    cells: [hold('gateway_status_unknown'), hold('gateway_status_unknown'), stay, stay, div] },
  { name: 'no status (5xx / timeout / network)', status: null, amountMatches: true,
    cells: [retry, retry, retry, retry, retry] },
];

const COLS: Array<{ col: string; statuses: string[]; beforeDeadline: boolean; idx: number }> = [
  { col: 'open before deadline', statuses: ['initiated', 'pending'], beforeDeadline: true, idx: 0 },
  { col: 'open after deadline', statuses: ['initiated', 'pending'], beforeDeadline: false, idx: 1 },
  { col: 'held_for_review (before deadline)', statuses: ['held_for_review'], beforeDeadline: true, idx: 2 },
  { col: 'held_for_review (after deadline)', statuses: ['held_for_review'], beforeDeadline: false, idx: 2 },
  { col: 'failed/expired', statuses: ['failed', 'expired'], beforeDeadline: false, idx: 3 },
  { col: 'settled/refunded', statuses: ['settled', 'partially_refunded', 'refunded'], beforeDeadline: false, idx: 4 },
];

describe('mapKhaltiStatus — §7.3.4', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      for (const c of COLS) {
        for (const intentStatus of c.statuses) {
          it(`${c.col} [${intentStatus}]`, () => {
            const got = mapKhaltiStatus({ statusRaw: row.status, amountMatches: row.amountMatches, beforeDeadline: c.beforeDeadline, intentStatus: intentStatus as never });
            expect(got).toEqual(row.cells[c.idx]);
          });
        }
      }
    });
  }

  it('amountMatches is irrelevant for non-Completed statuses', () => {
    for (const st of ['Pending', 'Initiated', 'Refunded', 'Expired', 'User canceled', 'Failed']) {
      const a = mapKhaltiStatus({ statusRaw: st, amountMatches: true, beforeDeadline: true, intentStatus: 'initiated' });
      const b = mapKhaltiStatus({ statusRaw: st, amountMatches: false, beforeDeadline: true, intentStatus: 'initiated' });
      expect(b, st).toEqual(a);
    }
  });

  it('status strings are compared exactly (case-sensitive) after trimming', () => {
    const ctx = { amountMatches: true, beforeDeadline: true, intentStatus: 'initiated' as never };
    expect(mapKhaltiStatus({ ...ctx, statusRaw: ' Completed ' })).toEqual(settle);
    expect(mapKhaltiStatus({ ...ctx, statusRaw: 'completed' })).toEqual(hold('gateway_status_unknown'));
    expect(mapKhaltiStatus({ ...ctx, statusRaw: 'COMPLETED' })).toEqual(hold('gateway_status_unknown'));
    expect(mapKhaltiStatus({ ...ctx, statusRaw: 'user canceled' })).toEqual(hold('gateway_status_unknown'));
  });

  it('a Completed answer with an off-by-one-paisa amount never settles (ST-03)', () => {
    for (const s of ['initiated', 'pending', 'held_for_review'] as const) {
      expect(mapKhaltiStatus({ statusRaw: 'Completed', amountMatches: false, beforeDeadline: true, intentStatus: s }).kind).not.toBe('settle');
    }
  });
});
