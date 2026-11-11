// Display helpers for the payment screens: lakh-grouped NPR text, plain-words codes, status label from the kit mapping.
import { statusOf } from '@lims/ui/components/StatusChip';
import type { Money } from '@lims/ui/components/MoneyField';
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

/** DTO money → kit Money for MoneyText (04-UI-UX:21); undefined when absent/invalid. */
export const kitMoney = (m: PaymentMoney | undefined): Money | undefined =>
  m && Number.isSafeInteger(m.amount_paisa) ? { amountPaisa: m.amount_paisa, currency: 'NPR' } : undefined;

export const humanize =(code: string | undefined): string => {
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

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
/** Refund states (04-UI-UX §2.3): text + tone, rendered through StatusChip kind="generic". */
export const REFUND_STATUS: Record<string, readonly [Tone, string]> = {
  pending_approval: ['warning', 'Waiting for approval'], approved: ['info', 'Approved'], requested: ['info', 'Refund in progress'], held_for_review: ['warning', 'Under review'],
  completed: ['success', 'Completed'], failed: ['danger', 'Failed'], rejected: ['neutral', 'Rejected'],
};
export const refundStatus = (s: string): readonly [Tone, string] => REFUND_STATUS[s] ?? ['neutral', humanize(s)];

const NPT_MS = 20_700_000; // Asia/Kathmandu is UTC+05:45, no DST
/** Today as an A.D. day in Asia/Kathmandu (business dates are Nepal days). */
export const dayNpt = (nowMs: number = Date.now()): string => new Date(nowMs + NPT_MS).toISOString().slice(0, 10);
/** The Nepal day of an instant. */
export const dayOfInstant = (iso: string): string | undefined => { const t = Date.parse(iso); return Number.isNaN(t) ? undefined : dayNpt(t); };
/** `DD/MM/YYYY hh:mm AM` in Asia/Kathmandu (same text the kit DateText shows); `—` when missing / invalid. */
export function instantText(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '—';
  const d = new Date(t + NPT_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(h % 12 === 0 ? 12 : h % 12)}:${p(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
