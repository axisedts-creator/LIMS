// C5 T-12 — delta check (02-TRD §4.3 step 5; 06 row T-12 "delta pct with prev 0"; AC-12.1, AC-12.2).
// Interface expected from the writer (../delta.ts) — SEAM (spec fixes behaviour, not the names):
//   export interface DeltaRule { ruleId: string; ruleVersion: number; windowSeconds: number; absThreshold?: string; pctThreshold?: string }
//   export interface DeltaCandidate { resultId: string; value: string; unitCode?: string; approvedAt: Date }      approved results of the same patient+analyte (repo query)
//   export interface DeltaOutcome { status: 'no_rule' | 'no_previous' | 'pass' | 'fail'; ruleId?: string; ruleVersion?: number;
//       previousResultId?: string; previousValue?: string; previousApprovedAt?: Date; abs?: string; pct?: string }
//   export function evaluateDelta(i: { value: string; unitCode?: string; at: Date; rule?: DeltaRule; candidates: readonly DeltaCandidate[] }): DeltaOutcome
//     previous = latest candidate with the SAME unitCode and approvedAt in [at - windowSeconds, at]. abs = |new - prev|; pct = abs / |prev| * 100 (prev = 0 -> pct undefined, pct threshold not applied).
//     fail iff abs > absThreshold (when set) or pct > pctThreshold (when set and defined); equal-to-threshold passes. Rule fields are echoed when a rule exists.
import { describe, expect, it } from 'vitest';
import { evaluateDelta, type DeltaCandidate, type DeltaRule } from '../delta.js';

const AT = new Date('2026-06-15T05:00:00Z');
const DAY = 86_400;
const ago = (seconds: number) => new Date(AT.getTime() - seconds * 1000);
const RULE: DeltaRule = { ruleId: '01a1a98a-ac40-7000-8000-0000000d0001', ruleVersion: 3, windowSeconds: 7 * DAY, absThreshold: '1.0' };
const cand = (value: string, secondsAgo: number, extra: Partial<DeltaCandidate> = {}): DeltaCandidate =>
  ({ resultId: `01a1a98a-ac40-7000-8000-${String(Math.round(secondsAgo)).padStart(12, '0')}`, value, unitCode: 'mmol/L', approvedAt: ago(secondsAgo), ...extra });
const run = (value: string, candidates: DeltaCandidate[], rule: DeltaRule | undefined = RULE, extra: object = {}) =>
  evaluateDelta({ value, unitCode: 'mmol/L', at: AT, rule, candidates, ...extra });

describe('T-12 delta: AC-12.1 / AC-12.2', () => {
  it('AC-12.1: K+ 4.0 three days earlier, new 5.2, abs threshold 1.0 -> fail, abs 1.2, previous echoed, rule id+version stored', () => {
    const p = cand('4.0', 3 * DAY);
    const r = run('5.2', [p]);
    expect(r.status).toBe('fail');
    expect(Number(r.abs)).toBe(1.2);
    expect(r.previousValue).toBe('4.0');
    expect(r.previousResultId).toBe(p.resultId);
    expect(r.previousApprovedAt).toEqual(p.approvedAt);
    expect(r.ruleId).toBe(RULE.ruleId);
    expect(r.ruleVersion).toBe(3);
    expect(r.pct).toBeDefined();
  });
  it('AC-12.2: no previous value in the window -> no_previous (rule still echoed)', () => {
    const r = run('5.2', []);
    expect(r.status).toBe('no_previous');
    expect(r.ruleId).toBe(RULE.ruleId);
    expect(r.abs).toBeUndefined();
  });
  it('no active rule -> no_rule', () => {
    expect(evaluateDelta({ value: '5.2', unitCode: 'mmol/L', at: AT, rule: undefined, candidates: [cand('4.0', DAY)] }).status).toBe('no_rule');
  });
});

describe('T-12 delta: previous-result selection', () => {
  it('older than the window is ignored; exactly at the window edge counts', () => {
    expect(run('5.2', [cand('4.0', 7 * DAY + 1)]).status).toBe('no_previous');
    expect(run('5.2', [cand('4.0', 7 * DAY)]).status).toBe('fail');
  });
  it('a different unit is ignored', () => {
    expect(run('5.2', [cand('4.0', DAY, { unitCode: 'mg/dL' })]).status).toBe('no_previous');
  });
  it('an approval after `at` is ignored', () => {
    expect(run('5.2', [cand('4.0', -60)]).status).toBe('no_previous');
  });
  it('uses the latest approved candidate, whatever the input order', () => {
    const newer = cand('5.0', DAY), older = cand('1.0', 5 * DAY);
    for (const list of [[older, newer], [newer, older]]) {
      const r = run('5.2', list);
      expect(r.previousResultId).toBe(newer.resultId);
      expect(r.status).toBe('pass'); // |5.2 - 5.0| = 0.2
    }
  });
});

describe('T-12 delta: thresholds', () => {
  it('equal-to-threshold passes (abs and pct); just over fails', () => {
    expect(run('5.0', [cand('4.0', DAY)]).status).toBe('pass'); // abs 1.0 == 1.0
    expect(run('5.1', [cand('4.0', DAY)]).status).toBe('fail');
    const pctRule: DeltaRule = { ...RULE, absThreshold: undefined, pctThreshold: '25' };
    expect(run('5.0', [cand('4.0', DAY)], pctRule).status).toBe('pass'); // 25% == 25
    expect(run('5.04', [cand('4.0', DAY)], pctRule).status).toBe('fail'); // 26%
  });
  it('pct = abs / |prev| * 100; a decrease uses |new - prev| and |prev|', () => {
    const pctRule: DeltaRule = { ...RULE, absThreshold: undefined, pctThreshold: '20' };
    const up = run('5.0', [cand('4.0', DAY)], pctRule);
    expect(Number(up.pct)).toBe(25);
    expect(up.status).toBe('fail');
    const down = run('3.0', [cand('4.0', DAY)], pctRule);
    expect(Number(down.abs)).toBe(1);
    expect(Number(down.pct)).toBe(25);
    const negPrev = run('-3.0', [cand('-4.0', DAY)], pctRule);
    expect(Number(negPrev.pct)).toBe(25);
  });
  it('either threshold alone can fail; neither set -> pass', () => {
    const both: DeltaRule = { ...RULE, absThreshold: '10', pctThreshold: '10' };
    expect(run('5.0', [cand('4.0', DAY)], both).status).toBe('fail'); // abs 1 ok, pct 25 > 10
    expect(run('4.5', [cand('4.0', DAY)], { ...RULE, absThreshold: undefined, pctThreshold: undefined }).status).toBe('pass');
  });
  it('prev = 0: pct undefined (no division by zero), pct threshold not applied, abs threshold still applies', () => {
    const pctOnly: DeltaRule = { ...RULE, absThreshold: undefined, pctThreshold: '10' };
    const a = run('1.0', [cand('0', DAY)], pctOnly);
    expect(a.pct).toBeUndefined();
    expect(a.status).toBe('pass');
    expect(Number(a.abs)).toBe(1);
    const b = run('1.0', [cand('0.0', DAY)], { ...RULE, absThreshold: '0.5', pctThreshold: '10' });
    expect(b.pct).toBeUndefined();
    expect(b.status).toBe('fail');
  });
  it('exact decimals: 0.3 vs 0.1+0.2-style values do not drift', () => {
    const r = run('0.3', [cand('0.1', DAY)], { ...RULE, absThreshold: '0.2' });
    expect(r.status).toBe('pass'); // abs exactly 0.2
  });
});
