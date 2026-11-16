// T0B-SWEEP-1 regression gate: fails on a NEW defect and when a listed known failure starts working (then remove it from known-failures.json).
// Review item 2: a listed operation whose DEFECT status differs from the listed status counts as new (`${operation}:${status}`).
export interface KnownFailure { operation: string; status: number | string; ref: string }

export function evaluateGate(
  rows: { operationId: string; verdict: 'WIRED' | 'DEFECT'; status: number | string }[],
  known: KnownFailure[],
): { ok: boolean; newDefects: string[]; nowWorking: string[] } {
  const listed = new Set(known.map((k) => `${k.operation}:${k.status}`));
  const newDefects = rows
    .filter((r) => r.verdict === 'DEFECT' && !listed.has(`${r.operationId}:${r.status}`))
    .map((r) => `${r.operationId}:${r.status}`);
  const wired = new Set(rows.filter((r) => r.verdict === 'WIRED').map((r) => r.operationId));
  const nowWorking = known.map((k) => k.operation).filter((op) => wired.has(op));
  return { ok: newDefects.length === 0 && nowWorking.length === 0, newDefects, nowWorking };
}
