'use client';
// Shared bits for the C10 T-24 screens: problem code → copy (04-UI-UX §10), a status chip with tone + icon + word (LD-140), page-level error notice.
// LD-140 (2026-11-13): kit components and class names only; no hex colours, pixel radii or inline style objects.
import { useRouter } from 'next/navigation';
import { Banner, type BannerProps } from '@lims/ui/components/Banner';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import type { DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { Icon, type IconName } from '@lims/ui/components/Icon';
import type { ActionResult } from '../server/types';

export type Fail = Extract<ActionResult<unknown>, { ok: false }>;
/** The API sends validated IsoUtc strings; the plain-JSON view models carry them as string (same cast as analytics/payments). */
export type IsoUtc = NonNullable<DateTimePickerProps['value']>;
export const asIso = (s: string) => s as IsoUtc;
/** Date (and optionally time) in the tenant timezone; "—" when absent. */
export function When({ value, time }: { value: string | undefined; time?: boolean }) {
  return value ? <DateText value={value as DateTextProps['value']} {...(time ? { withTime: true } : {})} /> : <>—</>;
}
export type Tone = BannerProps['tone'];
export const newKey = () => crypto.randomUUID();

export const PERM = { read: 'micro.culture.read', config: 'micro.config.manage', breakpoint: 'micro.breakpoint.manage' } as const;

/** §10 copy. Codes missing here fall back to GENERIC; the raw code is never shown. `auth.mfa_required` is owned by the shell (no form error). */
const GENERIC = 'Something went wrong. Try again.';
const COPY: Record<string, string> = {
  'micro.breakpoint_import_invalid': "The file can't be used (it must be a UTF-8 CSV that hasn't been uploaded before).",
  'micro.breakpoint_set_invalid_transition': "This table can't change to that state.",
  'micro.breakpoint_four_eyes_required': 'Another user must activate a table you imported.',
  'micro.code_duplicate': 'This code is already used.',
  // T-20 culture page (04-UI-UX §10); the organism text adds the "ask your lab manager" hint of §3.3.
  'micro.culture_invalid_transition': 'This culture has changed. Reload to see its current state.',
  'micro.report_final_locked': 'The final report has been sent. Reopen the culture to make changes.',
  'micro.isolate_invalid_transition': "This isolate can't be changed that way.",
  'micro.organism_code_unknown': 'Choose an organism from the list. Ask your lab manager to add new organisms.',
  'common.version_conflict': 'Someone else changed this. Reload and try again.',
  'common.precondition_required': 'Someone else changed this. Reload and try again.',
  'common.validation_failed': 'Check the values and try again.',
  'auth.forbidden': 'You do not have permission to do this.',
};
export const failText = (f: Fail) => COPY[f.code] ?? GENERIC;

/** role="alert" wrapper (the kit Banner has no live-region role). Version conflicts offer Reload. */
export function FailNotice({ fail }: { fail: Fail | undefined }) {
  const router = useRouter();
  if (!fail || fail.code === 'auth.mfa_required') return null;
  const conflict = fail.code === 'common.version_conflict' || fail.code === 'common.precondition_required' || fail.code === 'micro.culture_invalid_transition';
  return (
    <div role="alert">
      <Banner tone={fail.code === 'micro.breakpoint_four_eyes_required' ? 'warning' : 'danger'} title={failText(fail)} {...(conflict ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
    </div>
  );
}

const TONE_ICON: Record<Tone, IconName> = { neutral: 'info', info: 'info', success: 'check', warning: 'warning', danger: 'danger', critical: 'critical' };
/** [CONV] Kit StatusChip(kind=generic) has no icon; LD-140 wants tone + icon + word, so this uses the kit's chip classes with an Icon inside (CR candidate: icon in StatusChip). */
export function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`lims-chip lims-chip-md lims-tone-${tone}`} data-tone={tone}>
      <Icon name={TONE_ICON[tone]} />
      <span>{label}</span>
    </span>
  );
}

export const yesNo = (b: boolean | undefined) => (b ? 'Yes' : 'No');
export const rowsOf = <T,>(r: ActionResult<T[]>): T[] => (r.ok ? r.data : []);
