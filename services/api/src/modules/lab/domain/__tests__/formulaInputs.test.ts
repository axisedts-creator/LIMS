// C5 T-13 — formula input collection + provenance around @lims/shared-ts/formula (02-TRD §4.4; 08 R12a: NO local parser; 06 row T-13).
// ACs: AC-09.1 (value, half-up decimals, provenance), AC-09.2 (tg_over_400), AC-09.3 (missing is never 0 -> waiting_for_inputs), AC-09.6 (unit_mismatch).
// Shared vectors: packages/fakes/contract-tests/formula.vectors.json (G1..G10 re-run here through computeCalculated).
// Interface expected from the writer (../formulaInputs.ts) — SEAM (spec fixes behaviour, not the names; shapes follow 02-TRD §4.4):
//   export interface CalcInput { analyteCode: string; resultId: string; versionNo: number; status: 'pending'|'resulted'|'verified'|'approved'|'cancelled'; resultType?: string; value?: string; unitCode?: string }
//   export type CalcOutcome =
//     | { calcStatus: 'computed'; value: string; provenance: { expression: string; test_revision: number; catalog_revision: number;
//           inputs: { analyte_code: string; result_id: string; version_no: number; value: string; unit_code: string }[]; evaluated_at: string /* ISO */; inexact: boolean } }
//     | { calcStatus: 'waiting_for_inputs'; waitingFor: string[]; reason: string /* 'missing_input:<CODE>' of the first missing */ }
//     | { calcStatus: 'not_computable'; reason: string };
//   export function computeCalculated(i: { expression: string; inputs: readonly CalcInput[]; inputUnitByCode: Record<string, string>; outputDecimals: number;
//         ctx: { ageDays?: number; ageYears?: number; sex: 'female'|'male'|'other'|'unknown' }; testRevision: number; catalogRevision: number; evaluatedAt: Date }): CalcOutcome
//     Pure, never throws. Inputs considered = those whose status is resulted|verified|approved and that carry a value; others count as missing. An input whose unitCode !== inputUnitByCode[code] -> not_computable 'unit_mismatch'.
//     Library reason 'missing_input:X' -> waiting_for_inputs; any other library failure (tg_over_400, division_by_zero, domain_error, invalid(...)) -> not_computable with that reason; parse errors -> not_computable 'formula_unparseable'.
//   export function orderCalculated(items: readonly { analyteCode: string; expression: string }[]): { order: string[]; cyclic: string[] }
//     Topological order over items that reference each other (inputs first); items in a cycle are returned in `cyclic` (reason formula_cycle), not in `order`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeCalculated, orderCalculated } from '../formulaInputs.js';

const EVAL_AT = new Date('2026-06-15T05:00:00Z');
const FRIEDEWALD = 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)';
const U = { TC: 'mg/dL', HDL: 'mg/dL', TG: 'mg/dL' };
const inp = (analyteCode: string, value: string | undefined, over: Record<string, unknown> = {}) => ({
  analyteCode, resultId: `rid-${analyteCode}`, versionNo: 1, status: 'resulted' as const, resultType: 'numeric', value, unitCode: Object.hasOwn(U, analyteCode) ? U[analyteCode as keyof typeof U] : 'u', ...over,
});
const calc = (expression: string, inputs: any[], over: Record<string, unknown> = {}) => computeCalculated({
  expression, inputs, inputUnitByCode: { ...U, ...Object.fromEntries(inputs.map((i) => [i.analyteCode, i.unitCode])) }, outputDecimals: 0,
  ctx: { sex: 'female', ageDays: 10950 }, testRevision: 3, catalogRevision: 17, evaluatedAt: EVAL_AT, ...over,
} as any);
const lipids = (tg: string) => [inp('TC', '200'), inp('HDL', '50'), inp('TG', tg)];

