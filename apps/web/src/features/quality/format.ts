// C9 T-21 shared labels and formatting (04-UI-UX §1: status words are text + chip, never colour alone; z-scores 2 dp; times in the tenant zone).
import type { PointStatus, QcStatus, RunSummary } from './types';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const QC_STATUS: Record<QcStatus, { label: string; tone: Tone }> = {
  in_control: { label: 'In control', tone: 'success' },
  warning: { label: 'Warning', tone: 'warning' },
  out_of_control: { label: 'Out of control', tone: 'danger' },
  no_qc_data: { label: 'No QC data', tone: 'neutral' },
};

export const OUTCOME: Record<NonNullable<RunSummary['outcome']>, { label: string; tone: Tone }> = {
  accepted: { label: 'Accepted', tone: 'success' },
  accepted_warning: { label: 'Accepted (warning)', tone: 'warning' },
  incomplete: { label: 'Incomplete', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

export const RUN_STATUS: Record<RunSummary['status'], { label: string; tone: Tone }> = {
  collecting: { label: 'Collecting', tone: 'info' },
  evaluated: { label: 'Evaluated', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export const NEEDS_ACTION: Record<string, string> = { corrective_action: 'Corrective action needed', rerun: 'Rerun needed' };
export const MODE: Record<string, string> = { classic: 'Classic', modern: 'Modern' };

/** LJ markers (04-UI-UX §2.4): shape + word, never colour alone. */
export const POINT: Record<PointStatus, { marker: string; label: string; tone: Tone }> = {
  accepted: { marker: '●', label: 'Accepted', tone: 'success' },
  warning: { marker: '▲', label: 'Warning', tone: 'warning' },
  rejected: { marker: '✕', label: 'Rejected', tone: 'danger' },
  excluded: { marker: '○', label: 'Excluded', tone: 'neutral' },
  unevaluated: { marker: '◇', label: 'Unevaluated', tone: 'neutral' },
  collecting: { marker: '◌', label: 'Collecting', tone: 'info' },
};

/** Observation (unassigned QC) statuses in plain language, with the fix each one needs. */
export const UNASSIGNED: Record<string, { label: string; fix?: 'maps' | 'plans' | 'targets' }> = {
  unmapped_analyte: { label: 'Not mapped in catalog' },
  no_plan: { label: 'No plan', fix: 'plans' },
  unmapped_control: { label: 'Unmapped control', fix: 'maps' },
  level_not_in_plan: { label: 'Level not in plan', fix: 'plans' },
  lot_expired: { label: 'Lot expired' },
  no_target: { label: 'No target', fix: 'targets' },
  unit_mismatch: { label: 'Unit mismatch' },
  late_unassigned: { label: 'Late' },
};
export const UNASSIGNED_STATUSES = Object.keys(UNASSIGNED);

const CLOCK = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kathmandu' } as const;
const hms = new Intl.DateTimeFormat('en-GB', { ...CLOCK, second: '2-digit' });
const hm = new Intl.DateTimeFormat('en-GB', CLOCK);
/** "hh:mm:ss" / "hh:mm" in the tenant zone (Asia/Kathmandu, CV §4.8). */
export const clockHms = (d: Date) => hms.format(d);
export const clockHm = (d: Date) => hm.format(d);

/** Decimal strings stay strings; this only pads/rounds for display (never used to compute a verdict). */
export function fixed(v: string | undefined, decimals: number): string {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? '—' : n.toFixed(decimals);
}
export const z2 = (v: string | undefined) => fixed(v, 2);

export const rulesText = (r: readonly string[]) => (r.length ? r.join(', ') : '—');
