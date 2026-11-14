'use client';
// 04-UI-UX §9 culture status labels and tones; word + icon + tone (LD-140, 2026-11-13) via the shared micro Chip.
import { Chip, type Tone } from '../common';

export const CULTURE_STATUS: Record<string, { label: string; tone: Tone }> = {
  awaiting_setup: { label: 'Awaiting set-up', tone: 'neutral' },
  incubating: { label: 'Incubating', tone: 'info' },
  growth_detected: { label: 'Growth — work-up', tone: 'warning' },
  final_submitted: { label: 'Final submitted', tone: 'success' },
  amending: { label: 'Amending', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function CultureStatusChip({ status }: { status: string }) {
  const s = Object.hasOwn(CULTURE_STATUS, status) ? CULTURE_STATUS[status]! : { label: status, tone: 'neutral' as const };
  return <Chip tone={s.tone} label={s.label} />;
}
