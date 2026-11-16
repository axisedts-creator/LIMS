// T0B-SWEEP-1 / LD-269 classifier (done_when CLASSIFICATION). WIRED = the request reached the handler or service; DEFECT = a wiring gap.
export type Verdict = 'WIRED' | 'DEFECT';
export interface ClassifyInput { status: number; timedOut?: boolean; matched?: boolean; holdsPermission?: boolean }

export function classify(r: ClassifyInput): { verdict: Verdict; reason: string } {
  const { status, timedOut = false, matched = true, holdsPermission = true } = r;
  if (timedOut) return { verdict: 'DEFECT', reason: 'timeout' };
  if (!matched) return { verdict: 'DEFECT', reason: 'unmatched route' };
  if (status >= 500 || status < 100) return { verdict: 'DEFECT', reason: `server error ${status}` };
  if (status === 401 || status === 403) {
    return holdsPermission
      ? { verdict: 'DEFECT', reason: `${status} for a session that holds the permission` }
      : { verdict: 'WIRED', reason: `${status}: no session of this kind holds the permission (expected denial)` };
  }
  if (status < 300) return { verdict: 'WIRED', reason: 'success' };
  if ([400, 404, 409, 422].includes(status)) return { verdict: 'WIRED', reason: 'validation or not-found answer' };
  // [CONV] other 4xx (412/413/415/428/429...) are pipeline answers after routing, not auth or wiring failures
  return { verdict: 'WIRED', reason: `other client answer ${status}` };
}