describe('T-13 computeCalculated — AC-09.1 Friedewald + provenance', () => {
  it('TC 200, HDL 50, TG 150 -> LDL 120, computed, provenance lists expression, revisions, each input id/version/value', () => {
    const r: any = calc(FRIEDEWALD, lipids('150'));
    expect(r.calcStatus).toBe('computed');
    expect(Number(r.value)).toBe(120);
    expect(r.provenance).toMatchObject({ expression: FRIEDEWALD, test_revision: 3, catalog_revision: 17, inexact: false });
    expect(new Date(r.provenance.evaluated_at).toISOString()).toBe(EVAL_AT.toISOString());
    expect(r.provenance.inputs).toEqual([
      { analyte_code: 'TC', result_id: 'rid-TC', version_no: 1, value: '200', unit_code: 'mg/dL' },
      { analyte_code: 'HDL', result_id: 'rid-HDL', version_no: 1, value: '50', unit_code: 'mg/dL' },
      { analyte_code: 'TG', result_id: 'rid-TG', version_no: 1, value: '150', unit_code: 'mg/dL' },
    ]);
  });
  it('provenance records the input version actually used (amended input v2)', () => {
    const r: any = calc(FRIEDEWALD, [inp('TC', '200', { versionNo: 2, status: 'approved' }), inp('HDL', '50'), inp('TG', '150')]);
    expect(r.provenance.inputs[0]).toMatchObject({ analyte_code: 'TC', version_no: 2, value: '200' });
  });
  it('rounds half-up to the output analyte decimals (2.5 -> 3 at 0 dp; 0.125 -> 0.13 at 2 dp; never banker\'s)', () => {
    expect(Number((calc('A / 2', [inp('A', '5')]) as any).value)).toBe(3);
    expect((calc('A / 8', [inp('A', '1')], { outputDecimals: 2 }) as any).value).toMatch(/^0\.13$/);
  });
  it('exact decimal arithmetic: 0.1 + 0.2 = 0.3 (no float drift)', () => {
    expect((calc('A + B', [inp('A', '0.1'), inp('B', '0.2')], { outputDecimals: 1 }) as any).value).toBe('0.3');
  });
});

describe('T-13 computeCalculated — AC-09.2 / vectors: not_computable reasons', () => {
  it('TG 450 -> not_computable tg_over_400, no value', () => {
    const r: any = calc(FRIEDEWALD, lipids('450'));
    expect(r).toMatchObject({ calcStatus: 'not_computable', reason: 'tg_over_400' });
    expect(r.value).toBeUndefined();
  });
  it('TG exactly 400 -> not_computable (>= boundary); TG 399.9 computes', () => {
    expect((calc(FRIEDEWALD, lipids('400')) as any).reason).toBe('tg_over_400');
    expect((calc(FRIEDEWALD, lipids('399.9'), { outputDecimals: 2 }) as any).calcStatus).toBe('computed');
  });
  it('NLR with LYMPH_ABS 0 -> not_computable division_by_zero (never Infinity/0)', () => {
    expect(calc('NEUT_ABS / LYMPH_ABS', [inp('NEUT_ABS', '4.20'), inp('LYMPH_ABS', '0')])).toMatchObject({ calcStatus: 'not_computable', reason: 'division_by_zero' });
  });
  it('A/G ratio (TP - ALB) / ALB computes; NLR 4.20 / 2.10 = 2', () => {
    expect(Number((calc('(TP - ALB) / ALB', [inp('TP', '7.0'), inp('ALB', '4.0')], { outputDecimals: 2 }) as any).value)).toBe(0.75);
    expect(Number((calc('NEUT_ABS / LYMPH_ABS', [inp('NEUT_ABS', '4.20'), inp('LYMPH_ABS', '2.10')], { outputDecimals: 1 }) as any).value)).toBe(2);
  });
  it('transcendental (sqrt) -> computed with provenance.inexact = true; exact arithmetic stays inexact=false', () => {
    const r: any = calc('sqrt(A)', [inp('A', '2')], { outputDecimals: 3 });
    expect(r.calcStatus).toBe('computed');
    expect(Number(r.value)).toBe(1.414);
    expect(r.provenance.inexact).toBe(true);
  });
  it('unparseable expression -> not_computable formula_unparseable (no throw, no local fallback)', () => {
    for (const bad of ['TC - ', 'if(TG >= 400, 1)', 'TC ** 2', 'a b c', '']) {
      expect(calc(bad, lipids('150'))).toMatchObject({ calcStatus: 'not_computable', reason: 'formula_unparseable' });
    }
  });
  it('C5\'s old ternary / && grammar is NOT accepted (CR-C5-002 merged into the shared grammar)', () => {
    expect((calc('TG >= 400 ? 1 : 2', lipids('150')) as any).reason).toBe('formula_unparseable');
    expect((calc('if(TG > 1 && TC > 1, 1, 2)', lipids('150')) as any).reason).toBe('formula_unparseable');
  });
});

