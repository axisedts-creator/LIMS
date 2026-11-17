// T0B-SWEEP-2 (LD-270) done_when (2)+(3): DEPTH column and BUG/CONFIG/HARNESS classification. Implementation: services/api/test-sweep/classify.ts
// The SWEEP-1 contract of classify() stays (classifier.test.ts); SWEEP-2 extends it:
//   export type Verdict = 'WIRED' | 'DEFECT' | 'NOT_EXERCISED';
//   export type Depth = 'DEEP' | 'SHALLOW' | 'NOT EXERCISED';
//   classify(r: { status; timedOut?; matched?; holdsPermission?; errorCode?: string; harnessError?: boolean }): { verdict: Verdict; reason: string; depth: Depth }
//     DEEP = reached the service (2xx, a domain 4xx such as 404/409/422, any 5xx); SHALLOW = 400 `common.validation_failed` (input schema);
//     NOT EXERCISED = 429, harnessError, timeout. 429 is verdict NOT_EXERCISED, never WIRED.
//   defectClass(d: { status: number; errorCode?: string; detail?: string; reason?: string }): 'BUG' | 'CONFIG' | 'HARNESS'
import { describe, expect, it } from 'vitest';
import { classify, defectClass } from '../classify.js';

describe('classify: depth (done_when 2)', () => {
  it.each([200, 201, 202, 204])('%i reached the service: WIRED, DEEP', (status) => {
    expect(classify({ status })).toMatchObject({ verdict: 'WIRED', depth: 'DEEP' });
  });
  it.each([404, 409, 422])('%i with a domain code is WIRED, DEEP', (status) => {
    expect(classify({ status, errorCode: 'lab.order_state_conflict' })).toMatchObject({ verdict: 'WIRED', depth: 'DEEP' });
  });
  it('400 common.validation_failed stopped at input validation: WIRED, SHALLOW', () => {
    expect(classify({ status: 400, errorCode: 'common.validation_failed' })).toMatchObject({ verdict: 'WIRED', depth: 'SHALLOW' });
  });
  it('400 with a service code is DEEP (the service answered)', () => {
    expect(classify({ status: 400, errorCode: 'lab.invalid_state' })).toMatchObject({ verdict: 'WIRED', depth: 'DEEP' });
  });
  it('400 common.validation_failed with reachedHandler (fastify handler:start fired) is a service answer: WIRED, DEEP', () => {
    expect(classify({ status: 400, errorCode: 'common.validation_failed', reachedHandler: true })).toMatchObject({ verdict: 'WIRED', depth: 'DEEP' });
  });
  it.each([false, undefined])('400 common.validation_failed with reachedHandler=%s stays SHALLOW', (reachedHandler) => {
    expect(classify({ status: 400, errorCode: 'common.validation_failed', reachedHandler })).toMatchObject({ verdict: 'WIRED', depth: 'SHALLOW' });
  });
  it('reachedHandler does not change a 429 or a 5xx', () => {
    expect(classify({ status: 429, reachedHandler: true })).toMatchObject({ verdict: 'NOT_EXERCISED', depth: 'NOT EXERCISED' });
    expect(classify({ status: 500, reachedHandler: true })).toMatchObject({ verdict: 'DEFECT', depth: 'DEEP' });
  });
  it.each([500, 502, 503])('%i is a DEFECT that reached the service: DEEP', (status) => {
    expect(classify({ status, errorCode: 'common.internal' })).toMatchObject({ verdict: 'DEFECT', depth: 'DEEP' });
  });
});

describe('classify: NOT EXERCISED (done_when 1: no operation is WIRED on a 429)', () => {
  it('429 is NOT_EXERCISED, never WIRED', () => {
    const r = classify({ status: 429, errorCode: 'common.rate_limited' });
    expect(r.verdict).toBe('NOT_EXERCISED');
    expect(r.depth).toBe('NOT EXERCISED');
    expect(r.reason).toMatch(/429|rate/i);
  });
  it('429 without an error code is still NOT_EXERCISED', () => {
    expect(classify({ status: 429 })).toMatchObject({ verdict: 'NOT_EXERCISED', depth: 'NOT EXERCISED' });
  });
  it('a harness error (status 0) is NOT_EXERCISED', () => {
    expect(classify({ status: 0, harnessError: true })).toMatchObject({ verdict: 'NOT_EXERCISED', depth: 'NOT EXERCISED' });
  });
  it('a timeout stays a DEFECT (SWEEP-1) and is NOT EXERCISED by depth', () => {
    expect(classify({ status: 0, timedOut: true })).toMatchObject({ verdict: 'DEFECT', depth: 'NOT EXERCISED' });
  });
  it('429 on an unmatched route is not rescued into NOT_EXERCISED: unmatched stays a DEFECT', () => {
    expect(classify({ status: 429, matched: false }).verdict).toBe('DEFECT');
  });
  it('no status below 600 other than 429 ever yields NOT_EXERCISED without a harness error or timeout', () => {
    for (let s = 100; s < 600; s++) if (s !== 429) expect(classify({ status: s }).verdict, String(s)).not.toBe('NOT_EXERCISED');
  });
});

describe('defectClass (done_when 3)', () => {
  it('503 common.service_unavailable (provider missing in a test environment) is CONFIG', () => {
    expect(defectClass({ status: 503, errorCode: 'common.service_unavailable', detail: 'request_failed common.service_unavailable LimsError' })).toBe('CONFIG');
  });
  it('403 common.feature_disabled is CONFIG', () => {
    expect(defectClass({ status: 403, errorCode: 'common.feature_disabled', detail: 'Feature disabled' })).toBe('CONFIG');
  });
  it('500 caused by a missing config/secret file ("config: ... is not readable") is CONFIG', () => {
    expect(defectClass({ status: 500, errorCode: 'common.internal', detail: 'Error: config: LIMS_REPORTING_HMAC_KEY_FILE is not readable' })).toBe('CONFIG');
  });
  it('403 partners.partner_inactive (seeded partner inactive) is HARNESS', () => {
    expect(defectClass({ status: 403, errorCode: 'partners.partner_inactive', detail: 'Partner account inactive' })).toBe('HARNESS');
  });
  it('401 auth.unauthenticated for a session that holds the permission is a BUG (unwired)', () => {
    expect(defectClass({ status: 401, errorCode: 'auth.unauthenticated', detail: 'Authentication required' })).toBe('BUG');
  });
  it('500 with a TypeError stack is a BUG', () => {
    expect(defectClass({ status: 500, errorCode: 'common.internal', detail: "TypeError: Cannot read properties of undefined (reading 'x') / at Object.list (a.ts:10:3)" })).toBe('BUG');
  });
  it('500 with an unknown cause is a BUG, not CONFIG (a config claim needs evidence)', () => {
    expect(defectClass({ status: 500, errorCode: 'common.internal', detail: 'request_failed common.internal LimsError' })).toBe('BUG');
  });
  it('an unmatched route is a BUG', () => {
    expect(defectClass({ status: 404, reason: 'unmatched route' })).toBe('BUG');
  });
  it('always one of BUG, CONFIG, HARNESS', () => {
    for (const status of [401, 403, 500, 502, 503, 0])
      expect(['BUG', 'CONFIG', 'HARNESS']).toContain(defectClass({ status, errorCode: '', detail: '' }));
  });
});
