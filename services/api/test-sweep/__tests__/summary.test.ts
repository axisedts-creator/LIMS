// T0B-SWEEP-2 (LD-270) done_when (2)+(3)+(5): depth summary, results table with a DEPTH column, BUG list last, gate over NOT_EXERCISED.
// Implementation: services/api/test-sweep/summary.ts
//   export interface SweepRow { module; operationId; method; path; sessionKind; auth; holdsPermission: boolean; status: number; errorCode: string;
//                               verdict: 'WIRED'|'DEFECT'|'NOT_EXERCISED'; depth: 'DEEP'|'SHALLOW'|'NOT EXERCISED'; reason; rootCause: string;
//                               defectClass: 'BUG'|'CONFIG'|'HARNESS'|''; detail: string }
//   export function summarize(rows): { total: number; byDepth: Record<Depth, number>; byModule: Record<string, Record<Depth, number>> }
//   export function renderResults(rows, meta: { at: string }): string   // markdown: header, depth summary, a table per module, defect classes, BUG list as the LAST section
// gate.ts: evaluateGate(rows, known) keeps its SWEEP-1 return shape { ok, newDefects, nowWorking }; a NOT_EXERCISED row is never a new defect and never "now working".
//   export function notExercisedOps(rows: { operationId: string; verdict: string }[]): string[]   // operationIds with verdict NOT_EXERCISED (the run reports them)
import { describe, expect, it } from 'vitest';
import { evaluateGate, notExercisedOps } from '../gate.js';
import { renderResults, summarize, type SweepRow } from '../summary.js';

const row = (o: Partial<SweepRow> & { operationId: string; module: string }): SweepRow => ({
  method: 'get', path: '/v1/x', sessionKind: 'tenant_corp_admin', auth: 'bearer', holdsPermission: true, status: 200, errorCode: '',
  verdict: 'WIRED', depth: 'DEEP', reason: 'success', rootCause: '', defectClass: '', detail: '', ...o,
});
const rows: SweepRow[] = [
  row({ module: 'lab', operationId: 'a' }),
  row({ module: 'lab', operationId: 'b', status: 404, errorCode: 'common.not_found' }),
  row({ module: 'lab', operationId: 'c', status: 400, errorCode: 'common.validation_failed', depth: 'SHALLOW', detail: '$.name: required' }),
  row({ module: 'billing', operationId: 'd', status: 429, errorCode: 'common.rate_limited', verdict: 'NOT_EXERCISED', depth: 'NOT EXERCISED', reason: '429' }),
  row({ module: 'billing', operationId: 'e', status: 503, errorCode: 'common.service_unavailable', verdict: 'DEFECT', defectClass: 'CONFIG', rootCause: '503: provider', detail: 'no provider' }),
  row({ module: 'identity', operationId: 'listWidgets', status: 500, errorCode: 'common.internal', verdict: 'DEFECT', defectClass: 'BUG', rootCause: '500: handler bug (TypeError)', detail: 'TypeError at x.ts:3' }),
];

describe('summarize', () => {
  it('counts per depth and per module', () => {
    const s = summarize(rows);
    expect(s.total).toBe(6);
    expect(s.byDepth).toEqual({ DEEP: 3, SHALLOW: 1, 'NOT EXERCISED': 1 });
    expect(s.byModule.lab).toEqual({ DEEP: 2, SHALLOW: 1, 'NOT EXERCISED': 0 });
    expect(s.byModule.billing).toEqual({ DEEP: 1, SHALLOW: 0, 'NOT EXERCISED': 1 });
    expect(s.byModule.identity).toEqual({ DEEP: 1, SHALLOW: 0, 'NOT EXERCISED': 0 });
  });
  it('depth counts add up to the total', () => {
    const s = summarize(rows);
    expect(s.byDepth.DEEP + s.byDepth.SHALLOW + s.byDepth['NOT EXERCISED']).toBe(s.total);
  });
});

describe('renderResults', () => {
  const md = renderResults(rows, { at: '2026-11-16T00:00:00.000Z' });
  it('has a DEPTH column in the per-module tables', () => {
    expect(md).toMatch(/\| operation \| session kind \| status \| error_code \| verdict \| depth \|/i);
    expect(md).toMatch(/\| c \|[^\n]*\| SHALLOW \|/);
    expect(md).toMatch(/\| d \|[^\n]*\| NOT EXERCISED \|/);
  });
  it('states the depth counts and the per-module counts', () => {
    expect(md).toMatch(/DEEP\D{0,12}3\b/);
    expect(md).toMatch(/SHALLOW\D{0,12}1\b/);
    expect(md).toMatch(/NOT EXERCISED\D{0,12}1\b/);
    for (const m of ['lab', 'billing', 'identity']) expect(md).toContain(`## ${m}`);
  });
  it('never shows a 429 row as WIRED', () => {
    const line = md.split('\n').find((l) => l.startsWith('| d |'))!;
    expect(line).not.toMatch(/\bWIRED\b/);
  });
  it('shows the defect class of every defect', () => {
    expect(md).toMatch(/\| e \|[^\n]*CONFIG/);
    expect(md).toMatch(/\| listWidgets \|[^\n]*BUG/);
  });
  it('ends with the BUG list by root-cause guess: BUG operations only', () => {
    const idx = md.search(/^## BUG list by root-cause guess/m);
    expect(idx).toBeGreaterThan(0);
    const tail = md.slice(idx);
    expect(tail.slice(3)).not.toMatch(/^## /m);          // it is the last section
    expect(tail).toContain('listWidgets');
    expect(tail).toContain('handler bug');
    expect(tail).not.toMatch(/\be\b.*provider/);          // CONFIG defect is not in the BUG list
  });
});

describe('evaluateGate with NOT_EXERCISED rows (done_when 5)', () => {
  const known = [{ operation: 'a', status: 500, ref: 'LD-267' }];
  it('a NOT_EXERCISED row is neither a new defect nor "now working"', () => {
    const r = evaluateGate([{ operationId: 'a', verdict: 'NOT_EXERCISED', status: 429 }, { operationId: 'b', verdict: 'WIRED', status: 200 }], known);
    expect(r.newDefects).toEqual([]);
    expect(r.nowWorking).toEqual([]);
    expect(notExercisedOps([{ operationId: 'a', verdict: 'NOT_EXERCISED' }, { operationId: 'b', verdict: 'WIRED' }])).toEqual(['a']);
  });
  it('still fails on a new defect and on a known failure that now works', () => {
    expect(evaluateGate([{ operationId: 'z', verdict: 'DEFECT', status: 500 }], known).ok).toBe(false);
    expect(evaluateGate([{ operationId: 'a', verdict: 'WIRED', status: 200 }], known).nowWorking).toEqual(['a']);
  });
  it('passes when defects equal the known list (SWEEP-1 return shape unchanged)', () => {
    expect(evaluateGate([{ operationId: 'a', verdict: 'DEFECT', status: 500 }], known)).toEqual({ ok: true, newDefects: [], nowWorking: [] });
  });
});
