// C9 T-16 — pure evaluation `evaluateWith` (02-TRD §8.4 steps 1-8; vectors A1, A3-A15 of §8.5; PRD AC-13.1; 06-PLAN T-16 "property test (no reason <=> allow)").
// SEAM (domain/autoverify-eval.ts): compileRuleSet(definition) -> CompiledRuleSet; evaluateWith(rs, rc, qc?) -> { decision, reasons, matchedRuleKey? }. Pure: no I/O, no clock, inputs never mutated.
// feature_disabled (A2, A16) is a service concern (tenant setting) and is tested in decision.service.test.ts.
// Fails now: "Cannot find module ../autoverify-eval.js".
import { describe, expect, it } from 'vitest';
import { compileRuleSet, evaluateWith } from '../autoverify-eval.js';

const T = '01a1a98a-ac40-7000-8000-000000070011', K = '01a1a98a-ac40-7000-8000-000000080011', OTHER = '01a1a98a-ac40-7000-8000-000000080012';
const I1 = '01a1a98a-ac40-7000-8000-0000000d0001', I2 = '01a1a98a-ac40-7000-8000-0000000d0002', I3 = '01a1a98a-ac40-7000-8000-0000000d0003';
const RESULT = '01a1a98a-ac40-7000-8000-000000090001';
const CANON = ['manual_origin', 'rule_missing', 'critical', 'delta_failure', 'instrument_flag', 'outside_autoverify_limits', 'qc_out_of_control', 'qc_warning', 'qc_no_data'];

type R = Record<string, any>;
const rule = (o: R = {}): R => ({ key: 'K_ANY', test_id: T, analyte_id: K, enabled: true, limits: { low: '3.5', high: '5.1' }, allowed_range_flags: ['N'], instrument_flags_allowed: [], qc_allow_warning: false, ...o });
const set = (...rules: R[]) => compileRuleSet({ schema_version: 1, rules } as any);
const V3 = () => set(rule(), rule({ key: 'K_I2_OFF', instrument_id: I2, enabled: false }));
const rc = (o: R = {}): any => ({ resultId: RESULT, analyteId: K, instrumentId: I1, valueNumeric: '4.2', instrumentFlags: [], rangeFlag: 'N', deltaCheckFailed: false, isCritical: false, resultedAt: '2026-11-05T04:15:00.000Z', ...o });
const IN = { status: 'in_control', currentRunId: '01a1a98a-ac40-7000-8000-0000000a0001' } as const;
const qc = (status: string) => ({ status, currentRunId: '01a1a98a-ac40-7000-8000-0000000a0002' }) as any;
const ev = (rs: any, ctx: any, q: any = IN) => evaluateWith(rs, ctx, q);

describe('evaluateWith: the §8.5 vectors (A1, A3-A15) on fixture V3', () => {
  const V = V3();
  it.each([
    ['A1 base', rc(), IN, 'allow', []],
    ['A3 instrumentId absent', (() => { const c = rc(); delete c.instrumentId; return c; })(), undefined, 'deny', ['manual_origin']],
    ['A4 value 7.0, HH, critical', rc({ valueNumeric: '7.0', rangeFlag: 'HH', isCritical: true }), IN, 'deny', ['critical', 'outside_autoverify_limits']],
    ['A5 delta failure', rc({ deltaCheckFailed: true }), IN, 'deny', ['delta_failure']],
    ['A6 instrument flag SYN_FLAG', rc({ instrumentFlags: ['SYN_FLAG'] }), IN, 'deny', ['instrument_flag']],
    ['A7 value 5.2 H', rc({ valueNumeric: '5.2', rangeFlag: 'H' }), IN, 'deny', ['outside_autoverify_limits']],
    ['A8 value 5.1 N (inclusive high)', rc({ valueNumeric: '5.1', rangeFlag: 'N' }), IN, 'allow', []],
    ['A9 valueNumeric absent', (() => { const c = rc(); delete c.valueNumeric; return c; })(), IN, 'deny', ['outside_autoverify_limits']],
    ['A10 QC out_of_control', rc(), qc('out_of_control'), 'deny', ['qc_out_of_control']],
    ['A11 QC no_qc_data', rc(), qc('no_qc_data'), 'deny', ['qc_no_data']],
    ['A12 QC warning', rc(), qc('warning'), 'deny', ['qc_warning']],
    ['A13 instrument I2 (explicit opt-out blocks the any-instrument fallback)', rc({ instrumentId: I2 }), IN, 'deny', ['rule_missing']],
    ['A14 analyte with no rule', rc({ analyteId: OTHER }), IN, 'deny', ['rule_missing']],
    ['A15 delta + SYN_FLAG + QC out_of_control', rc({ deltaCheckFailed: true, instrumentFlags: ['SYN_FLAG'] }), qc('out_of_control'), 'deny', ['delta_failure', 'instrument_flag', 'qc_out_of_control']],
  ])('%s', (_n, ctx, q, decision, reasons) => {
    const r = ev(V, ctx, q);
    expect(r.decision).toBe(decision); expect([...r.reasons]).toEqual(reasons);
  });
  it('an allow names the matched rule; a missing or opted-out rule names none (A1 -> K_ANY)', () => {
    expect(ev(V, rc()).matchedRuleKey).toBe('K_ANY');
    expect(ev(V, rc({ analyteId: OTHER })).matchedRuleKey).toBeUndefined();
  });
  it('step 1: with no instrument NO other reason is added (calculated / manual results are never auto-verified, D-AV-2) and the QC input is not needed', () => {
    const c = rc({ isCritical: true, deltaCheckFailed: true, instrumentFlags: ['E'], valueNumeric: '99' }); delete c.instrumentId;
    expect([...ev(V, c, undefined).reasons]).toEqual(['manual_origin']);
    expect([...ev(V, c, qc('out_of_control')).reasons]).toEqual(['manual_origin']);
  });
});

