// C9 T-16 — pure auto-verify evaluation (02-TRD §8.4 `evaluateWith(V)` steps 1-8; vectors §8.5). No I/O, no clock; inputs are never mutated.
// compileRuleSet indexes a RuleSetDefinition (§8.2) by `analyte|instrument` / `analyte|*`; decimals are compared exactly (BigInt, no float).
// Fail closed: anything unexpected (unknown QC status, malformed value, non-boolean flag) leads to a deny reason, never to allow. allow <=> no reason.

export type AutoVerifyReason = 'manual_origin' | 'rule_missing' | 'critical' | 'delta_failure' | 'instrument_flag' | 'outside_autoverify_limits' | 'qc_out_of_control' | 'qc_warning' | 'qc_no_data';
export interface EvalContext {
  readonly instrumentId?: string; readonly analyteId: string; readonly valueNumeric?: string; readonly rangeFlag?: string;
  readonly instrumentFlags: readonly string[]; readonly deltaCheckFailed: boolean; readonly isCritical: boolean;
}
export interface EvalQc { readonly status: string; readonly currentRunId?: string }
export interface EvalResult { decision: 'allow' | 'deny'; reasons: AutoVerifyReason[]; matchedRuleKey?: string }

interface Dec { neg: boolean; digits: bigint; scale: number }       // value = (neg ? -1 : 1) * digits / 10^scale
interface CompiledRule { key: string; enabled: boolean; low?: Dec; high?: Dec; rangeFlags: ReadonlySet<string>; instrumentFlags: ReadonlySet<string>; qcAllowWarning: boolean }
export interface CompiledRuleSet { readonly rules: ReadonlyMap<string, CompiledRule> }

const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
const parseDec = (s: unknown): Dec | undefined => {
  if (typeof s !== 'string' || s.length > 40) return undefined;
  const m = DECIMAL.exec(s);
  return m ? { neg: m[1] === '-', digits: BigInt(m[2]! + (m[3] ?? '')), scale: (m[3] ?? '').length } : undefined;
};
function cmpDec(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const x = a.digits * 10n ** BigInt(scale - a.scale) * (a.neg ? -1n : 1n), y = b.digits * 10n ** BigInt(scale - b.scale) * (b.neg ? -1n : 1n);
  return x < y ? -1 : x > y ? 1 : 0;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, any>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const mapKey = (analyteId: string, instrumentId: string | undefined): string => `${analyteId.toLowerCase()}|${instrumentId === undefined ? '*' : instrumentId.toLowerCase()}`;

/** Throws on a definition that is not the DSL shape (the caller maps it to a failure, never to allow). */
export function compileRuleSet(definition: unknown): CompiledRuleSet {
  const rules = isObj(definition) ? own(definition, 'rules') : undefined;
  if (!Array.isArray(rules)) throw new Error('autoverify-eval: definition has no rules array');
  const out = new Map<string, CompiledRule>();
  for (const r of rules) {
    if (!isObj(r) || typeof r['key'] !== 'string' || typeof r['analyte_id'] !== 'string') throw new Error('autoverify-eval: malformed rule');
    const inst = r['instrument_id'];
    const limits = isObj(r['limits']) ? r['limits'] : {};
    const low = limits['low'] === undefined ? undefined : parseDec(limits['low']), high = limits['high'] === undefined ? undefined : parseDec(limits['high']);
    if ((limits['low'] !== undefined && !low) || (limits['high'] !== undefined && !high)) throw new Error('autoverify-eval: malformed limit');
    out.set(mapKey(r['analyte_id'], typeof inst === 'string' ? inst : undefined), {
      key: r['key'], enabled: r['enabled'] === true, ...(low ? { low } : {}), ...(high ? { high } : {}),
      rangeFlags: new Set(Array.isArray(r['allowed_range_flags']) ? r['allowed_range_flags'].filter((f): f is string => typeof f === 'string') : []),   // absent: nothing allowed (fail closed)
      instrumentFlags: new Set(Array.isArray(r['instrument_flags_allowed']) ? r['instrument_flags_allowed'].filter((f): f is string => typeof f === 'string') : []),
      qcAllowWarning: r['qc_allow_warning'] === true,
    });
  }
  return { rules: out };
}

export function evaluateWith(rs: CompiledRuleSet, rc: EvalContext, qc?: EvalQc): EvalResult {
  if (!rc.instrumentId) return { decision: 'deny', reasons: ['manual_origin'] };                              // 1. calculated / manual results are never auto-verified (D-AV-2)
  const rule = rs.rules.get(mapKey(rc.analyteId, rc.instrumentId)) ?? rs.rules.get(mapKey(rc.analyteId, undefined));   // 2. specific rule, else any-instrument; an opted-out specific rule blocks the fallback (A13)
  const usable = rule?.enabled ? rule : undefined;
  const reasons: AutoVerifyReason[] = [];
  if (!usable) reasons.push('rule_missing');
  if (rc.isCritical !== false) reasons.push('critical');                                                      // 3.
  if (rc.deltaCheckFailed !== false) reasons.push('delta_failure');                                           // 4.
  if (!Array.isArray(rc.instrumentFlags) || rc.instrumentFlags.some((f) => !usable || !usable.instrumentFlags.has(f))) reasons.push('instrument_flag');   // 5.
  if (usable) {                                                                                               // 6.
    const v = rc.valueNumeric === undefined ? undefined : parseDec(rc.valueNumeric);
    const outside = !v || (usable.low !== undefined && cmpDec(v, usable.low) < 0) || (usable.high !== undefined && cmpDec(v, usable.high) > 0)
      || rc.rangeFlag === undefined || !usable.rangeFlags.has(rc.rangeFlag);
    if (outside) reasons.push('outside_autoverify_limits');
  }
  const s = qc?.status;                                                                                       // 7. unknown / missing status fails closed as qc_no_data
  if (s === 'out_of_control') reasons.push('qc_out_of_control');
  else if (s === 'warning') { if (!usable?.qcAllowWarning) reasons.push('qc_warning'); }
  else if (s !== 'in_control') reasons.push('qc_no_data');
  // QC reasons are canonical-ordered: out_of_control < warning < no_data, and exactly one applies.
  return { decision: reasons.length === 0 ? 'allow' : 'deny', reasons, ...(usable ? { matchedRuleKey: usable.key } : {}) };   // 8.
}
