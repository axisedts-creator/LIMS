// T0B-SWEEP-1 / LD-269 classifier (done_when CLASSIFICATION). WIRED = the request reached the handler or service; DEFECT = a wiring gap.
// T0B-SWEEP-2 / LD-270: DEPTH (DEEP reached the service, SHALLOW stopped at input validation, NOT EXERCISED = 429 / harness error / timeout);
// a 429 is NOT_EXERCISED, never WIRED (339 of SWEEP-1's WIRED were 429). defectClass = BUG | CONFIG | HARNESS for the lead's fix queue.
export type Verdict = 'WIRED' | 'DEFECT' | 'NOT_EXERCISED';
export type Depth = 'DEEP' | 'SHALLOW' | 'NOT EXERCISED';
export type DefectClass = 'BUG' | 'CONFIG' | 'HARNESS';
export interface ClassifyInput { status: number; timedOut?: boolean; matched?: boolean; holdsPermission?: boolean; errorCode?: string; harnessError?: boolean }

export function classify(r: ClassifyInput): { verdict: Verdict; reason: string; depth: Depth } {
  const { status, timedOut = false, matched = true, holdsPermission = true, errorCode = '', harnessError = false } = r;
  const deep = (verdict: Verdict, reason: string) => ({ verdict, reason, depth: 'DEEP' as Depth });
  if (timedOut) return { verdict: 'DEFECT', reason: 'timeout', depth: 'NOT EXERCISED' };
  if (!matched) return deep('DEFECT', 'unmatched route');
  if (harnessError) return { verdict: 'NOT_EXERCISED', reason: 'harness error (no answer)', depth: 'NOT EXERCISED' };
  if (status === 429) return { verdict: 'NOT_EXERCISED', reason: '429 rate limited: never reached the handler', depth: 'NOT EXERCISED' };
  if (status >= 500 || status < 100) return deep('DEFECT', `server error ${status}`);
  if (status === 401 || status === 403) {
    return holdsPermission
      ? deep('DEFECT', `${status} for a session that holds the permission`)
      : deep('WIRED', `${status}: no session of this kind holds the permission (expected denial)`);
  }
  if (status < 300) return deep('WIRED', 'success');
  // [CONV] 400 common.validation_failed is the input-schema stage (or a handler's own field check, same shape): SHALLOW. Any other 4xx is a service answer.
  if (status === 400 && errorCode === 'common.validation_failed') return { verdict: 'WIRED', reason: 'stopped at input validation', depth: 'SHALLOW' };
  if ([400, 404, 409, 422].includes(status)) return deep('WIRED', 'validation or not-found answer');
  // [CONV] other 4xx (412/413/415/428...) are pipeline answers after routing, not auth or wiring failures
  return deep('WIRED', `other client answer ${status}`);
}

/** BUG (code wrong or unwired), CONFIG (provider / flag / secret a test environment lacks, needs evidence), HARNESS (the test setup). */
export function defectClass(d: { status: number; errorCode?: string; detail?: string; reason?: string }): DefectClass {
  const code = d.errorCode ?? '', detail = d.detail ?? '';
  if (d.reason === 'unmatched route') return 'BUG';
  if (code === 'partners.partner_inactive') return 'HARNESS';
  if (d.status === 503 && code === 'common.service_unavailable') return 'CONFIG';
  if (d.status === 403 && code === 'common.feature_disabled') return 'CONFIG';
  if (d.status >= 500 && /\bconfig:|is not readable|not configured|missing (secret|key|provider)|_FILE\b/i.test(detail)) return 'CONFIG';
  return 'BUG';
}
