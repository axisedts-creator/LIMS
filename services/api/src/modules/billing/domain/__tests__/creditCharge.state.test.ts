// BL-T02 creditCharge.state.ts (03-APP-FLOW §1.7; 05-SCHEMA credit_charges__status__ck + guard "uninvoiced→invoiced|voided only").
// Assumed API: CREDIT_CHARGE_STATUSES, canTransition(from,to), isTerminal(status)
import { describe, expect, it } from 'vitest';
import { CREDIT_CHARGE_STATUSES, canTransition, isTerminal } from '../creditCharge.state.js';

const ALLOWED: Record<string, string[]> = { uninvoiced: ['invoiced', 'voided'], invoiced: [], voided: [] };

describe('credit charge state table', () => {
  it('has uninvoiced, invoiced, voided', () => expect([...CREDIT_CHARGE_STATUSES].sort()).toEqual(['invoiced', 'uninvoiced', 'voided']));
  const pairs = CREDIT_CHARGE_STATUSES.flatMap((f) => CREDIT_CHARGE_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to)));
  it('forbidden: invoiced -> voided (after invoicing only a partial credit note corrects), voided -> uninvoiced', () => {
    expect(canTransition('invoiced', 'voided')).toBe(false);
    expect(canTransition('voided', 'uninvoiced')).toBe(false);
  });
  it('rejects unknown statuses', () => expect(canTransition('open' as never, 'invoiced')).toBe(false));
  it('invoiced and voided are terminal', () => {
    expect(CREDIT_CHARGE_STATUSES.filter((s) => isTerminal(s)).sort()).toEqual(['invoiced', 'voided']);
  });
});
