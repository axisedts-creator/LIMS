// C12 consumption-rule matching and precedence — 02-TRD §8.3 (AC-12.6). Pure; property names are the spec's column names.
import { LimsError } from '../../../core/errors.js';
import { formatScaled, parseBaseQty, scaled } from './quantity.js';

export type FactKind = 'test' | 'analyte' | 'rerun' | 'qc' | 'calibration' | 'fixed';
export type RuleKind = 'per_test' | 'per_analyte' | 'per_rerun' | 'per_qc' | 'per_calibration' | 'per_day';

const KIND = new Map<string, RuleKind>([
  ['test', 'per_test'], ['analyte', 'per_analyte'], ['rerun', 'per_rerun'], ['qc', 'per_qc'], ['calibration', 'per_calibration'], ['fixed', 'per_day'],
]);

const fail = (msg: string): never => {
  throw new LimsError('common.validation_failed', msg);
};

export function ruleKindForFact(factKind: FactKind): RuleKind {
  return KIND.get(factKind) ?? fail('unknown fact kind');
}

export interface RuleFact {
  fact_kind: FactKind; occurred_at: string; instrument_id: string | null; test_id: string | null; analyte_id: string | null; multiplier: number; rule_id?: string;
}
export interface Rule {
  id: string; rule_kind: RuleKind; test_id: string | null; analyte_id: string | null; instrument_id: string | null; item_id: string;
  qty_base: string; effective_from: string; effective_to: string | null; is_active: boolean;
}
export interface Need { rule_id: string; item_id: string; qty_base: string; attributed_test_id: string | null }

const instant = (s: string): number => {
  const t = typeof s === 'string' ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? fail('invalid timestamp') : t;
};

/** Step 1 key match for one rule of the fact's kind. */
function keyMatches(kind: RuleKind, f: RuleFact, r: Rule): boolean {
  switch (kind) {
    case 'per_test': case 'per_rerun': case 'per_calibration':
      return f.test_id !== null && r.test_id === f.test_id;
    case 'per_analyte':
      return f.test_id !== null && f.analyte_id !== null && r.test_id === f.test_id && r.analyte_id === f.analyte_id;
    case 'per_qc': // test_id on the rule is the attribution test; analyte = A or null
      return r.analyte_id === null || r.analyte_id === f.analyte_id;
    case 'per_day': // only the rule the cron names, never "all per_day rules"
      return f.rule_id !== undefined && r.id === f.rule_id;
  }
}

/** §8.3: active rules of the kind, window [from, to) at t, key match, instrument-specific overrides generic per (item[, analyte]) group. */
export function matchRules(fact: RuleFact, rules: readonly Rule[]): Need[] {
  if (!Number.isInteger(fact.multiplier) || fact.multiplier < 1 || fact.multiplier > 50) fail('multiplier must be an integer 1–50');
  const kind = ruleKindForFact(fact.fact_kind);
  const t = instant(fact.occurred_at);
  const hits = rules.filter(
    (r) =>
      r.is_active && r.rule_kind === kind && keyMatches(kind, fact, r) &&
      (kind === 'per_day' || r.instrument_id === null || r.instrument_id === fact.instrument_id) &&
      instant(r.effective_from) <= t && (r.effective_to === null || t < instant(r.effective_to)),
  );
  const groups = new Map<string, Rule[]>();
  for (const r of hits) {
    const k = kind === 'per_qc' ? `${r.item_id}|${r.analyte_id ?? ''}` : r.item_id;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const m = BigInt(fact.multiplier);
  return [...groups.values()].flatMap((g) => {
    const specific = g.filter((r) => r.instrument_id !== null);
    return (specific.length > 0 ? specific : g).map((r) => {
      parseBaseQty(r.qty_base);
      const qty = formatScaled(scaled(r.qty_base, 6) * m, 6);
      return { rule_id: r.id, item_id: r.item_id, qty_base: qty, attributed_test_id: r.test_id };
    });
  });
}
