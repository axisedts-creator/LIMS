// T0B-SWEEP-1 / LD-269: unit test of the sweep classifier. Implementation file: services/api/test-sweep/classify.ts
// export function classify(r: { status: number; timedOut?: boolean; matched?: boolean; holdsPermission?: boolean }): { verdict: 'WIRED' | 'DEFECT'; reason: string }
// `matched` defaults true, `holdsPermission` defaults true (the sweep only calls with a session that holds the permission).
import { describe, expect, it } from 'vitest';
import { classify } from '../classify.js';

describe('sweep classifier (done_when CLASSIFICATION)', () => {
  it.each([200, 201, 202, 204, 400, 404, 409, 422])('%i is WIRED', (status) => {
    expect(classify({ status }).verdict).toBe('WIRED');
  });
  it.each([401, 403])('%i for a session that holds the permission is a DEFECT', (status) => {
    const r = classify({ status, holdsPermission: true });
    expect(r.verdict).toBe('DEFECT');
    expect(r.reason).toMatch(/\S/);
  });
  it.each([500, 502, 503])('%i is a DEFECT', (status) => {
    expect(classify({ status }).verdict).toBe('DEFECT');
  });
  it('a timeout is a DEFECT whatever the status', () => {
    expect(classify({ status: 0, timedOut: true }).verdict).toBe('DEFECT');
    expect(classify({ status: 200, timedOut: true }).verdict).toBe('DEFECT');
  });
  it('an unmatched route is a DEFECT even when it answers 404', () => {
    expect(classify({ status: 404, matched: false }).verdict).toBe('DEFECT');
  });
  it('a handler 404 on a matched route is WIRED', () => {
    expect(classify({ status: 404, matched: true }).verdict).toBe('WIRED');
  });
});
