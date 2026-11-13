// C13 T04 — manifest state table + guards (03-APP-FLOW §2.1; US-04.7, US-04.9, US-04.10; 08 A19 D-104). Pure.
import { LimsError } from '../../../core/errors.js';

export const MANIFEST_STATES = ['draft', 'submitted', 'partially_received', 'received', 'withdrawn', 'discarded'] as const;
export type ManifestState = (typeof MANIFEST_STATES)[number];
export type ConversionMode = 'on_receipt' | 'on_submit';

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '(none)': ['draft'],
  draft: ['draft', 'submitted', 'discarded'],
  submitted: ['withdrawn', 'partially_received', 'received'],
  partially_received: ['received', 'partially_received'],
};

export function canTransition(from: ManifestState | null, to: ManifestState): boolean {
  const key = from === null ? '(none)' : from;
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && (ALLOWED[key] as readonly string[]).includes(to);
}

export function assertTransition(from: ManifestState | null, to: ManifestState): void {
  if (!canTransition(from, to)) throw new LimsError('partners.manifest_invalid_transition');
}

/** US-04.7: line/manifest edits only while draft. */
export function assertEditable(state: ManifestState): void {
  if (state !== 'draft') throw new LimsError('partners.manifest_not_editable');
}

/** MS5 / US-04.9 / US-04.10: submitted, mode on_receipt, no line converting/converted. */
export function assertWithdrawable(m: { state: ManifestState; conversionMode: ConversionMode; lineStates: readonly string[] }): void {
  if (m.state !== 'submitted' || m.conversionMode !== 'on_receipt' || m.lineStates.some((s) => s === 'converting' || s === 'converted'))
    throw new LimsError('partners.manifest_invalid_transition');
}

interface ReceiptLine { state: string; sampleReceivedAt: string | null; sampleMissing: boolean }

/** "Pending receipt" definition, 03-APP-FLOW §2.1 (D-104). */
export function isPendingReceipt(line: ReceiptLine, mode: ConversionMode): boolean {
  if (mode === 'on_receipt') return line.state === 'submitted';
  return line.sampleReceivedAt === null && !line.sampleMissing && ['converting', 'converted', 'conversion_failed'].includes(line.state);
}

/** MS6/MS8 (some line still pending) vs MS7 (none). */
export function stateAfterReceipt(mode: ConversionMode, lines: readonly ReceiptLine[]): 'partially_received' | 'received' {
  return lines.some((l) => isPendingReceipt(l, mode)) ? 'partially_received' : 'received';
}