describe('evaluateWith: rule selection (§8.4 step 2)', () => {
  it('an instrument-specific rule beats the any-instrument rule (its own limits apply)', () => {
    const rs = set(rule(), rule({ key: 'K_I1', instrument_id: I1, limits: { low: '4.0', high: '4.5' } }));
    expect(ev(rs, rc({ valueNumeric: '4.2' })).matchedRuleKey).toBe('K_I1');
    expect([...ev(rs, rc({ valueNumeric: '5.0' })).reasons]).toEqual(['outside_autoverify_limits']);       // 5.0 is inside K_ANY but outside K_I1
    expect(ev(rs, rc({ instrumentId: I3, valueNumeric: '5.0' })).decision).toBe('allow');                    // I3 falls back to the any-instrument rule
  });
  it('an any-instrument rule with enabled=false and no specific rule -> rule_missing; limits are NOT evaluated when no rule applies (no outside_autoverify_limits)', () => {
    const rs = set(rule({ enabled: false }));
    expect([...ev(rs, rc({ valueNumeric: '99', rangeFlag: 'HH' })).reasons]).toEqual(['rule_missing']);
    expect([...ev(set(), rc({ valueNumeric: undefined })).reasons]).toEqual(['rule_missing']);               // empty rule set
  });
  it('rule_missing still accumulates the other reasons (flags, critical, delta, QC) in canonical order', () => {
    const r = ev(set(), rc({ isCritical: true, deltaCheckFailed: true, instrumentFlags: ['E'] }), qc('no_qc_data'));
    expect([...r.reasons]).toEqual(['rule_missing', 'critical', 'delta_failure', 'instrument_flag', 'qc_no_data']);
  });
  it('step 5: with no rule every instrument flag counts; with a rule only flags outside instrument_flags_allowed (exact, case-sensitive) count', () => {
    const rs = set(rule({ instrument_flags_allowed: ['SYN_FLAG'] }));
    expect(ev(rs, rc({ instrumentFlags: ['SYN_FLAG'] })).decision).toBe('allow');
    expect([...ev(rs, rc({ instrumentFlags: ['SYN_FLAG', 'OTHER'] })).reasons]).toEqual(['instrument_flag']);
    expect([...ev(rs, rc({ instrumentFlags: ['syn_flag'] })).reasons]).toEqual(['instrument_flag']);
    expect([...ev(set(), rc({ instrumentFlags: ['SYN_FLAG'] })).reasons]).toEqual(['rule_missing', 'instrument_flag']);
  });
});

