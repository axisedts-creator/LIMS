// BL-T02 cbms.state.ts (03-APP-FLOW §1.6; 05-SCHEMA invoices lifecycle guard; US-BL-13.1-13.3).
// Assumed API: CBMS_STATES, canTransition(from,to), isTerminal(state),
//   canTransitionCancel(from: CbmsState|null, to) — cbms_cancel_state: NULL→not_required|pending, then the same table,
//   nextCbmsState(state, outcome) — outcome ∈ accepted|rejected_permanent|retryable_error|stub_recorded (cbms_submissions__outcome__ck)
import { describe, expect, it } from 'vitest';
import { CBMS_STATES, canTransition, canTransitionCancel, isTerminal, nextCbmsState } from '../cbms.state.js';

const ALLOWED: Record<string, string[]> = {
  not_required: ['pending'],
  pending: ['synced', 'failed_permanent'],
  failed_permanent: ['pending'],
  synced: [],
};

describe('cbms_state table', () => {
  it('has the four DB states', () => expect([...CBMS_STATES].sort()).toEqual(['failed_permanent', 'not_required', 'pending', 'synced']));
  const pairs = CBMS_STATES.flatMap((f) => CBMS_STATES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to)));
  it('forbidden: synced -> anything (terminal), pending -> not_required, not_required -> synced', () => {
    for (const t of CBMS_STATES) expect(canTransition('synced', t)).toBe(false);
    expect(canTransition('pending', 'not_required')).toBe(false);
    expect(canTransition('not_required', 'synced')).toBe(false);
  });
  it('rejects unknown states', () => expect(canTransition('stub_recorded' as never, 'pending')).toBe(false));
  it('only synced is terminal (failed_permanent can be retried by B31)', () => {
    expect(CBMS_STATES.filter((s) => isTerminal(s))).toEqual(['synced']);
  });
});

describe('cbms_cancel_state (invoice_cancellation document; NULL until cancelled)', () => {
  it('NULL -> not_required | pending only', () => {
    expect(canTransitionCancel(null, 'not_required')).toBe(true);
    expect(canTransitionCancel(null, 'pending')).toBe(true);
    expect(canTransitionCancel(null, 'synced')).toBe(false);
    expect(canTransitionCancel(null, 'failed_permanent')).toBe(false);
  });
  it('afterwards the same table as cbms_state', () => {
    for (const f of CBMS_STATES) for (const t of CBMS_STATES) expect(canTransitionCancel(f, t)).toBe(canTransition(f, t));
  });
  it('can never go back to NULL', () => expect(canTransitionCancel('pending', null as never)).toBe(false));
});

describe('nextCbmsState (US-BL-13.1/13.2: the stub never shows synced; retryable keeps pending)', () => {
  it.each([
    ['pending', 'accepted', 'synced'],
    ['pending', 'rejected_permanent', 'failed_permanent'],
    ['pending', 'retryable_error', 'pending'],
    ['pending', 'stub_recorded', 'pending'],
  ] as const)('%s + %s -> %s', (state, outcome, expected) => expect(nextCbmsState(state, outcome)).toBe(expected));
  it('every resulting move is a legal transition or a no-op', () => {
    for (const o of ['accepted', 'rejected_permanent', 'retryable_error', 'stub_recorded'] as const) {
      const n = nextCbmsState('pending', o);
      expect(n === 'pending' || canTransition('pending', n)).toBe(true);
    }
  });
  it('an outcome for a document that is not pending throws (not_required / synced / failed_permanent are never submitted)', () => {
    for (const s of ['not_required', 'synced', 'failed_permanent'] as const) expect(() => nextCbmsState(s, 'accepted')).toThrow();
  });
  it('unknown outcome throws', () => expect(() => nextCbmsState('pending', 'ok' as never)).toThrow());
});
