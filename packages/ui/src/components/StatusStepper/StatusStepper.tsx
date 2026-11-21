import { Icon } from '../Icon/Icon';
import type { Tone } from '../_shared/messages';

export interface StatusStep {
  id: string;
  label: string;
  /** T0D-UIDASH-2 (LD-436 pipeline): the count under the label (already formatted); absent = no number. */
  count?: string;
  /** T0D-UIDASH-2: one short line beside the count in a tone, e.g. "6 overdue" in danger. */
  note?: { text: string; tone: Tone };
}

export interface StatusStepperProps {
  steps: readonly StatusStep[];
  currentId: string;
  /** Terminal failure/cancellation at the current step. */
  outcome?: { kind: 'failed' | 'cancelled'; label: string };
  /** T0D-UIKIT-2 (LD-436 pipeline): the ONE stage the page names as having the most waiting; gets the lime marker and the words. */
  mostWaitingId?: string;
  'data-testid'?: string;
}

// Tone + icon + word per step, a distinct icon per state (LD-140, 10-DESIGN-SYSTEM §6).
const ICON = { done: 'success', current: 'current', upcoming: 'neutral', failed: 'danger', cancelled: 'close' } as const;
const STATE = { done: 'Complete', current: 'Current', upcoming: 'Upcoming', failed: 'Failed', cancelled: 'Cancelled' } as const;

/** Linear progress (C3 import batches). Each step's state is text (04 §5.4). Unknown currentId -> all upcoming. */
export function StatusStepper({ steps, currentId, outcome, mostWaitingId, ...rest }: StatusStepperProps) {
  const cur = steps.findIndex((s) => s.id === currentId);
  return (
    <div className="lims-stepper" {...rest}>
      <ol className="lims-stepper-list">
        {steps.map((s, i) => {
          const state = cur < 0 || i > cur ? 'upcoming' : i < cur ? 'done' : outcome ? outcome.kind : 'current';
          const tone = state === 'done' ? 'success' : state === 'current' ? 'info' : state === 'failed' ? 'danger' : 'neutral';
          return (
            <li key={s.id} className={`lims-step lims-step-${state}`} data-tone={tone} {...(i === cur ? { 'aria-current': 'step' as const } : {})}>
              <Icon name={ICON[state]} size={14} />
              <span className="lims-step-label">{s.label}</span> <span className="lims-step-state">({STATE[state]})</span>
              {s.id === mostWaitingId ? (
                <>
                  {' '}
                  <span className="lims-step-marker" aria-hidden="true" />
                  <span className="lims-step-waiting">Most waiting</span>
                </>
              ) : null}
              {s.count !== undefined || s.note ? ' ' : null}
              {s.count !== undefined || s.note ? (
                <span className="lims-step-figures">
                  {s.count !== undefined ? <span className="lims-step-count">{s.count}</span> : null}
                  {s.note ? <> <span className={`lims-step-note lims-tone-${s.note.tone}`} data-tone={s.note.tone}>{s.note.text}</span></> : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {outcome ? (
        <p role={outcome.kind === 'failed' ? 'alert' : 'status'} className={`lims-stepper-outcome lims-tone-${outcome.kind === 'failed' ? 'danger' : 'neutral'}`}>
          {outcome.label}
        </p>
      ) : null}
    </div>
  );
}
