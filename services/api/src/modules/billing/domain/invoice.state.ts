// Invoice state machine (03-IC §10.5; 03-APP-FLOW §1.2 B4; 05-SCHEMA invoices__status__ck). No draft, no delete; cancelled never reverts. Pure.

export const INVOICE_STATUSES = ['issued', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type Check = { ok: true } | { ok: false; code: string };

const NEXT: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = { issued: ['cancelled'], cancelled: [] };

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: InvoiceStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
/** invoices.is_active = (status = issued). */
export const isActive = (s: InvoiceStatus): boolean => s === 'issued';

export function checkCancel(i: { status: InvoiceStatus; reasonCode?: string }): Check {
  if (i.status === 'cancelled') return { ok: false, code: 'billing.invoice_already_cancelled' };
  if (typeof i.reasonCode !== 'string' || i.reasonCode.trim() === '') return { ok: false, code: 'billing.cancel_reason_required' };
  return canTransition(i.status, 'cancelled') ? { ok: true } : { ok: false, code: 'common.validation_failed' };
}
