'use client';
// 04-UI-UX §9 breakpoint-set labels and tones (uploaded … discarded). Word + icon + tone (LD-140).
import { Chip, type Tone } from '../common';
import type { BreakpointStatus } from '../../server/types';

export const BP_STATUS: Record<BreakpointStatus, { label: string; tone: Tone }> = {
  uploaded: { label: 'Uploaded', tone: 'neutral' },
  validating: { label: 'Checking', tone: 'info' },
  validated: { label: 'Ready to activate', tone: 'info' },
  invalid: { label: 'Has errors', tone: 'danger' },
  active: { label: 'In use', tone: 'success' },
  retired: { label: 'Retired', tone: 'neutral' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};
export const isChecking = (s: string) => s === 'uploaded' || s === 'validating';

export function BreakpointStatusChip({ status }: { status: string }) {
  const s = Object.hasOwn(BP_STATUS, status) ? BP_STATUS[status as BreakpointStatus] : { label: status, tone: 'neutral' as const };
  return <Chip tone={s.tone} label={s.label} />;
}
