'use client';
// Shared bits for the C11 T-19 screens: problem code → copy (04-UI-UX §8), a chip with tone + icon + word, the case status / priority / flag
// chips, page-level failure notice, the page shortcut hook. LD-140 (2026-11-13): kit components and class names only; no hex colours,
// pixel radii or inline style objects.
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, type BannerProps } from '@lims/ui/components/Banner';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Icon, type IconName } from '@lims/ui/components/Icon';
import { shortcuts, type Shortcut } from '@/core/shortcuts/registry';
import type { ActionResult, CaseFlags, CaseKind, CaseStatus, LocationStatus } from '../server/types';

export type Fail = Extract<ActionResult<unknown>, { ok: false }>;
export type Tone = BannerProps['tone'];
export const newKey = () => crypto.randomUUID();

/** Date + time in the tenant calendar; "—" when absent. */
export function When({ value, time }: { value: string | undefined; time?: boolean }) {
  return value ? <DateText value={value as DateTextProps['value']} {...(time ? { withTime: true } : {})} /> : <>—</>;
}

const TONE_ICON: Record<Tone, IconName> = { neutral: 'info', info: 'info', success: 'check', warning: 'warning', danger: 'danger', critical: 'critical' };
/** [CONV] Kit StatusChip(kind=generic) has no icon; LD-140 wants tone + icon + word, so this uses the kit's chip classes with an Icon inside (CR candidate: icon in StatusChip, same as C10 T-24). */
export function Chip({ tone, label, size = 'md' }: { tone: Tone; label: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`lims-chip lims-chip-${size} lims-tone-${tone}`} data-tone={tone}>
      <Icon name={TONE_ICON[tone]} />
      <span>{label}</span>
    </span>
  );
}

/** 04-UI-UX §2 status chip tones. */
export const STATUS: Record<CaseStatus, readonly [Tone, string]> = {
  received: ['neutral', 'Received'],
  accessioned: ['info', 'Accessioned'],
  in_processing: ['info', 'In processing'],
  ready_for_reporting: ['warning', 'Ready for reporting'],
  signed_out: ['success', 'Signed out'],
  cancelled: ['neutral', 'Cancelled'],
};
export const KIND_LABEL: Record<CaseKind, string> = { histology: 'Histology', cytology: 'Cytology', ihc: 'IHC', molecular: 'Molecular' };

export function StatusLabel({ status }: { status: CaseStatus }) {
  const [tone, label] = STATUS[status] ?? (['neutral', String(status)] as const);
  return <Chip tone={tone} label={label} />;
}
export const UrgentChip = () => <Chip tone="danger" label="Urgent" />;

/** Block / slide location status: tone + icon + word (LD-140). */
export const LOCATION: Record<LocationStatus, readonly [Tone, string]> = {
  in_lab: ['info', 'In lab'],
  stored: ['success', 'Stored'],
  sent_out: ['warning', 'Sent out'],
  discarded: ['neutral', 'Discarded'],
};
export function LocationChip({ status, text }: { status: LocationStatus; text: string | undefined }) {
  const [tone, label] = LOCATION[status] ?? (['neutral', String(status)] as const);
  return (
    <>
      <Chip size="sm" tone={tone} label={label} />
      {text ? <> <span>{text}</span></> : null}
    </>
  );
}

/** Part letter for a part id ("Part A"); "—" when unknown. */
export const partName = (parts: readonly { id: string; letter: string }[], id: string | undefined) => {
  const p = parts.find((x) => x.id === id);
  return p ? `Part ${p.letter}` : '—';
};

/** Flags carry words, not just icons (04-UI-UX §6). */
export function FlagChips({ flags }: { flags: CaseFlags }) {
  return (
    <>
      {flags.profile_missing ? <Chip size="sm" tone="warning" label="Profile missing" /> : null}
      {flags.specimen_rejected ? <Chip size="sm" tone="danger" label="Specimen rejected" /> : null}
      {flags.open_change ? <Chip size="sm" tone="info" label="Change open" /> : null}
      {flags.pending_stain_orders > 0 ? <Chip size="sm" tone="info" label={`Stains pending ${flags.pending_stain_orders}`} /> : null}
    </>
  );
}

/** §8 copy. Codes missing here fall back to GENERIC; the raw code is never shown. `auth.mfa_required` is owned by the step-up dialog. */
const GENERIC = 'Something went wrong. Try again.';
const COPY: Record<string, string> = {
  'common.version_conflict': 'This case was changed by someone else. Reload to see the latest version.',
  'common.precondition_required': 'This case was changed by someone else. Reload to see the latest version.',
  'anatomic.signout_locked': 'This case is signed out. Use Revise/Amend or add an addendum.',
  'anatomic.accession_duplicate': 'This accession number already exists. Ask an administrator to check the accession pattern.',
  'anatomic.accession_pattern_invalid': 'Accession numbering is misconfigured. Ask an administrator to check the accession pattern.',
  'anatomic.order_item_inactive': 'A test on this case was removed from the order.',
  'anatomic.image_limit_reached': 'This case already has the maximum number of images.',
  'anatomic.block_not_available': 'This block is sent out or discarded.',
  'anatomic.ihc_requires_block': 'IHC must be ordered on a block.',
  'common.payload_too_large': 'This file is larger than 15 MB.',
  'common.unsupported_media_type': 'Only PNG and JPEG images can be uploaded.',
  'common.upload_quarantined': 'This image is still processing or was blocked by the security scan.',
  'common.validation_failed': 'Check the values and try again.',
  'auth.forbidden': 'You do not have permission to do this.',
};
export const isConflict = (f: Fail) => f.code === 'common.version_conflict' || f.code === 'common.precondition_required';
export const failText = (f: Fail, status?: CaseStatus) =>
  f.code === 'anatomic.case_invalid_transition' ? `That step isn't possible for a case in status ${status ?? 'unknown'}.` : (COPY[f.code] ?? GENERIC);

/** role="alert" wrapper (the kit Banner has no live-region role). Version conflicts offer Reload (04-UI-UX §2). */
export function FailNotice({ fail, status, describe }: { fail: Fail | undefined; status?: CaseStatus; /** T-23: own copy for a failure (configuration screens); undefined = the shared copy. */ describe?: (f: Fail) => string | undefined }) {
  const router = useRouter();
  if (!fail || fail.code === 'auth.mfa_required') return null;
  const conflict = isConflict(fail);
  return (
    <div role="alert">
      <Banner tone={conflict ? 'warning' : 'danger'} title={describe?.(fail) ?? failText(fail, status)} {...(conflict ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
    </div>
  );
}

/**
 * Registers page shortcuts (04-UI-UX §3) in the shared registry AND binds one document keydown listener that dispatches them (same as C9's useShortcuts).
 * Skipped while an IME composition is active (Devanagari input). Only `Alt+<letter>` keys are used.
 */
export function usePageShortcuts(pageId: string, list: readonly Shortcut[], deps: readonly unknown[]) {
  const ref = useRef(list);
  ref.current = list;
  useEffect(() => {
    const off = shortcuts.register(pageId, ...list);
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey) return;
      const hit = ref.current.find((s) => s.key.toLowerCase() === `alt+${e.key.toLowerCase()}` || s.key.toLowerCase() === `alt+${e.code.replace(/^Key/, '').toLowerCase()}`);
      if (hit) {
        e.preventDefault();
        hit.run();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      off();
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, ...deps]);
}
