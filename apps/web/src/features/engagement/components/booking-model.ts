// C16.T-B6 shared types + pure helpers for W1–W5 (contracts/openapi/engagement.yaml: StaffBooking, StaffBookingDetail, StaffSlot,
// SlotTemplate, SlotBlackout, StaffBookableItem). Times are shown in Asia/Kathmandu (C0 CV §4.8). No patient contact fields live here.
import type { StatusChipProps } from '@lims/ui/components/StatusChip';

export type Tone = NonNullable<StatusChipProps['tone']>;

export type BookingKind = 'centre_visit' | 'home_collection';
export type BookingStatus = 'confirmed' | 'checked_in' | 'completed' | 'cancelled';
export interface IndicativePrice { amount_paisa: number; currency: string }
export interface BookingItem { orderable_id: string; display_name: string; indicative_price?: IndicativePrice }
export interface StaffBooking {
  id: string; booking_no: string; booking_kind: BookingKind; centre_id: string; centre_display_name: string; slot_start: string; slot_end: string;
  status: BookingStatus; items: BookingItem[]; created_via: 'app' | 'staff'; version: number; patient_id: string; account_present: boolean;
  order_id?: string; queue_token_id?: string; checked_in_at?: string; cancel_reason_code?: string; cancelled_by_kind?: string;
  /** Fetched server-side from C4 (frontdesk.patient.read); null/absent = not available. */
  patient_name?: string | null;
}
export interface Transition { status: string; at: string; actor_kind?: string }
export interface Centre { id: string; display_name: string; is_home_collection: boolean }
export interface CancelReason { code: string; label: string }
export interface StaffSlot { slot_start: string; slot_end: string; remaining: number; booking_kind: BookingKind; centre_id: string; capacity: number; booked: number; overbooked: boolean }
export interface PatientHit { id: string; name: string; patient_code: string; age: number | string; sex: string }
export interface StaffBookableItem {
  orderable_id: string; kind: 'test' | 'panel'; code: string; display_name: string; booking_kinds: BookingKind[]; indicative_price?: IndicativePrice;
  synced_at?: string; is_active: boolean; version: number; sort_order?: number;
}
export interface SlotTemplate {
  id: string; centre_id: string; booking_kind: BookingKind; weekdays: number[]; start_local: string; end_local: string; slot_minutes: number; capacity: number;
  effective_from: string; effective_to?: string; is_active: boolean; version: number;
}
export type BlackoutReason = 'holiday' | 'maintenance' | 'other';
export interface SlotBlackout {
  id: string; centre_id: string; booking_kind?: BookingKind; starts_at: string; ends_at: string; reason_code: BlackoutReason; note?: string; is_active: boolean; version: number;
}

export const KIND_LABEL: Record<BookingKind, string> = { centre_visit: 'Centre visit', home_collection: 'Home collection' };
export const KIND_OPTIONS = (Object.keys(KIND_LABEL) as BookingKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));
/** 04-UI-UX §4 copy (engagement.booking.status.*); LD-140: every status is tone + word. */
export const STATUS: Record<BookingStatus, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'info' },
  checked_in: { label: 'Checked in', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export const statusOf = (s: string) => STATUS[s as BookingStatus] ?? { label: s, tone: 'neutral' as Tone };
export const SOURCE_LABEL = (v: string) => (v === 'app' ? 'App' : v === 'staff' ? 'Staff' : v);
export const REASON_LABEL: Record<BlackoutReason, string> = { holiday: 'Holiday', maintenance: 'Maintenance', other: 'Other' };

export const TZ = 'Asia/Kathmandu';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
/** 'HH:MM' in Kathmandu. */
export const hhmm = (iso: string) => timeFmt.format(new Date(iso));
/** 'DD/MM/YYYY HH:MM' in Kathmandu. */
export const dateTime = (iso: string) => `${dateFmt.format(new Date(iso))} ${hhmm(iso)}`;
/** 'YYYY-MM-DD' → 'DD/MM/YYYY'. */
export const dmy = (d: string) => d.split('-').reverse().join('/');
// ponytail: fixed +05:45 (Asia/Kathmandu has had no DST since 1986); switch to the kit tz helper if the tenant zone becomes configurable.
/** Kathmandu midnight of an A.D. date as a UTC instant. */
export const dayStartUtc = (d: string) => new Date(`${d}T00:00:00+05:45`).toISOString();
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const DAY_MS = 86_400_000;
/** Number cell text with spacing so a row reads as separate words (copy/paste, screen-reader row summary). */
export const num = (n: number) => ` ${n} `;

/** API problem (thrown by the hosts as Error & { problem }) → message for the user. */
export function bookingProblem(e: unknown): string {
  const p = (e as { problem?: { code?: string; errors?: { pointer?: string }[] } } | null)?.problem;
  switch (p?.code) {
    case 'common.validation_failed':
      return p.errors?.some((x) => x.pointer === '/start_local') ? 'These hours overlap another template for this centre and type.' : 'Check the values and try again.';
    case 'common.version_conflict': return 'This record was changed by someone else. Reload and try again.';
    case 'auth.forbidden': return 'You do not have permission to do this.';
    case 'engagement.slot_unavailable': return 'That slot is no longer available. Choose another slot.';
    case 'engagement.queue_closed': return 'That queue is closed. Choose another queue or check in without a token.';
    case 'engagement.booking_invalid_transition': return 'This booking has already changed. Reload the page.';
    default: return 'Something went wrong. Try again.';
  }
}
