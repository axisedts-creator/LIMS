export interface StatusStep {
  id: string;
  label: string;
}

export interface StatusStepperProps {
  steps: readonly StatusStep[];
  currentId: string;
  /** Terminal failure/cancellation at the current step. */
  outcome?: { kind: 'failed' | 'cancelled'; label: string };
  'data-testid'?: string;
}

const STATE = { done: 'Complete', current: 'Current', upcoming: 'Upcoming', failed: 'Failed', cancelled: 'Cancelled' } as const;

/** Linear progress (C3 import batches). Each step's state is text (04 §5.4). Unknown currentId -> all upcoming. */
export function StatusStepper({ steps, currentId, outcome, ...rest }: StatusStepperProps) {
  const cur = steps.findIndex((s) => s.id === currentId);
  return (
    <div className="lims-stepper" {...rest}>
      <ol className="lims-stepper-list">
        {steps.map((s, i) => {
          const state = cur < 0 || i > cur ? 'upcoming' : i < cur ? 'done' : outcome ? outcome.kind : 'current';
          const tone = state === 'done' ? 'success' : state === 'current' ? 'info' : state === 'failed' ? 'danger' : 'neutral';
          return (
            <li key={s.id} className={`lims-step lims-step-${state}`} data-tone={tone} {...(i === cur ? { 'aria-current': 'step' as const } : {})}>
              <span className="lims-step-label">{s.label}</span> <span className="lims-step-state">({STATE[state]})</span>
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
