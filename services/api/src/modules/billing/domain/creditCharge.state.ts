// Credit charge state machine (03-APP-FLOW §1.7; 05-SCHEMA credit_charges__status__ck, guard "uninvoiced→invoiced|voided only"). Pure.

export const CREDIT_CHARGE_STATUSES = ['uninvoiced', 'invoiced', 'voided'] as const;
export type CreditChargeStatus = (typeof CREDIT_CHARGE_STATUSES)[number];

const NEXT: Readonly<Record<CreditChargeStatus, readonly CreditChargeStatus[]>> = {
  uninvoiced: ['invoiced', 'voided'], invoiced: [], voided: [],
};

export function canTransition(from: CreditChargeStatus, to: CreditChargeStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: CreditChargeStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
