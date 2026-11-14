// FD-T02 order.state.ts (03-IC §10.4; US-FD-11.1-11.3). Exhaustive 5x5 matrix = 100 % of transitions + forbidden examples.
// Assumed API (see .orchestra/notes/FD-T02-tests.md): canTransition(from,to), ORDER_STATUSES, checkCancel({status,hasApprovedResults}), deriveOrderStatus(stored, itemStates).
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, canTransition, checkCancel, deriveOrderStatus } from '../order.state.js';

const ALLOWED: Record<string, string[]> = {
  pre_registered: ['registered', 'cancelled'],
  registered: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

describe('order state table', () => {
  it('lists exactly the five stored statuses', () => {
    expect([...ORDER_STATUSES].sort()).toEqual(['cancelled', 'completed', 'in_progress', 'pre_registered', 'registered']);
  });
  const pairs = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to));
  });
  it('nothing leaves cancelled or completed; no self transitions; no backwards', () => {
    for (const s of ORDER_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(canTransition('cancelled', 'registered')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('registered', 'pre_registered')).toBe(false);
  });
  it('rejects unknown statuses', () => {
    expect(canTransition('bogus' as never, 'registered')).toBe(false);
    expect(canTransition('registered', 'bogus' as never)).toBe(false);
  });
});

describe('checkCancel (US-FD-11)', () => {
  it.each(['pre_registered', 'registered', 'in_progress'] as const)('11.1 %s without approved results is cancellable', (status) => {
    expect(checkCancel({ status, hasApprovedResults: false })).toEqual({ ok: true });
  });
  it.each(['pre_registered', 'registered', 'in_progress'] as const)('11.2 %s with an approved result -> order_cancel_not_allowed', (status) => {
    expect(checkCancel({ status, hasApprovedResults: true })).toEqual({ ok: false, code: 'frontdesk.order_cancel_not_allowed' });
  });
  it('11.2 completed is never cancellable', () => {
    expect(checkCancel({ status: 'completed', hasApprovedResults: false })).toEqual({ ok: false, code: 'frontdesk.order_cancel_not_allowed' });
  });
  it('11.3 already cancelled -> order_already_cancelled (wins over approved results)', () => {
    expect(checkCancel({ status: 'cancelled', hasApprovedResults: false })).toEqual({ ok: false, code: 'frontdesk.order_already_cancelled' });
    expect(checkCancel({ status: 'cancelled', hasApprovedResults: true })).toEqual({ ok: false, code: 'frontdesk.order_already_cancelled' });
  });
});

describe('deriveOrderStatus (03-IC §10.4 rows 4-5, from LabPort processingStatus)', () => {
  const D = deriveOrderStatus;
  it('registered with nothing started stays registered', () => {
    expect(D('registered', ['not_started', 'not_started'])).toBe('registered');
    expect(D('registered', [])).toBe('registered');
  });
  it('in_progress iff any active item is in_progress or reported (and not all done)', () => {
    expect(D('registered', ['in_progress', 'not_started'])).toBe('in_progress');
    expect(D('registered', ['reported', 'not_started'])).toBe('in_progress');
  });
  it('completed iff every item reported/cancelled and at least one reported', () => {
    expect(D('registered', ['reported', 'reported'])).toBe('completed');
    expect(D('in_progress', ['reported', 'cancelled'])).toBe('completed');
  });
  it('all items cancelled is NOT completed (needs >= 1 reported)', () => {
    expect(D('registered', ['cancelled', 'cancelled'])).not.toBe('completed');
  });
  it('pre_registered and cancelled are never overridden by lab state', () => {
    expect(D('pre_registered', ['reported'])).toBe('pre_registered');
    expect(D('cancelled', ['reported', 'in_progress'])).toBe('cancelled');
  });
});
