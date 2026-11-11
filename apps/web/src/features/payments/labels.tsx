// Display helpers for the payment screens: lakh-grouped NPR text, plain-words codes, status label from the kit mapping.
import { statusOf } from '@lims/ui/components/StatusChip';
import type { PaymentMoney } from './types';

/** `NPR 1,23,456.00` from integer paisa. String maths only (no float division): the server amount is authoritative. */
export function nprText(m: PaymentMoney | undefined): string {
  if (!m || !Number.isSafeInteger(m.amount_paisa)) return '—';
  const neg = m.amount_paisa < 0;
  const s = String(Math.abs(m.amount_paisa)).padStart(3, '0');
  const whole = s.slice(0, -2);
  const head = whole.slice(0, -3);
  const grouped = (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + whole.slice(-3);
  return `${neg ? '-' : ''}NPR ${grouped}.${s.slice(-2)}`;
}

export const humanize = (code: string | undefined): string => {
  const s = (code ?? '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
};
export const lower = (code: string | undefined): string => humanize(code).toLowerCase();

/** "Under review", "Paid", … (C0 StatusChip mapping, so toasts and chips always agree). */
export const statusLabel = (status: string): string => statusOf('payment_intent', status)[1];
export const statusTone = (status: string) => statusOf('payment_intent', status)[0];

export const GATEWAY_LABEL: Record<string, string> = { esewa: 'eSewa', khalti: 'Khalti', fonepay: 'Fonepay' };
export const gatewayLabel = (g: string): string => GATEWAY_LABEL[g] ?? humanize(g);

export const hasPerm = (permissions: readonly string[], key: string) => permissions.includes(key);