describe('evaluateWith: limits and range flags (§8.4 step 6) — exact decimal compare, inclusive', () => {
  const V = V3();
  it.each([
    ['3.5', 'allow'], ['3.50', 'allow'], ['03.5', 'allow'], ['5.1', 'allow'], ['5.10', 'allow'], ['5.1000000000000000000000000000000000', 'allow'],
    ['5.1000000000000000000000000000000001', 'deny'], ['3.4999999999999999999999999999999999', 'deny'], ['3.49', 'deny'], ['5.11', 'deny'], ['-4.2', 'deny'], ['0', 'deny'], ['1000000000000000000000000000000', 'deny'],
  ])('value %s -> %s (no float rounding: 0.1+0.2 style values compare exactly)', (v, d) => {
    expect(ev(V, rc({ valueNumeric: v })).decision).toBe(d);
  });
  it('limits with only one bound: low-only has no upper limit, high-only has no lower limit; a deny names outside_autoverify_limits once', () => {
    expect(ev(set(rule({ limits: { low: '3.5' } })), rc({ valueNumeric: '1000' })).decision).toBe('allow');
    expect([...ev(set(rule({ limits: { low: '3.5' } })), rc({ valueNumeric: '3.4' })).reasons]).toEqual(['outside_autoverify_limits']);
    expect(ev(set(rule({ limits: { high: '5.1' } })), rc({ valueNumeric: '-1000' })).decision).toBe('allow');
    expect([...ev(set(rule({ limits: { high: '5.1' } })), rc({ valueNumeric: '5.2', rangeFlag: 'H' })).reasons]).toEqual(['outside_autoverify_limits']);
  });
  it('negative limits compare numerically (-5.0..-1.0)', () => {
    const rs = set(rule({ limits: { low: '-5.0', high: '-1.0' } }));
    expect(ev(rs, rc({ valueNumeric: '-2.5' })).decision).toBe('allow');
    expect(ev(rs, rc({ valueNumeric: '-5.01' })).decision).toBe('deny');
    expect(ev(rs, rc({ valueNumeric: '-0.99' })).decision).toBe('deny');
  });
  it('range flag: absent, or not in allowed_range_flags, -> outside_autoverify_limits; LL / HH / A are never allowed; L and H only when listed', () => {
    const c = rc(); delete c.rangeFlag;
    expect([...ev(V, c).reasons]).toEqual(['outside_autoverify_limits']);
    for (const f of ['L', 'H', 'LL', 'HH', 'A']) expect([...ev(V, rc({ rangeFlag: f })).reasons], f).toEqual(['outside_autoverify_limits']);
    const wide = set(rule({ allowed_range_flags: ['N', 'L', 'H'] }));
    for (const f of ['N', 'L', 'H']) expect(ev(wide, rc({ rangeFlag: f })).decision, f).toBe('allow');
    for (const f of ['LL', 'HH', 'A']) expect(ev(wide, rc({ rangeFlag: f })).decision, f).toBe('deny');
  });
  it('a value outside the limits AND a bad flag still gives ONE outside_autoverify_limits', () => {
    expect([...ev(V, rc({ valueNumeric: '9', rangeFlag: 'HH' })).reasons]).toEqual(['outside_autoverify_limits']);
  });
});

describe('evaluateWith: QC (§8.4 step 7)', () => {
  it('warning is allowed only when the matched rule has qc_allow_warning; with no rule it is qc_warning (after rule_missing)', () => {
    expect(ev(set(rule({ qc_allow_warning: true })), rc(), qc('warning')).decision).toBe('allow');
    expect([...ev(set(rule({ qc_allow_warning: false })), rc(), qc('warning')).reasons]).toEqual(['qc_warning']);
    expect([...ev(set(), rc(), qc('warning')).reasons]).toEqual(['rule_missing', 'qc_warning']);
  });
  it('qc_allow_warning never softens out_of_control or no_qc_data', () => {
    const rs = set(rule({ qc_allow_warning: true }));
    expect([...ev(rs, rc(), qc('out_of_control')).reasons]).toEqual(['qc_out_of_control']);
    expect([...ev(rs, rc(), qc('no_qc_data')).reasons]).toEqual(['qc_no_data']);
  });
  it('an unknown QC status fails closed (never allow)', () => {
    expect(ev(V3(), rc(), qc('something_new')).decision).toBe('deny');
  });
});

describe('evaluateWith / compileRuleSet: purity', () => {
  it('does not mutate the compiled set, the ResultContext or the QC input (all deep-frozen) and is deterministic', () => {
    const def = { schema_version: 1, rules: [rule(), rule({ key: 'K_I2_OFF', instrument_id: I2, enabled: false })] };
    const deepFreeze = (o: any): any => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); return o; };
    deepFreeze(def); const ctx = deepFreeze(rc({ instrumentFlags: ['SYN_FLAG'] })), q = deepFreeze({ ...qc('warning') });
    const rs = compileRuleSet(def as any);
    const a = evaluateWith(rs, ctx, q), b = evaluateWith(rs, ctx, q);
    expect(a).toEqual(b);
    expect(typeof a.decision).toBe('string');
  });
  it('returns fresh arrays (a caller mutating reasons cannot poison the next evaluation)', () => {
    const rs = V3(); const a: any = ev(rs, rc({ isCritical: true })); a.reasons.push('x');
    expect([...ev(rs, rc({ isCritical: true })).reasons]).toEqual(['critical']);
  });
  it('a hostile rc (prototype keys, extra fields, huge flag list) never throws and never allows', () => {
    const r = ev(V3(), rc({ __proto__: { isCritical: false }, constructor: 1, extra: { a: 1 }, instrumentFlags: Array.from({ length: 5000 }, (_, i) => `F${i}`) }));
    expect(r.decision).toBe('deny'); expect([...r.reasons]).toEqual(['instrument_flag']);
  });
});

