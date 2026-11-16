// T0B-SWEEP-1 regression gate: fails on a NEW defect and when a listed known failure starts working (then remove it from known-failures.json).
export interface KnownFailure { operation: string; status: number | string; ref: string }

export function evaluateGate(
  rows: { operationId: string; verdict: 'WIRED' | 'DEFECT' }[],
  known: KnownFailure[],
): { ok: boolean; newDefects: string[]; nowWorking: string[] } {
  const listed = new Set(known.map((k) => k.operation));
  const newDefects = rows.filter((r) => r.verdict === 'DEFECT' && !listed.has(r.operationId)).map((r) => r.operationId);
  const wired = new Set(rows.filter((r) => r.verdict === 'WIRED').map((r) => r.operationId));
  const nowWorking = known.map((k) => k.operation).filter((op) => wired.has(op));
  return { ok: newDefects.length === 0 && nowWorking.length === 0, newDefects, nowWorking };
}
