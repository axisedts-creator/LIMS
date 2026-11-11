// Value evaluation (02-TRD §4.3 steps 1-5; 08 A17.1 / CR-C5-012 unknown age; 08 A13 D-9 ordinal). Runs in the caller's transaction (ctx.tx).
// Tenant comes from ctx only. Thrown problems never carry the submitted value (clinical data stays out of error bodies).
// R7 (amendment) outputs go ONLY to the NEW lab.result_versions row at INSERT time (evaluationColumns): the approved lab.results row is locked.
import { LimsError, isLimsError } from '../../../core/errors.js';
import { evaluateDelta, type DeltaCandidate, type DeltaOutcome, type DeltaRule } from '../domain/delta.js';
import { DECIMAL_RE, computeFlag, criticalDecision, fractionDigits, valueSha256Prefix16, validateOrdinalCode, type Flag, type ValueKind } from '../domain/flags.js';

type Sex = 'female' | 'male' | 'other' | 'unknown';
type ResultType = 'numeric' | 'ordinal' | 'coded' | 'text' | 'attachment' | 'narrative';
interface RangeMatch { referenceRangeId: string; version: number; low?: string; high?: string; text?: string; unitCode?: string; normalCodes?: readonly string[] }
interface CriticalMatch { criticalLimitId: string; version: number; low?: string; high?: string; abnormalCodes?: readonly string[] }
interface RangeQuery { analyteId: string; sex: Sex; specimenTypeCode?: string; at: string; ageDays?: number; birthOn?: string }

export interface EvalCtx {
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly tx: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
  now(): Date;
  readonly ports: { readonly CatalogPort: {
    referenceRangeFor(ctx: any, q: RangeQuery): Promise<RangeMatch>;
    criticalLimitsFor(ctx: any, q: RangeQuery): Promise<CriticalMatch | undefined>;
  } };
}

export interface Evaluation {
  flag?: Flag;
  rangeSnapshot?: { referenceRangeId: string; version: number; low?: string | undefined; high?: string | undefined; text?: string | undefined; unitCode?: string | undefined };
  critical: { isCritical: boolean; direction?: 'low' | 'high' | 'abnormal' | undefined; criticalLimitId?: string; version?: number };
  rangeUnavailableAgeUnknown: boolean;
  valueSha256Prefix16: string;
  delta: DeltaOutcome | { status: 'not_applicable' };
}

export interface EvaluateInput {
  analyte: { id: string; resultType: ResultType; decimals?: number; ordinalSetValues?: readonly { code: string; display: string; sortOrder: number }[] };
  value: string; sex: Sex; patientAgeDays: number | null; birthOn?: string; specimenTypeCode?: string; collectedAt?: Date; unitCode?: string;
  manualAbnormal?: boolean; deltaRule?: DeltaRule; deltaCandidates?: readonly DeltaCandidate[];
}

const MAX_TEXT = 2000, DEFAULT_MAX_DECIMALS = 6;
const invalid = () => new LimsError('lab.result_value_invalid');

/** Step 1: type check; returns the hash kind. Throws before any port call. */
function validate(a: EvaluateInput['analyte'], value: string): ValueKind {
  switch (a.resultType) {
    case 'numeric':
      if (!DECIMAL_RE.test(value) || fractionDigits(value) > (a.decimals ?? DEFAULT_MAX_DECIMALS)) throw invalid();
      return 'numeric';
    case 'ordinal': case 'coded':
      validateOrdinalCode(value, a.ordinalSetValues);
      return 'ordinal';
    case 'text':
      if (value.length === 0 || value.length > MAX_TEXT) throw invalid();
      return 'text';
    default: throw invalid(); // narrative / attachment are not typed in
  }
}

export async function evaluateValue(ctx: EvalCtx, i: EvaluateInput): Promise<Evaluation> {
  const kind = validate(i.analyte, i.value);
  const hash = valueSha256Prefix16(kind, i.value);
  if (kind === 'text') return { critical: { isCritical: false }, rangeUnavailableAgeUnknown: false, valueSha256Prefix16: hash, delta: { status: 'not_applicable' } };

  const ageKnown = typeof i.patientAgeDays === 'number';
  // 08 A17.1: unknown age -> keys ABSENT so the catalog returns only age-unrestricted bands.
  const q: RangeQuery = {
    analyteId: i.analyte.id, sex: i.sex, at: (i.collectedAt ?? ctx.now()).toISOString(),
    ...(i.specimenTypeCode !== undefined ? { specimenTypeCode: i.specimenTypeCode } : {}),
    ...(ageKnown ? { ageDays: i.patientAgeDays as number } : {}),
    ...(ageKnown && i.birthOn !== undefined ? { birthOn: i.birthOn } : {}),
  };
  let range: RangeMatch | undefined;
  try { range = (await ctx.ports.CatalogPort.referenceRangeFor(ctx, { ...q })) || undefined; }
  catch (e) { if (!isLimsError(e, 'catalog.no_reference_range')) throw e; }   // "no range" never fails the save; other errors fail closed
  const crit = (await ctx.ports.CatalogPort.criticalLimitsFor(ctx, { ...q })) || undefined;

  const flag = computeFlag({
    kind: kind === 'numeric' ? 'numeric' : 'code', value: i.value,
    range: range && { low: range.low, high: range.high, normalCodes: range.normalCodes },
    critical: crit && { low: crit.low, high: crit.high, abnormalCodes: crit.abnormalCodes },
    manualAbnormal: i.manualAbnormal,
  });
  const d = criticalDecision({ flag, code: kind === 'numeric' ? undefined : i.value, abnormalCodes: crit?.abnormalCodes });
  const at = i.collectedAt ?? ctx.now();
  return {
    ...(flag ? { flag } : {}),
    ...(range ? { rangeSnapshot: { referenceRangeId: range.referenceRangeId, version: range.version, low: range.low, high: range.high, text: range.text, unitCode: range.unitCode } } : {}),
    critical: d.critical && crit ? { isCritical: true, direction: d.direction, criticalLimitId: crit.criticalLimitId, version: crit.version } : { isCritical: false },
    rangeUnavailableAgeUnknown: !ageKnown && (!range || !crit),
    valueSha256Prefix16: hash,
    delta: kind === 'numeric' ? evaluateDelta({ value: i.value, unitCode: i.unitCode, at, rule: i.deltaRule, candidates: i.deltaCandidates ?? [] }) : { status: 'not_applicable' },
  };
}