// ---------------------------------------------------------------------------------------------------- property test (06-PLAN T-16: "no reason <=> allow")
function prng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return (s >>> 8) / 0x1000000; }; }
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe('property: decision === allow <=> reasons is empty, over random rule sets and contexts (seeded, 4000 cases)', () => {
  /** Independent oracle of §8.4: allow iff every criterion holds. Written from the spec table, not from the implementation. */
  function oracleAllow(rule: R | undefined, c: any, q: any): boolean {
    if (!c.instrumentId || !rule || rule.enabled === false) return false;
    if (c.isCritical || c.deltaCheckFailed) return false;
    if ((c.instrumentFlags as string[]).some((f) => !rule.instrument_flags_allowed.includes(f))) return false;
    if (c.valueNumeric === undefined) return false;
    const v = Number(c.valueNumeric); const lo = rule.limits.low === undefined ? -Infinity : Number(rule.limits.low), hi = rule.limits.high === undefined ? Infinity : Number(rule.limits.high);
    if (v < lo || v > hi) return false;
    if (!c.rangeFlag || !rule.allowed_range_flags.includes(c.rangeFlag)) return false;
    return q.status === 'in_control' || (q.status === 'warning' && rule.qc_allow_warning === true);
  }
  it('holds, reasons are canonical-ordered without duplicates, and allow agrees with the independent oracle', () => {
    const r = prng(20261105); let allows = 0, denies = 0;
    for (let i = 0; i < 4000; i++) {
      const rules: R[] = [];
      if (r() < 0.9) rules.push(rule({ key: 'ANY', limits: pick(r, [{ low: '3.5', high: '5.1' }, { low: '3.5' }, { high: '5.1' }]), allowed_range_flags: pick(r, [['N'], ['N', 'L'], ['N', 'L', 'H']]),
        instrument_flags_allowed: pick(r, [[], ['SYN_FLAG'], ['SYN_FLAG', 'B']]), qc_allow_warning: r() < 0.5, enabled: r() < 0.9 }));
      if (r() < 0.4) rules.push(rule({ key: 'I1', instrument_id: I1, limits: { low: '4.0', high: '4.6' }, allowed_range_flags: ['N'], enabled: r() < 0.7 }));
      const rs = compileRuleSet({ schema_version: 1, rules } as any);
      const c = rc({
        analyteId: pick(r, [K, K, K, OTHER]), instrumentId: pick(r, [I1, I2, I3, undefined]), valueNumeric: pick(r, ['4.2', '4.0', '4.6', '4.61', '3.5', '5.1', '5.2', '3.4', '0', '-1', undefined]),
        instrumentFlags: pick(r, [[], [], ['SYN_FLAG'], ['SYN_FLAG', 'B'], ['E']]), rangeFlag: pick(r, ['N', 'N', 'L', 'H', 'LL', 'HH', 'A', undefined]), deltaCheckFailed: r() < 0.15, isCritical: r() < 0.15,
      });
      if (c.instrumentId === undefined) delete c.instrumentId; if (c.valueNumeric === undefined) delete c.valueNumeric; if (c.rangeFlag === undefined) delete c.rangeFlag;
      const q = qc(pick(r, ['in_control', 'in_control', 'warning', 'out_of_control', 'no_qc_data']));
      const res = evaluateWith(rs, c, c.instrumentId ? q : undefined);

      expect(res.decision === 'allow', JSON.stringify({ c, q: q.status, rules })).toBe(res.reasons.length === 0);
      expect(new Set(res.reasons).size).toBe(res.reasons.length);
      const idx = res.reasons.map((x) => CANON.indexOf(x)); expect(idx.every((n) => n >= 0)).toBe(true); expect(idx).toEqual([...idx].sort((a, b) => a - b));
      const applicable = c.instrumentId ? (rules.find((x) => x.instrument_id === c.instrumentId && x.analyte_id === c.analyteId) ?? rules.find((x) => !x.instrument_id && x.analyte_id === c.analyteId)) : undefined;
      expect(res.decision === 'allow', JSON.stringify({ c, q: q.status, rules })).toBe(oracleAllow(applicable, c, q));
      if (res.decision === 'allow') allows++; else denies++;
    }
    expect(allows).toBeGreaterThan(100); expect(denies).toBeGreaterThan(100);   // the generator exercises both outcomes
  });
});
