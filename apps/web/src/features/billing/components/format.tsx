// Shared presentation helpers for the billing screens (04-UI-UX §1 money/dates/copy rules, §9 text-not-colour).
import { Banner } from '@lims/ui/components/Banner';
import { DateText } from '@lims/ui/components/DateText';
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { Money } from '../server/types';

export const hasPerm = (permissions: readonly string[], key: string) => permissions.includes(key);

/** `NPR 1,250.00` — lakh grouping like the kit's MoneyText (12,34,567.89); the server is authoritative, this is display only. */
export function formatNpr(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(Math.trunc(paisa));
  const whole = String(Math.floor(abs / 100));
  const head = whole.slice(0, -3);
  const grouped = (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + whole.slice(-3);
  return `${neg ? '-' : ''}NPR ${grouped}.${String(abs % 100).padStart(2, '0')}`;
}
export const npr = (m: Money | undefined) => (m ? formatNpr(m.amount_paisa) : '—');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n: number) => (n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const below1000 = (n: number) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${below100(n % 100)}` : ''}` : below100(n));
/** Amount in words with Nepali place values (crore, lakh, thousand): `One Thousand One Hundred Thirty Rupees Only`. */
export function amountInWords(paisa: number): string {
  let rupees = Math.floor(Math.abs(paisa) / 100);
  const ps = Math.abs(paisa) % 100;
  const parts: string[] = [];
  for (const [unit, name] of [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']] as const) {
    const n = Math.floor(rupees / unit);
    if (n) parts.push(`${below1000(n)} ${name}`);
    rupees %= unit;
  }
  if (rupees) parts.push(below1000(rupees));
  const r = parts.join(' ') || 'Zero';
  return `${r} Rupees${ps ? ` and ${below100(ps)} Paisa` : ''} Only`;
}

export const humanize = (code: string) => {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** A.D. (DD/MM/YYYY) from an instant, read in Asia/Kathmandu by the kit. */
export const Ad = ({ value, withTime }: { value: string; withTime?: boolean }) => <DateText value={value as never} mode="AD" {...(withTime ? { withTime: true } : {})} />;

/** Fiscal documents and statutory registers always show B.S. AND A.D. (04-UI-UX header; 02-CV §13). `bs` is the server's value when it has one. */
export function BsAd({ bs, utc, ad, withTime }: { bs?: string | undefined; utc?: string | undefined; ad?: string | undefined; withTime?: boolean }) {
  const adValue = ad ?? utc;
  return (
    <span className="lims-bs-ad">
      {bs ? <>{bs} B.S.</> : adValue ? <DateText value={adValue as never} mode="BS" /> : '—'}
      {' / '}
      {adValue ? <Ad value={adValue} {...(withTime ? { withTime: true } : {})} /> : '—'}
    </span>
  );
}

export const InvoiceStatus = ({ status }: { status: string }) => <StatusChip kind="invoice" status={status} />;

// CBMS status under the stub client (04-UI-UX §1 copy rules). Never wording that implies approval by the tax authority.
export const CBMS_NOT_SENT = 'Not sent — CBMS connection not configured';
export function cbmsLabel(state: string, mode: 'stub' | 'live' = 'stub'): string {
  if (state === 'not_required') return 'Not required';
  if (state === 'sent' || state === 'accepted') return 'Sent';
  if (state === 'failed_permanent') return 'Failed';
  if (state === 'failed_retry') return 'Retrying';
  if (state === 'pending') return mode === 'stub' ? CBMS_NOT_SENT : 'Queued';
  return humanize(state);
}

export const CBMS_STUB_BANNER = 'CBMS connection is not configured. Documents are queued and will be sent once the connection is set up.';

export function StubBanner() {
  return <Banner tone="info" title={CBMS_STUB_BANNER} />;
}

const ERROR_TEXT: Record<string, string> = {
  'common.version_conflict': 'Updated by someone else — reload',
  'common.precondition_required': 'Reload the page and try again',
  'billing.cancel_reason_required': 'Choose a reason',
  'billing.invoice_already_cancelled': 'This invoice is already cancelled',
  'billing.counter_busy': 'The invoice counter is busy — try again',
  'billing.refund_self_approval_forbidden': 'Needs another approver',
  'auth.forbidden': 'You do not have permission for this action',
};
/** Failure reason for toasts/inline errors; unknown codes are shown as the opaque code only (no raw server message). */
export const errorText = (code: string) => ERROR_TEXT[code] ?? code;

/** Whole days between an instant and now; `now` is injected so renders stay pure. */
export const ageDays = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
