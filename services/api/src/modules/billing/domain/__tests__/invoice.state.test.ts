// BL-T02 invoice.state.ts (03-IC §10.5; 05-SCHEMA invoices__status__ck/__active__ck/__cancel__ck; US-BL-02.1).
// Assumed API: INVOICE_STATUSES, canTransition(from,to), isTerminal(status), isActive(status), checkCancel({status, reasonCode?}) -> {ok:true}|{ok:false, code}
import { describe, expect, it } from 'vitest';
import { INVOICE_STATUSES, canTransition, checkCancel, isActive, isTerminal } from '../invoice.state.js';

const ALLOWED: Record<string, string[]> = { issued: ['cancelled'], cancelled: [] };

describe('invoice state table (no draft, no delete, cancelled never reverts — 02-CV §5.7)', () => {
  it('has exactly the two DB states', () => expect([...INVOICE_STATUSES].sort()).toEqual(['cancelled', 'issued']));
  const pairs = INVOICE_STATUSES.flatMap((f) => INVOICE_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to)));
  it('forbidden: cancelled -> issued', () => expect(canTransition('cancelled', 'issued')).toBe(false));
  it('rejects unknown/draft statuses', () => {
    expect(canTransition('draft' as never, 'issued')).toBe(false);
    expect(canTransition('issued', 'draft' as never)).toBe(false);
    expect(canTransition('issued', 'deleted' as never)).toBe(false);
  });
  it('cancelled is terminal; issued is not', () => {
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('issued')).toBe(false);
  });
  it('is_active = (status = issued)', () => {
    expect(isActive('issued')).toBe(true);
    expect(isActive('cancelled')).toBe(false);
  });
});

describe('checkCancel (B4 guards: reason required; double cancel)', () => {
  it('issued + reason -> ok', () => expect(checkCancel({ status: 'issued', reasonCode: 'wrong_patient' })).toEqual({ ok: true }));
  it('cancelled -> billing.invoice_already_cancelled', () => {
    expect(checkCancel({ status: 'cancelled', reasonCode: 'wrong_patient' })).toEqual({ ok: false, code: 'billing.invoice_already_cancelled' });
  });
  it('already-cancelled wins over a missing reason', () => {
    expect(checkCancel({ status: 'cancelled' })).toEqual({ ok: false, code: 'billing.invoice_already_cancelled' });
  });
  it.each([undefined, '', '   '])('issued + reason %j -> billing.cancel_reason_required', (reasonCode) => {
    expect(checkCancel({ status: 'issued', reasonCode })).toEqual({ ok: false, code: 'billing.cancel_reason_required' });
  });
});