/** 02-TRD §4.3 step 4: idempotent on (result, version, value hash); a critical value replaced by a non-critical one is marked, never retracted. */
export function criticalAction(i: { isCritical: boolean; valueSha256Prefix16: string; existing: readonly { valueSha256Prefix16: string; status: 'open' | 'notified' | 'closed' }[] }): { insertLogAndEmit: boolean; markValueChangedAfterDetection: boolean } {
  if (i.isCritical) return { insertLogAndEmit: !i.existing.some((e) => e.valueSha256Prefix16 === i.valueSha256Prefix16), markValueChangedAfterDetection: false };
  return { insertLogAndEmit: false, markValueChangedAfterDetection: i.existing.some((e) => e.status !== 'closed') };
}

// Shared by lab.results (R2/R3) and lab.result_versions (R7): same evaluation columns. Values are bound, never interpolated.
const COLS = ['flag', 'ref_range_id', 'ref_range_version', 'ref_low', 'ref_high', 'ref_text', 'range_unavailable_age_unknown', 'is_critical',
  'delta_status', 'delta_rule_id', 'delta_rule_version', 'delta_prev_result_id', 'delta_prev_value', 'delta_prev_at', 'delta_abs', 'delta_pct'] as const;
const RESULT_ONLY = ['ref_unit_code'] as const;   // lab.result_versions has no ref_unit_code

function columnValues(e: Evaluation, withUnit: boolean): unknown[] {
  const s = e.rangeSnapshot, dl = e.delta as DeltaOutcome;
  const vals = [e.flag ?? null, s?.referenceRangeId ?? null, s?.version ?? null, s?.low ?? null, s?.high ?? null, s?.text ?? null,
    e.rangeUnavailableAgeUnknown, e.critical.isCritical,
    dl.status, dl.ruleId ?? null, dl.ruleVersion ?? null, dl.previousResultId ?? null, dl.previousValue ?? null, dl.previousApprovedAt ?? null, dl.abs ?? null, dl.pct ?? null];
  return withUnit ? [...vals, s?.unitCode ?? null] : vals;
}

/** Column/value pairs for the evaluation outputs. R7: bound into the amendment INSERT INTO lab.result_versions (T-18);
 *  that table is immutable-by-trigger (05-SCHEMA result_versions__mutable_columns), so R7 outputs go in at INSERT time only. */
export function evaluationColumns(e: Evaluation, stage: 'R2' | 'R3' | 'R7'): { cols: string[]; values: unknown[] } {
  if (stage !== 'R2' && stage !== 'R3' && stage !== 'R7') throw new LimsError('common.internal');
  const withUnit = stage !== 'R7';
  return { cols: withUnit ? [...COLS, ...RESULT_ONLY] : [...COLS], values: columnValues(e, withUnit) };
}

/** R2/R3 only: UPDATE lab.results. R7 is rejected (use evaluationColumns in the amendment INSERT). */
export async function persistEvaluation(ctx: EvalCtx, i: { stage: 'R2' | 'R3' | 'R7'; resultId: string; versionNo: number; evaluation: Evaluation }): Promise<void> {
  if (i.stage !== 'R2' && i.stage !== 'R3') throw new LimsError('common.internal');
  const { cols, values } = evaluationColumns(i.evaluation, i.stage);
  const set = cols.map((c, n) => `${c} = $${n + 1}`).join(', ');
  const p = cols.length;
  const sql = `UPDATE lab.results SET ${set}, updated_at = now(), updated_by = $${p + 1}, version = version + 1 WHERE id = $${p + 2} AND tenant_id = $${p + 3}`;
  await ctx.tx.query(sql, [...values, ctx.actor.id, i.resultId, ctx.tenantId]);
}
