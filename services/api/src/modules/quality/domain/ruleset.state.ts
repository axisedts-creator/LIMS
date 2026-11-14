// Auto-verify version state machine (03-APP-FLOW §2.3 AV1-AV7; 02-TRD §8.1; 08 A17 D-55). Pure: no I/O.
// `activate` (AV5) is listed so the table is complete and a `draft -> active` jump is refused; the activation endpoint (#43) is T-17.
// Terminal: stopped (D-55), retired, discarded. The DB trigger quality.enforce_version_frozen refuses the same moves (defence in depth).
import { LimsError } from '../../../core/errors.js';

export type VersionStatus = 'draft' | 'simulating' | 'stopped' | 'active' | 'retired' | 'discarded';
export type VersionAction = 'edit' | 'startSimulation' | 'stopSimulation' | 'activate' | 'retire' | 'discard';

const MOVES: Readonly<Record<VersionStatus, Readonly<Partial<Record<VersionAction, VersionStatus>>>>> = Object.freeze({
  draft: Object.freeze({ edit: 'draft', startSimulation: 'simulating', discard: 'discarded' } as const),
  simulating: Object.freeze({ stopSimulation: 'stopped', activate: 'active' } as const),
  stopped: Object.freeze({}),
  active: Object.freeze({ retire: 'retired' } as const),
  retired: Object.freeze({}),
  discarded: Object.freeze({}),
});
const TERMINAL: ReadonlySet<string> = new Set(['stopped', 'retired', 'discarded']);
const own = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** The status after `action`, or 409 quality.rule_set_invalid_transition. Unknown status/action is refused, never passed through. */
export function nextStatus(from: VersionStatus, action: VersionAction): VersionStatus {
  const row = own(MOVES, from) ? MOVES[from] : undefined;
  const to = row && own(row, action) ? row[action] : undefined;
  if (!to) throw new LimsError('quality.rule_set_invalid_transition');
  return to;
}

export const isTerminal = (status: VersionStatus): boolean => TERMINAL.has(status);