describe('T-13 computeCalculated — AC-09.3 missing input is never 0', () => {
  it('HDL absent -> waiting_for_inputs, waitingFor [HDL], no value', () => {
    const r: any = calc(FRIEDEWALD, [inp('TC', '200'), inp('TG', '150')]);
    expect(r).toMatchObject({ calcStatus: 'waiting_for_inputs', waitingFor: ['HDL'], reason: 'missing_input:HDL' });
    expect(r.value).toBeUndefined();
  });
  it('input still pending / cancelled / no value counts as missing; all missing names are listed in formula order', () => {
    const r: any = calc(FRIEDEWALD, [inp('TC', undefined, { status: 'pending' }), inp('HDL', '50', { status: 'cancelled' }), inp('TG', '150')]);
    expect(r.calcStatus).toBe('waiting_for_inputs');
    expect(r.waitingFor).toEqual(['TC', 'HDL']);
  });
  it('an input value of "0" is a real zero, not missing (HDL 0 computes)', () => {
    expect((calc(FRIEDEWALD, [inp('TC', '200'), inp('HDL', '0'), inp('TG', '150')]) as any).calcStatus).toBe('computed');
  });
  it('unknown age with @age_days in the formula -> waiting_for_inputs, never computed with age 0', () => {
    const r: any = calc('A * @age_days', [inp('A', '2')], { ctx: { sex: 'female' } });
    expect(r.calcStatus).toBe('waiting_for_inputs');
    expect(r.value).toBeUndefined();
  });
});

describe('T-13 computeCalculated — AC-09.6 unit_mismatch + hostile inputs', () => {
  it('stored unit differs from input analyte catalog unit -> not_computable unit_mismatch', () => {
    const r = computeCalculated({
      expression: FRIEDEWALD, inputs: [inp('TC', '200', { unitCode: 'mmol/L' }), inp('HDL', '50'), inp('TG', '150')] as any,
      inputUnitByCode: U, outputDecimals: 0, ctx: { sex: 'female' }, testRevision: 1, catalogRevision: 1, evaluatedAt: EVAL_AT,
    } as any);
    expect(r).toMatchObject({ calcStatus: 'not_computable', reason: 'unit_mismatch' });
  });
  it('unit_mismatch wins over a computable value (no silent conversion)', () => {
    const r: any = calc('A + B', [inp('A', '1', { unitCode: 'g/L' }), inp('B', '2', { unitCode: 'g/L' })], { inputUnitByCode: { A: 'g/dL', B: 'g/L' } });
    expect(r.reason).toBe('unit_mismatch');
  });
  it('non-decimal / injected input values never evaluate (treated as missing, no throw)', () => {
    for (const v of ['abc', '1e999', '1; DROP TABLE lab.results', '', 'NaN', 'Infinity']) {
      const r: any = calc('A + 1', [inp('A', v)]);
      expect(['waiting_for_inputs', 'not_computable']).toContain(r.calcStatus);
      expect(r.value).toBeUndefined();
    }
  });
  it('prototype-pollution style analyte codes are not looked up on Object.prototype', () => {
    const r: any = calc('A + 1', [inp('__proto__', '5'), inp('constructor', '5')]);
    expect(r.calcStatus).toBe('waiting_for_inputs');
  });
});

