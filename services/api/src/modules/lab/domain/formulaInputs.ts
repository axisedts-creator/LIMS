// Formula input collection + provenance around @lims/shared-ts/formula (02-TRD §4.4; 08 R12a: NO local parser; 06 row T-13).
// Pure, never throws. ACs: AC-09.1 (value, half-up decimals, provenance), AC-09.2 (tg_over_400), AC-09.3 (missing is never 0), AC-09.6 (unit_mismatch).
// [CONV] relative imports until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { parseDecimal, roundDp, toDecimalString } from '../../../../../../packages/shared-ts/src/decimal/index.js';
import { evaluateFormula, parseFormula, type FormulaAst } from '../../../../../../packages/shared-ts/src/formula/index.js';

export interface CalcInput {
  analyteCode: string; resultId: string; versionNo: number;
  status: 'pending' | 'resulted' | 'verified' | 'approved' | 'cancelled';
  resultType?: string; value?: string; unitCode?: string;
}
export interface Provenance {
  expression: string; test_revision: number; catalog_revision: number;
  inputs: { analyte_code: string; result_id: string; version_no: number; value: string; unit_code: string }[];
  evaluated_at: string; inexact: boolean;
}
export type CalcOutcome =
  | { calcStatus: 'computed'; value: string; provenance: Provenance }
  | { calcStatus: 'waiting_for_inputs'; waitingFor: string[]; reason: string }
  | { calcStatus: 'not_computable'; reason: string };

export interface ComputeInput {
  expression: string; inputs: readonly CalcInput[]; inputUnitByCode: Readonly<Record<string, string>>; outputDecimals: number;
  ctx: { ageDays?: number; ageYears?: number; sex: 'female' | 'male' | 'other' | 'unknown' };
  testRevision: number; catalogRevision: number; evaluatedAt: Date;
}

const USABLE = new Set(['resulted', 'verified', 'approved']);
const notComputable = (reason: string): CalcOutcome => ({ calcStatus: 'not_computable', reason });

/** Analyte codes an expression references; undefined when it does not parse. */
export function formulaRefsOf(expression: string): readonly string[] | undefined {
  const p = parseFormula(expression);
  return p.ast ? p.refs : undefined;
}

export function computeCalculated(i: ComputeInput): CalcOutcome {
  try {
    const p = parseFormula(i.expression);
    if (!p.ast) return notComputable('formula_unparseable');
    const ast: FormulaAst = p.ast;

    // Only resulted|verified|approved inputs with a plain decimal value count; anything else is missing (never 0).
    const byCode = new Map<string, CalcInput>();
    for (const x of i.inputs) if (USABLE.has(x.status) && typeof x.value === 'string' && parseDecimal(x.value)) byCode.set(x.analyteCode, x);

    const missing = p.refs.filter((c) => !byCode.has(c));
    if (missing.length) return { calcStatus: 'waiting_for_inputs', waitingFor: [...missing], reason: `missing_input:${missing[0]}` };

    const used = i.inputs.filter((x) => byCode.get(x.analyteCode) === x && p.refs.includes(x.analyteCode));
    for (const x of used) {
      const catalogUnit = Object.hasOwn(i.inputUnitByCode, x.analyteCode) ? i.inputUnitByCode[x.analyteCode] : undefined;
      if (x.unitCode !== catalogUnit) return notComputable('unit_mismatch'); // no silent conversion (AC-09.6)
    }

    const values: Record<string, string> = Object.create(null);
    for (const x of used) values[x.analyteCode] = x.value as string;
    const r = evaluateFormula(ast, values, i.ctx);
    if (!r.ok) {
      const m = /^missing_input:(.+)$/.exec(r.reason);
      return m ? { calcStatus: 'waiting_for_inputs', waitingFor: [m[1] as string], reason: r.reason } : notComputable(r.reason);
    }
    const d = parseDecimal(r.value);
    if (!d) return notComputable('domain_error');
    return {
      calcStatus: 'computed',
      value: toDecimalString(roundDp(d, i.outputDecimals)), // half-up (never banker's)
      provenance: {
        expression: i.expression, test_revision: i.testRevision, catalog_revision: i.catalogRevision,
        inputs: used.map((x) => ({ analyte_code: x.analyteCode, result_id: x.resultId, version_no: x.versionNo, value: x.value as string, unit_code: x.unitCode as string })),
        evaluated_at: i.evaluatedAt.toISOString(), inexact: r.inexact,
      },
    };
  } catch {
    return notComputable('domain_error'); // contract: never throws
  }
}

/** Topological order (inputs first). Items in or downstream of a cycle go to `cyclic` (reason formula_cycle). */
export function orderCalculated(items: readonly { analyteCode: string; expression: string }[]): { order: string[]; cyclic: string[] } {
  const codes = new Set(items.map((x) => x.analyteCode));
  const deps = new Map(items.map((x) => [x.analyteCode, new Set((formulaRefsOf(x.expression) ?? []).filter((c) => codes.has(c)))]));
  const order: string[] = [];
  const done = new Set<string>();
  for (let progressed = true; progressed;) {
    progressed = false;
    for (const x of items) {
      if (!done.has(x.analyteCode) && [...(deps.get(x.analyteCode) as Set<string>)].every((c) => done.has(c))) {
        done.add(x.analyteCode); order.push(x.analyteCode); progressed = true;
      }
    }
  }
  // ponytail: O(n^2) fixpoint (n = calculated analytes of one order item); nodes downstream of a cycle are reported as cyclic too.
  return { order, cyclic: items.map((x) => x.analyteCode).filter((c) => !done.has(c)) };
}
