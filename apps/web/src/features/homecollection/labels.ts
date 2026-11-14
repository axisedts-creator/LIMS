// Display helpers for the dispatch board (04-UI-UX §2.1): visit status / flag / kind words, Asia/Kathmandu day arithmetic, plain-words error text.
// A problem code or a server detail is never shown to a user.
export type VisitTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const humanize = (code: string | undefined): string => {
  const s = (code ?? '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
};
export const hasPerm = (permissions: readonly string[], key: string) => permissions.includes(key);

/** §2.1 "Visit status chip labels and tones" (generic chip: the kit has no `visit` kind). */
export const VISIT_STATUS: Record<string, readonly [VisitTone, string]> = {
  unassigned: ['neutral', 'Unassigned'], assigned: ['info', 'Assigned'], in_progress: ['info', 'In progress'],
  completed: ['success', 'Completed'], failed: ['danger', 'Failed'], cancelled: ['neutral', 'Cancelled'],
};
export const visitStatus = (s: string): readonly [VisitTone, string] => VISIT_STATUS[s] ?? ['neutral', humanize(s)];

export const KIND_LABEL: Record<string, string> = { booking: 'Booking', front_desk: 'Front desk', recollection: 'Recollection', revisit: 'Revisit' };
export const kindLabel = (k: string) => KIND_LABEL[k] ?? humanize(k);

/** §2.1 "Flag badge labels" (word + tone; the icon comes from the tone). */
export const FLAG: Record<string, readonly [VisitTone, string]> = {
  address_missing: ['warning', 'Address needed'], collected_after_cancel: ['danger', 'Collected after cancel'], held_collection: ['warning', 'Collection on hold'],
  cancel_requested_after_start: ['warning', 'Cancel requested'], order_cancel_required: ['warning', 'Cancel order in front desk'], missed: ['danger', 'Missed'],
  recollection_required: ['warning', 'Recollection'], handover_overdue: ['warning', 'Tubes not handed over'], handover_discrepancy: ['danger', 'Missing tube'],
  identity_mismatch: ['danger', 'ID mismatch'], specimen_not_collected: ['warning', 'Tube not collected'], payment_rejected: ['danger', 'Payment needs entry'],
};
export const flagOf = (k: string): readonly [VisitTone, string] => FLAG[k] ?? ['neutral', humanize(k)];

/** Icon for a tone, so status is never colour alone (LD-140). */
export const toneIcon = (t: string): 'info' | 'check' | 'warning' | 'danger' | 'critical' =>
  t === 'success' ? 'check' : t === 'warning' ? 'warning' : t === 'danger' ? 'danger' : t === 'critical' ? 'critical' : 'info';

// ---- Asia/Kathmandu is UTC+05:45 without DST ----
const NPT_MS = 20_700_000;
const p2 = (n: number) => String(n).padStart(2, '0');
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const dayNpt = (nowMs: number = Date.now()): string => new Date(nowMs + NPT_MS).toISOString().slice(0, 10);
export const dayOfInstant = (iso: string | undefined): string | undefined => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? undefined : dayNpt(t); };
/** `HH:MM` (24 h) of an instant in Kathmandu. */
export const timeOfInstant = (iso: string): string => new Date(Date.parse(iso) + NPT_MS).toISOString().slice(11, 16);
/** The instant of a Kathmandu day + `HH:MM`. */
export const instantOf = (day: string, hhmm: string): string => new Date(`${day}T${hhmm}:00+05:45`).toISOString();
/** `hh:mm AM` in Kathmandu. */
export function time12(iso: string): string {
  const d = new Date(Date.parse(iso) + NPT_MS);
  const h = d.getUTCHours();
  return `${p2(h % 12 === 0 ? 12 : h % 12)}:${p2(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
/** A real calendar day `YYYY-MM-DD` (rejects 2026-13-45). */
export function isRealDay(s: string | undefined): s is string {
  const m = s ? DAY.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---- error text (04-UI-UX §2.1 gives the Assign copy; the rest is plain words) ----
export const OTHER_FAILURE = 'Something went wrong. Try again; if it keeps failing, contact support.';
export const CHANGED = 'This visit changed. Reload the page to see the latest.';
export interface Failure { status: number; code: string; pointers?: readonly string[] | undefined }

const COMMON: Record<string, string> = {
  'auth.forbidden': 'You do not have permission to do this.',
  'auth.mfa_required': 'Confirm it is you with your second sign-in step, then try again.',
  'common.version_conflict': CHANGED,
  'homecollection.visit_closed': 'This visit is closed (completed, failed or cancelled) and can no longer be changed.',
  'homecollection.mutation_superseded': "The phlebotomist has already started this visit, so it can't be changed here. It may have changed; reload the page.",
};
export function failText(r: Failure, validation = 'Check the values and try again.', changed = CHANGED): string {
  if (r.code === 'common.validation_failed') return validation;
  if (r.code === 'common.version_conflict') return changed;
  return COMMON[r.code] ?? OTHER_FAILURE;
}

// ---- HC-T20: handovers, phones, settings ----
/** §2.3 "Status (StatusChip generic: Waiting warning / Received success / Missing tubes danger)". */
export const HANDOVER_STATUS: Record<string, readonly [VisitTone, string]> = {
  pending: ['warning', 'Waiting'], confirmed: ['success', 'Received'], discrepancy: ['danger', 'Missing tubes'],
};
export const handoverStatus = (s: string): readonly [VisitTone, string] => HANDOVER_STATUS[s] ?? ['neutral', humanize(s)];
/** One tube's outcome in a handled handover. */
export const TUBE_OUTCOME: Record<string, readonly [VisitTone, string]> = { received: ['success', 'Received'], missing: ['danger', 'Missing'] };
export const tubeOutcome = (s: string): readonly [VisitTone, string] => TUBE_OUTCOME[s] ?? ['neutral', humanize(s)];
export const HANDOVER_CHANGED = 'This handover has already been handled or has changed. Close this panel and refresh the page.';

/** §2.4 "Status (Active info, Signed off neutral, Wipe requested warning, Wiped neutral)". */
export const DEVICE_STATUS: Record<string, readonly [VisitTone, string]> = {
  active: ['info', 'Active'], signed_off: ['neutral', 'Signed off'], wipe_requested: ['warning', 'Wipe requested'], wiped: ['neutral', 'Wiped'],
};
export const deviceStatus = (s: string): readonly [VisitTone, string] => DEVICE_STATUS[s] ?? ['neutral', humanize(s)];
export const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iOS' };
export const DEVICE_CHANGED = 'This phone has already changed (for example it was wiped). Refresh the page to see the latest.';
export const SETTINGS_CHANGED = 'Settings were changed by someone else. Reload the page to see the latest, then make your change again.';

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export const isSemver = (v: string): boolean => v.length <= 20 && SEMVER.test(v);
/** Numeric semver compare (1.9.0 < 1.10.0); undefined when either side is not a plain x.y.z. */
export function semverLess(a: string, b: string): boolean | undefined {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) if (+x[i]! !== +y[i]!) return +x[i]! < +y[i]!;
  return false;
}

export function assignFailText(r: Failure): string {
  switch (r.code) {
    case 'common.validation_failed':
      return r.pointers?.includes('/phlebotomist_membership_id') ? "This phlebotomist's route is full for that day." : 'Check the phlebotomist, route date and position, then try again.';
    case 'homecollection.visit_incomplete': return 'Add an address and a time window first.';
    case 'homecollection.phlebotomist_not_eligible': return "This person can't take visits for this centre.";
    case 'frontdesk.consent_required': return "The patient's consent is missing in front desk. Ask front desk to complete registration.";
    case 'catalog.no_price': return 'A booked test has no price. Ask the lab manager to fix the price list.';
    case 'catalog.test_inactive': return 'A booked test is no longer offered.';
    default: return failText(r);
  }
}
