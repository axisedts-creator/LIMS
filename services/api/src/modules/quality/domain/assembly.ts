// C9 T-04 — run assembly, pure (02-TRD §7.3 steps 1-7; 08 A17 D-52 step 1a). No DB, no clock: server time and query results come in as arguments.
// ACs: AC-06.6 (late member joins the early-rejected run), AC-06.7 (stale close on last_assembled_at).

export type Composition = Readonly<Record<string, number>>;
export type LevelCounts = Readonly<Record<string, number>>;

export interface AssemblyRun {
  readonly id: string;
  readonly status: 'collecting' | 'evaluated' | 'closed';
  readonly outcome: 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected' | null;
  readonly isComplete: boolean;
  readonly runAt: Date;
  readonly lastAssembledAt: Date;
  readonly levelCounts: LevelCounts;
}

export interface AssemblyInput {
  readonly observation: { readonly id: string; readonly level: string; readonly observedAt: Date };
  /** The pair's collecting run (step 1) or null. */
  readonly collecting: AssemblyRun | null;
  /** Caller's step 1a query result; re-checked here, ignored when a collecting run exists. */
  readonly latestEarlyRejected: AssemblyRun | null;
  readonly composition: Composition;
  readonly runWindowMinutes: number;
}

export type AssemblyDecision =
  | { readonly action: 'attach_collecting'; readonly runId: string }
  | { readonly action: 'attach_early_rejected'; readonly runId: string }
  | { readonly action: 'open_run'; readonly finalizeRunId: string | null };

const MS_PER_MIN = 60_000;

/** Step 5: every composition level present at its required count (surplus counts as full). */
export function isCompositionFull(levelCounts: LevelCounts, composition: Composition): boolean {
  const levels = Object.keys(composition);
  return levels.length > 0 && levels.every((l) => (levelCounts[l] ?? 0) >= (composition[l] as number));
}

/** Step 7: only a collecting run goes stale; strict on last_assembled_at (server time), never run_at. */
export function isStale(run: Pick<AssemblyRun, 'status' | 'lastAssembledAt'>, now: Date, runWindowMinutes: number): boolean {
  return run.status === 'collecting' && run.lastAssembledAt.getTime() < now.getTime() - runWindowMinutes * MS_PER_MIN;
}

/** Steps 1-4 + 1a. Window is observed_at - run_at <= run_window_minutes (inclusive). */
export function assembleObservation(i: AssemblyInput): AssemblyDecision {
  const { observation: o, collecting, latestEarlyRejected: early, composition, runWindowMinutes } = i;
  const required = composition[o.level]; // undefined: level not in composition, never joins a run
  const joins = (run: AssemblyRun): boolean =>
    required !== undefined
    && o.observedAt.getTime() - run.runAt.getTime() <= runWindowMinutes * MS_PER_MIN
    && (run.levelCounts[o.level] ?? 0) < required;

  if (collecting) {
    // steps 2/3: join, else finalise it and open a new run (step 4)
    return joins(collecting) ? { action: 'attach_collecting', runId: collecting.id } : { action: 'open_run', finalizeRunId: collecting.id };
  }
  // step 1a: only an evaluated, rejected, incomplete-composition run takes late members
  if (early && early.status === 'evaluated' && early.outcome === 'rejected' && !early.isComplete && joins(early)) {
    return { action: 'attach_early_rejected', runId: early.id };
  }
  return { action: 'open_run', finalizeRunId: null };
}
