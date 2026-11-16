// T0B-SWEEP-1 regression gate: fails on a NEW defect and when a listed known failure starts working (then remove it from known-failures.json).
// Review item 2: a listed operation whose DEFECT status differs from the listed status counts as new (`${operation}:${status}`).
// T0B-SWEEP-2 (LD-270): a NOT_EXERCISED row (429 / harness error) proves nothing: never a new defect, never "now working"; the run reports them.
export interface KnownFailure { operation: string; status: number | string; ref: string; class?: 'BUG' | 'CONFIG' | 'HARNESS' }
type GateRow = { operationId: string; verdict: 'WIRED' | 'DEFECT' | 'NOT_EXERCISED'; status: number | string };

export function evaluateGate(rows: GateRow[], known: KnownFailure[]): { ok: boolean; newDefects: string[]; nowWorking: string[] } {
  const listed = new Set(known.map((k) => `${k.operation}:${k.status}`));
  const newDefects = rows
    .filter((r) => r.verdict === 'DEFECT' && !listed.has(`${r.operationId}:${r.status}`))
    .map((r) => `${r.operationId}:${r.status}`);
  const wired = new Set(rows.filter((r) => r.verdict === 'WIRED').map((r) => r.operationId));
  const nowWorking = known.map((k) => k.operation).filter((op) => wired.has(op));
  return { ok: newDefects.length === 0 && nowWorking.length === 0, newDefects, nowWorking };
}

export const notExercisedOps = (rows: { operationId: string; verdict: string }[]): string[] =>
  rows.filter((r) => r.verdict === 'NOT_EXERCISED').map((r) => r.operationId);
