// C9 T-04 — QC run state machine, pure (03-APP-FLOW §2.1 QR1-QR7 + "Forbidden"; 02-TRD §7.3 steps 1a/5/6; 07-SECURITY S-09, S-10).
// [CONV] RunStateError extends LimsError (core/errors.ts) so services can rethrow it; codes are the spec's registry codes.
import { LimsError } from '../../../core/errors.js';

export type RunOutcome = 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected';
export interface RunState {
  readonly status: 'collecting' | 'evaluated' | 'closed';
  readonly outcome: RunOutcome | null;
  readonly isComplete: boolean;
}
export type RunEvent =
  | { readonly type: 'open' }
  | { readonly type: 'add_member' }
  | { readonly type: 'reject_early' }
  | { readonly type: 'complete'; readonly outcome: RunOutcome }
  | { readonly type: 'finalize'; readonly outcome: RunOutcome }
  | { readonly type: 'attach_late_member' }
  | { readonly type: 'close'; readonly correctiveActionCount: number; readonly laterAcceptedRunAfterWindow: boolean };
export interface RunTransition {
  readonly transition: 'QR1' | 'QR2' | 'QR3' | 'QR4' | 'QR5' | 'QR6' | 'QR7';
  readonly state: RunState;
  readonly emitsRejectedEvent: boolean;
}

export class RunStateError extends LimsError {
  constructor(code: string, detail?: string) {
    super(code, detail);
    this.name = 'RunStateError';
  }
}

const IMMUTABLE = 'common.immutable_record';
const EVALUATED = 'quality.qc_run_already_evaluated';
const refuse = (code: string, detail: string): never => { throw new RunStateError(code, detail); };

const isEarlyRejected = (s: RunState): boolean => s.status === 'evaluated' && s.outcome === 'rejected' && !s.isComplete;

export function transitionRun(state: RunState | null, ev: RunEvent): RunTransition {
  if (state === null) {
    if (ev.type === 'open') return { transition: 'QR1', state: { status: 'collecting', outcome: null, isComplete: false }, emitsRejectedEvent: false };
    return refuse(IMMUTABLE, `${ev.type} needs an existing run`);
  }
  if (ev.type === 'open') return refuse(IMMUTABLE, 'open needs no existing run');
  if (state.status === 'closed') return refuse(IMMUTABLE, `closed run refuses ${ev.type}`);

  switch (ev.type) {
    case 'add_member':
      if (state.status !== 'collecting') return refuse(EVALUATED, 'add_member needs a collecting run');
      return { transition: 'QR2', state: { ...state }, emitsRejectedEvent: false };
    case 'reject_early':
      if (state.status !== 'collecting') return refuse(EVALUATED, 'reject_early needs a collecting run');
      return { transition: 'QR3', state: { status: 'evaluated', outcome: 'rejected', isComplete: false }, emitsRejectedEvent: true };
    case 'complete':
    case 'finalize':
      if (state.status !== 'collecting') return refuse(EVALUATED, 'outcome is set once'); // #30/#27
      return {
        transition: ev.type === 'complete' ? 'QR4' : 'QR5',
        state: { status: 'evaluated', outcome: ev.outcome, isComplete: ev.type === 'complete' },
        emitsRejectedEvent: ev.outcome === 'rejected',
      };
    case 'attach_late_member': // QR6: AC-06.6, frozen, no second event
      if (!isEarlyRejected(state)) return refuse(EVALUATED, 'late member needs an early-rejected run');
      return { transition: 'QR6', state: { ...state }, emitsRejectedEvent: false };
    case 'close': { // QR7: AC-07.2 corrective action first, then AC-07.3 later accepted run
      if (state.outcome !== 'rejected') return refuse(IMMUTABLE, 'only a rejected run closes');
      if (!Number.isInteger(ev.correctiveActionCount) || ev.correctiveActionCount < 1) return refuse('quality.corrective_action_required', 'close needs a corrective action');
      if (!ev.laterAcceptedRunAfterWindow) return refuse('quality.rerun_required', 'close needs a later accepted run outside the window');
      return { transition: 'QR7', state: { status: 'closed', outcome: 'rejected', isComplete: state.isComplete }, emitsRejectedEvent: false };
    }
  }
}

/** #33 acknowledge needs an evaluated or closed run; #27 exclude only while collecting (S-10). */
export function assertRunAction(state: RunState, action: 'acknowledge' | 'exclude_observation'): void {
  if (action === 'acknowledge') {
    if (state.status === 'collecting') refuse(IMMUTABLE, 'cannot acknowledge a collecting run');
  } else if (state.status !== 'collecting') {
    refuse(EVALUATED, 'observations of an evaluated run cannot be excluded');
  }
}
