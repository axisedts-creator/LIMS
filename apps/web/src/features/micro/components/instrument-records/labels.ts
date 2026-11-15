// 04-UI-UX §9 labels and tones for instrument records (AC-08.4–AC-08.6 UI side). LD-140 (2026-11-13): every status shows tone, icon and word (the Chip does the icon).
// A status or reason this table does not know shows a neutral fallback, never the raw code.
import type { Tone } from '../common';

export const RECORD_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_match: { label: 'Waiting for match', tone: 'warning' },
  needs_mapping: { label: 'Needs code mapping', tone: 'warning' },
  conflict: { label: 'Conflict', tone: 'danger' },
  late_after_final: { label: 'After final report', tone: 'warning' },
  applied: { label: 'Applied', tone: 'success' },
  ignored: { label: 'Ignored', tone: 'neutral' },
};
/** FilterBar Status options (04-UI-UX §4); the default selection is the first four. */
export const STATUS_FILTER = [
  { value: 'pending_match', label: 'Waiting for match' },
  { value: 'needs_mapping', label: 'Needs mapping' },
  { value: 'conflict', label: 'Conflict' },
  { value: 'late_after_final', label: 'After final' },
  { value: 'applied', label: 'Applied' },
  { value: 'ignored', label: 'Ignored' },
] as const;
export const OPEN_STATUSES = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final'] as const;

export const RECORD_REASON: Record<string, string> = {
  lookup_unavailable: 'Automatic matching not enabled',
  unknown_barcode: 'Barcode not found',
  no_culture: 'No culture for this specimen',
  multiple_cultures: 'Several cultures for this specimen',
  isolate_missing: 'Isolate not yet recorded',
  isolate_seq_out_of_range: 'Isolate number above 99 — choose one',
  organism_differs: 'Different organism already recorded',
  manual_value_exists: 'Manual value already recorded',
  culture_cancelled: 'Culture cancelled',
};
export const reasonText = (r: string | undefined) => (r !== undefined && Object.hasOwn(RECORD_REASON, r) ? RECORD_REASON[r]! : '—');
export const kindText = (k: string) => (k === 'ast' ? 'AST' : k === 'organism_id' ? 'Organism ID' : '—');
/** "<=0.25 · S · CLSI 2026" as received (04-UI-UX §4 Value column); "—" when the record carries no value (an organism ID). */
export function valueText(r: { raw_value?: string; interpretation_raw?: string; standard?: string; standard_version?: string }): string {
  const std = [r.standard, r.standard_version].filter(Boolean).join(' ');
  const parts = [r.raw_value, r.interpretation_raw, std].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : '—';
}

export type RecordAction = 'assign' | 'apply' | 'resolve' | 'ignore';
export const ACTION_LABEL: Record<RecordAction, string> = { assign: 'Assign to culture', apply: 'Apply', resolve: 'Resolve conflict', ignore: 'Ignore' };
/** 03-APP-FLOW §2.4 IR2–IR6: what a record in this state may do. applied / ignored are final. `inCulture`: the culture page already knows the culture, so no assigning. */
export function actionsFor(r: { match_status: string; culture_id?: string }, inCulture: boolean): RecordAction[] {
  const known = r.culture_id !== undefined;
  switch (r.match_status) {
    case 'pending_match':
      return [...(inCulture ? [] : (['assign'] as const)), ...(known ? (['apply'] as const) : []), 'ignore'];
    case 'needs_mapping':
    case 'late_after_final':
      return [...(known ? (['apply'] as const) : []), 'ignore'];
    case 'conflict':
      return ['resolve', 'ignore'];
    default:
      return [];
  }
}
