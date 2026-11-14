// C13 T04 — manifest line state table (03-APP-FLOW §2.2 LS1–LS11). Pure. null = no row yet.
import { LimsError } from '../../../core/errors.js';

export const MANIFEST_LINE_STATES = ['draft', 'submitted', 'converting', 'converted', 'conversion_failed', 'not_received', 'cancelled', 'withdrawn', 'discarded'] as const;
export type ManifestLineState = (typeof MANIFEST_LINE_STATES)[number];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '(none)': ['draft'],
  draft: ['submitted', 'converting', 'discarded'],
  submitted: ['converting', 'not_received', 'withdrawn'],
  converting: ['converted', 'conversion_failed'],
  conversion_failed: ['converting', 'not_received'],
  converted: ['cancelled'],
};

export function canTransition(from: ManifestLineState | null, to: ManifestLineState): boolean {
  const key = from === null ? '(none)' : from;
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && (ALLOWED[key] as readonly string[]).includes(to);
}

export function assertTransition(from: ManifestLineState | null, to: ManifestLineState): void {
  if (!canTransition(from, to)) throw new LimsError('partners.manifest_line_invalid_transition');
}
