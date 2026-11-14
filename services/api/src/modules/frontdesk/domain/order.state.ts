// Order state machine (03-APP-FLOW §1.1; 03-IC §10.4; US-FD-11.1-11.3). Pure.

export const ORDER_STATUSES = ['pre_registered', 'registered', 'in_progress', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** LabPort item processingStatus. */
export type ItemProcessingStatus = 'not_started' | 'in_progress' | 'reported' | 'cancelled';

const NEXT: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pre_registered: ['registered', 'cancelled'],
  registered: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}

export type Check = { ok: true } | { ok: false; code: string };

export function checkCancel(o: { status: OrderStatus; hasApprovedResults: boolean }): Check {
  if (o.status === 'cancelled') return { ok: false, code: 'frontdesk.order_already_cancelled' };
  if (o.hasApprovedResults || !canTransition(o.status, 'cancelled')) return { ok: false, code: 'frontdesk.order_cancel_not_allowed' };
  return { ok: true };
}

/** Derived from lab item states; pre_registered / cancelled / completed are never overridden. */
export function deriveOrderStatus(stored: OrderStatus, items: readonly ItemProcessingStatus[]): OrderStatus {
  if (stored !== 'registered' && stored !== 'in_progress') return stored;
  const reported = items.some((s) => s === 'reported');
  if (reported && items.every((s) => s === 'reported' || s === 'cancelled')) return 'completed';
  if (reported || items.some((s) => s === 'in_progress')) return 'in_progress';
  return stored;
}
