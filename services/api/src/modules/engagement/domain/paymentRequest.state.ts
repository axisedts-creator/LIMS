// Payment request state machine (03-APP-FLOW §4.2; 05-SCHEMA payment_requests__status__ck). ready->ready = idempotent refresh. Pure.

export const PAYMENT_REQUEST_STATUSES = ['queued', 'ready', 'completed', 'failed', 'expired'] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

const NEXT: Readonly<Record<PaymentRequestStatus, readonly PaymentRequestStatus[]>> = {
  queued: ['ready', 'failed'],
  ready: ['completed', 'expired', 'ready'],
  completed: [],
  failed: [],
  expired: [],
};

export function canTransition(from: PaymentRequestStatus, to: PaymentRequestStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: PaymentRequestStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
