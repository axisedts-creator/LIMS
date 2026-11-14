// C9 T-05 — qcStatus, pure (02-TRD §7.8 steps 1-6; 03-IC §4.11; AC-09.1..09.4). No DB, no clock, no mutation of inputs.
// The caller (T-13 status.service) reads the plan and the latest runs; this function applies the step-2 filter itself.

export type QcRunStatus = 'collecting' | 'evaluated' | 'closed';
export type QcRunOutcome = 'accepted' | 'accepted_warning' | 'incomplete' | 'rejected' | null;
export type QcStatusValue = 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data';

export interface QcStatusRun {
  id: string;
  status: QcRunStatus;
  outcome: QcRunOutcome;
  runAt: Date;
  closedAt: Date | null;
  rulesViolated: readonly string[];
}

export interface QcStatusInput {
  hasPlan: boolean;
  runs: readonly QcStatusRun[];
  at: Date;
  qcValidityHours: number;
}

/** Absent values (the "—" cells of §7.8) are absent keys. */
export interface QcStatusResult {
  status: QcStatusValue;
  lastInControlRunAt?: Date;
  currentRunId?: string;
  violatedRules?: readonly string[];
}

const HOUR_MS = 3_600_000;

/** Latest by runAt; ties broken by id so the result never depends on input order. */
const later = (a: QcStatusRun, b: QcStatusRun): QcStatusRun => {
  const d = a.runAt.getTime() - b.runAt.getTime();
  return d > 0 || (d === 0 && a.id > b.id) ? a : b;
};
const latest = (rs: readonly QcStatusRun[]): QcStatusRun | undefined =>
  rs.length === 0 ? undefined : rs.reduce(later);

export function qcStatus(input: QcStatusInput): QcStatusResult {
  const { hasPlan, runs, at, qcValidityHours } = input;
  // Step 1.
  if (!hasPlan) return { status: 'no_qc_data' };
  // Step 2: E = evaluated|closed runs with run_at <= at.
  const atMs = at.getTime();
  const e = runs.filter((r) => (r.status === 'evaluated' || r.status === 'closed') && r.runAt.getTime() <= atMs);
  if (e.length === 0) return { status: 'no_qc_data' };

  // Step 5 (computed first; independent of 3-4): latest accepted/accepted_warning run_at.
  const lastOk = latest(e.filter((r) => r.outcome === 'accepted' || r.outcome === 'accepted_warning'));
  const withLast = <T extends QcStatusResult>(res: T): T => (lastOk ? { ...res, lastInControlRunAt: new Date(lastOk.runAt.getTime()) } : res);

  // Step 3: an open rejected run (closed_at absent or > at) masks everything; no staleness applies (AC-09.3).
  const open = latest(e.filter((r) => r.outcome === 'rejected' && (r.closedAt === null || r.closedAt.getTime() > atMs)));
  if (open) {
    return withLast({ status: 'out_of_control', currentRunId: open.id, violatedRules: [...open.rulesViolated] } as QcStatusResult);
  }

  // Step 4: governing run g = latest run in E.
  const g = latest(e) as QcStatusRun;
  let status: QcStatusValue;
  let violatedRules: string[] | undefined;
  if (g.outcome === 'accepted') {
    status = 'in_control';
  } else if (g.outcome === 'accepted_warning') {
    status = 'warning';
    violatedRules = ['1-2s'];
  } else if (g.outcome === 'incomplete') {
    status = 'warning';
    violatedRules = g.rulesViolated.includes('1-2s') ? ['incomplete_run', '1-2s'] : ['incomplete_run'];
  } else {
    // Closed rejected run as g (or null outcome): unreachable by QR7 (closing needs a later accepted run); §7.8 defines no
    // status for it, so report it as unknown rather than in_control (fail closed for auto-verification).
    return withLast({ status: 'no_qc_data', currentRunId: g.id, violatedRules: [...g.rulesViolated] } as QcStatusResult);
  }

  // Step 6: staleness, strict > (exactly qc_validity_hours old is still valid, AC-09.4).
  if (!lastOk || atMs - lastOk.runAt.getTime() > qcValidityHours * HOUR_MS) status = 'no_qc_data';

  const res: QcStatusResult = { status };
  if (lastOk) res.lastInControlRunAt = new Date(lastOk.runAt.getTime());
  res.currentRunId = g.id;
  if (violatedRules) res.violatedRules = violatedRules;
  return res;
}
