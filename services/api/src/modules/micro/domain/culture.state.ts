// Culture state table (03-APP-FLOW §2.1 C1–C10). Pure: no I/O.
import { LimsError } from '../../../core/errors.js';

export const CULTURE_STATUSES = ['awaiting_setup', 'incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled'] as const;
export type CultureStatus = (typeof CULTURE_STATUSES)[number];
export const CULTURE_ACTIONS = ['receive', 'setup', 'growth', 'submit_preliminary', 'submit_final', 'reopen', 'cancel', 'aliquot'] as const;
export type CultureAction = (typeof CULTURE_ACTIONS)[number];

const OPEN = ['awaiting_setup', 'incubating', 'growth_detected'] as const;
const entries = (from: readonly CultureStatus[], to: (f: CultureStatus) => CultureStatus): [CultureStatus, CultureStatus][] => from.map((f) => [f, to(f)]);

// action -> (from -> to). Absent = forbidden. Null-prototype maps so '__proto__'/'constructor' never match.
const TABLE: Record<string, Record<string, CultureStatus>> = Object.assign(Object.create(null), {
  setup: Object.fromEntries([['awaiting_setup', 'incubating']]), // C2
  growth: Object.fromEntries([['incubating', 'growth_detected']]), // C3
  submit_preliminary: Object.fromEntries(entries(OPEN, (f) => f)), // C4 (C7: amending forbidden)
  submit_final: Object.fromEntries([['incubating', 'final_submitted'], ['growth_detected', 'final_submitted'], ['amending', 'final_submitted']]), // C5, C6
  reopen: Object.fromEntries([['final_submitted', 'amending']]), // C8
  cancel: Object.fromEntries(entries(OPEN, () => 'cancelled')), // C9
  aliquot: Object.fromEntries([['awaiting_setup', 'awaiting_setup']]), // C10
});

const invalid = (): never => { throw new LimsError('micro.culture_invalid_transition'); };

export function nextCultureStatus(from: CultureStatus | null, action: CultureAction, ctx?: { reasonCode?: string }): CultureStatus {
  if (from === null) return action === 'receive' ? 'awaiting_setup' : invalid(); // C1
  const to = Object.hasOwn(TABLE, action) ? Object.hasOwn(TABLE[action]!, from) ? TABLE[action]![from] : undefined : undefined;
  if (!to) return invalid();
  if (action === 'reopen' && !ctx?.reasonCode?.trim()) throw new LimsError('micro.amendment_reason_required'); // AC-11.4
  return to;
}

/** Child rows (isolates, AST, notes) of a culture: locked when final, closed when cancelled. */
export function assertCultureChildEditable(status: CultureStatus): void {
  if (status === 'final_submitted') throw new LimsError('micro.report_final_locked');
  if (status === 'cancelled') invalid();
}
