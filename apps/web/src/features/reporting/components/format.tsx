// Shared presentation helpers for the reporting screens (04-UI-UX §1 status/PHI/copy rules). Plain functions only (no 'use client'): importable from server pages too.
import { DateText } from '@lims/ui/components/DateText';
import { StatusChip } from '@lims/ui/components/StatusChip';

export const hasPerm = (permissions: readonly string[], key: string) => permissions.includes(key);
export const newKey = () => crypto.randomUUID();

/** `NPR 1,250.00` — lakh grouping; the server is authoritative, this is display only. */
export function formatNpr(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(Math.trunc(paisa));
  const whole = String(Math.floor(abs / 100));
  const head = whole.slice(0, -3);
  const grouped = (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + whole.slice(-3);
  return `${neg ? '-' : ''}NPR ${grouped}.${String(abs % 100).padStart(2, '0')}`;
}
export const humanize = (code: string) => {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const WHEN_FMT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu' });
/** Plain-string date-time (A.D., Asia/Kathmandu) for sentences where the date must stay in the same text node ("Signed by … on <date>"). */
export const whenText = (iso: string) => WHEN_FMT.format(new Date(iso));
export const When =({ value }: { value: string }) => <DateText value={value as never} mode="AD" withTime />;

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const TONE: Record<string, Tone> = {
  released: 'success', delivered: 'success', read: 'success', confirmed: 'success', ready: 'success', signed: 'success', approved: 'success', active: 'success',
  held: 'warning', queued: 'info', sent: 'info', rendering: 'info', assembling: 'info', ready_to_release: 'info', awaiting_content: 'neutral', pending_scan: 'info', scanning: 'info', sanitizing: 'info', submitted: 'info', draft: 'neutral',
  render_failed: 'danger', failed: 'danger', quarantined: 'danger', rejected: 'danger',
  suppressed: 'neutral', discarded: 'neutral', cancelled: 'neutral', not_required: 'neutral', amending: 'warning',
};
/** Report display status, delivery status, file state: `StatusChip kind="generic"` with the §1 tone mapping. Text always carries the meaning (never colour alone). */
export const Chip = ({ status, label }: { status: string; label?: string | undefined }) => <StatusChip kind="generic" status={status} tone={TONE[status] ?? 'neutral'} label={label ?? humanize(status)} />;

const ERROR_TEXT: Record<string, string> = {
  'common.version_conflict': 'Updated by someone else — reload',
  'common.precondition_required': 'Reload the page and try again',
  'common.validation_failed': 'Check the fields and try again',
  'common.idempotency_key_reused': 'This request was already sent with different content — reload',
  'common.payload_too_large': 'The file is too large',
  'common.unsupported_media_type': 'This file type is not allowed',
  'common.upload_quarantined': 'The file was blocked by the virus scanner',
  'common.immutable_record': 'This record can no longer be changed',
  'common.rate_limited': 'Too many requests — wait a moment and try again',
  'auth.forbidden': 'You do not have permission for this action',
  'reporting.release_blocked_due': 'Held for dues',
  'reporting.release_not_ready': 'Not ready to release yet',
  'reporting.version_not_latest': 'A newer version exists — reload',
  'reporting.report_cancelled': 'The order was cancelled; this report cannot be released',
  'reporting.narrative_locked': 'This report is signed; start an amendment to change it',
  'reporting.template_invalid': 'The template has invalid values',
};
/** Failure reason for inline errors/toasts; unknown codes show the opaque code only (never a raw server message). */
export const errorText = (code: string) => ERROR_TEXT[code] ?? code;

export const FAILURE_TEXT: Record<string, string> = {
  no_consent: 'Not sent: the patient has not agreed to this channel.',
  no_contact: 'Not sent: no phone number or email on file.',
  channel_disabled: 'Not sent: this channel is switched off for your lab.',
  provider_rejected: 'The messaging provider rejected the message.',
  invalid_destination: 'The number or address was not accepted.',
  template_not_approved: 'The WhatsApp template is not approved yet.',
  retries_exhausted: 'Sending failed after several tries.',
  circuit_open: 'The provider is not responding; we will try again.',
  superseded_attempt: 'Replaced by a newer attempt.',
};