describe('T-13 shared golden vectors G1..G10 (packages/fakes/contract-tests/formula.vectors.json) through computeCalculated', () => {
  const file = fileURLToPath(new URL('../../../../../../../packages/fakes/contract-tests/formula.vectors.json', import.meta.url));
  const vectors: any[] = JSON.parse(readFileSync(file, 'utf8')).vectors.filter((v: any) => /^G\d+$/.test(v.id));
  it('loads all ten G vectors', () => expect(vectors.map((v) => v.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']));
  for (const v of vectors) {
    it(`${v.id}: ${v.expression}`, () => {
      const inputs = Object.entries(v.inputs as Record<string, string | null>).filter(([, x]) => x !== null).map(([k, x]) => inp(k, x as string));
      const r: any = calc(v.expression, inputs, { outputDecimals: 6, ctx: { sex: 'unknown', ...(v.ctx ?? {}) } });
      if (v.expected.ok) {
        expect(r.calcStatus).toBe('computed');
        expect(Number(r.value)).toBeCloseTo(Number(v.expected.value), 6);
        expect(r.provenance.inexact).toBe(v.expected.inexact);
      } else if (String(v.expected.reason).startsWith('missing_input:')) {
        expect(r.calcStatus).toBe('waiting_for_inputs');
        expect(r.waitingFor).toEqual([String(v.expected.reason).slice('missing_input:'.length)]);
      } else {
        expect(r).toMatchObject({ calcStatus: 'not_computable', reason: v.expected.reason });
      }
    });
  }
});

describe('T-13 orderCalculated — topological order + cycles (02-TRD §4.4 last bullet)', () => {
  it('inputs first: C = B + 1, B = A * 2 -> B before C regardless of list order', () => {
    const r = orderCalculated([{ analyteCode: 'C', expression: 'B + 1' }, { analyteCode: 'B', expression: 'A * 2' }]);
    expect(r.cyclic).toEqual([]);
    expect(r.order).toEqual(['B', 'C']);
  });
  it('B = C + 1 and C = B + 1 -> both cyclic, neither in order', () => {
    const r = orderCalculated([{ analyteCode: 'B', expression: 'C + 1' }, { analyteCode: 'C', expression: 'B + 1' }]);
    expect(r.order).toEqual([]);
    expect([...r.cyclic].sort()).toEqual(['B', 'C']);
  });
  it('self reference is a cycle; an unparseable member is not a cycle member and does not throw', () => {
    expect(orderCalculated([{ analyteCode: 'B', expression: 'B + 1' }]).cyclic).toEqual(['B']);
    expect(() => orderCalculated([{ analyteCode: 'B', expression: '((' }, { analyteCode: 'C', expression: 'A + 1' }])).not.toThrow();
  });
});

describe('T-13 no local parser (08 R12a; 02-TRD §4.4)', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const src = readFileSync(`${dir}formulaInputs.ts`, 'utf8');
  it('formulaInputs.ts imports parseFormula/evaluateFormula from the shared lib and has no tokenizer / eval', () => {
    expect(src).toMatch(/from\s*['"](@lims\/shared-ts\/formula|(\.\.\/)+packages\/shared-ts\/src\/formula\/index\.js)['"]/);
    expect(src).toMatch(/\bparseFormula\b/);
    expect(src).toMatch(/\bevaluateFormula\b/);
    expect(src).not.toMatch(/\beval\s*\(|new Function\s*\(|\bFunction\s*\(/);
    expect(src).not.toMatch(/\b(tokenize|tokenise|lex|parseExpression|recursiveDescent)\b/i);
  });
});
