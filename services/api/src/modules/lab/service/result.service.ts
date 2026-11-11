// Result service — T-13: calculated-result recompute (02-TRD §4.3 step 6, §4.4; 08 R3/R5/R7, R12a). Runs in the caller's transaction (ctx.tx).
// Tenant comes from ctx only; thrown problems never carry values. R7 outputs go only to the NEW result_versions row (store.amendCalculated).
import { LimsError } from '../../../core/errors.js';
import { computeCalculated, formulaRefsOf, orderCalculated, type CalcInput, type CalcOutcome } from '../domain/formulaInputs.js';

type Sex = 'female' | 'male' | 'other' | 'unknown';
export interface CalcTarget {
  resultId: string; analyteCode: string; expression: string; status: string; versionNo: number; rowVersion: number;
  decimals: number; testRevision: number; catalogRevision: number; sex: Sex; ageDays?: number;
}
export interface ResultStore {
  listCalculatedTargets(tx: unknown, tenantId: string, orderItemId: string): Promise<CalcTarget[]>;
  listInputs(tx: unknown, tenantId: string, orderItemId: string): Promise<CalcInput[]>;
  inputUnitByCode(tx: unknown, tenantId: string, orderItemId: string): Promise<Record<string, string>>;
  applyComputed(tx: unknown, tenantId: string, a: {
    resultId: string; expectedRowVersion: number; outcome: CalcOutcome; origin: 'calculated';
    transition?: { to: 'resulted'; rule: 'R5'; actorType: 'system'; reasonCode: 'input_changed' };
  }): Promise<void>;
  amendCalculated(tx: unknown, tenantId: string, a: {
    resultId: string; newVersionNo: number; outcome: CalcOutcome; origin: 'calculated'; reasonCode: string; reasonText?: string;
  }): Promise<void>;
}
export interface RecomputeCtx {
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly tx: object;
  now(): Date;
  readonly store: ResultStore;
  readonly events: { emit(type: string, payload: { result_id: string; version_no: number }): Promise<void> };
}
export interface RecomputeInput {
  orderItemId: string; changedAnalyteCode: string; trigger: 'enter' | 'amend';
  amendmentReason?: { reasonCode: string; reasonText?: string };
}

/** AC-09.7: a calculated analyte (has a formula) never takes a manual value. */
export function assertManualValueAllowed(i: { analyte: { formula?: { expression: string } | null } }): void {
  if (i.analyte.formula) throw new LimsError('lab.result_value_invalid');
}

/** Targets that reference `changed`, transitively. An unparseable expression cannot be ruled out, so it is always included. */
function affectedTargets(targets: readonly CalcTarget[], changed: string): CalcTarget[] {
  const hit = new Set<CalcTarget>();
  for (let grew = true; grew;) {
    grew = false;
    for (const t of targets) {
      if (hit.has(t)) continue;
      const refs = formulaRefsOf(t.expression);
      if (!refs || refs.includes(changed) || [...hit].some((h) => refs.includes(h.analyteCode))) { hit.add(t); grew = true; }
    }
  }
  return targets.filter((t) => hit.has(t));
}

export async function recomputeDependents(ctx: RecomputeCtx, i: RecomputeInput): Promise<{ resultId: string; analyteCode: string; outcome: CalcOutcome }[]> {
  const { tx, tenantId, store } = ctx;
  const targets = affectedTargets(await store.listCalculatedTargets(tx, tenantId, i.orderItemId), i.changedAnalyteCode);
  if (!targets.length) return [];
  if (i.trigger === 'amend' && !i.amendmentReason?.reasonCode && targets.some((t) => t.status === 'approved')) throw new LimsError('lab.amendment_reason_required'); // R7 always has a reason
  const inputs = [...(await store.listInputs(tx, tenantId, i.orderItemId))];
  const units = await store.inputUnitByCode(tx, tenantId, i.orderItemId);

  const { order, cyclic } = orderCalculated(targets);
  const byCode = new Map(targets.map((t) => [t.analyteCode, t]));
  const sequence = [...order, ...cyclic].map((c) => byCode.get(c) as CalcTarget);
  const cyc = new Set(cyclic);
  const out: { resultId: string; analyteCode: string; outcome: CalcOutcome }[] = [];

  for (const t of sequence) {
    const outcome: CalcOutcome = cyc.has(t.analyteCode)
      ? { calcStatus: 'not_computable', reason: 'formula_cycle' }
      : computeCalculated({
        expression: t.expression, inputs, inputUnitByCode: units, outputDecimals: t.decimals,
        ctx: { sex: t.sex, ...(t.ageDays === undefined ? {} : { ageDays: t.ageDays }) },
        testRevision: t.testRevision, catalogRevision: t.catalogRevision, evaluatedAt: ctx.now(),
      });
    let versionNo = t.versionNo;
    if (t.status === 'approved') {
      if (i.trigger !== 'amend') continue; // row is locked: never overwritten in place
      versionNo = t.versionNo + 1;
      await store.amendCalculated(tx, tenantId, {
        resultId: t.resultId, newVersionNo: versionNo, outcome, origin: 'calculated',
        reasonCode: (i.amendmentReason as { reasonCode: string }).reasonCode,
        ...(i.amendmentReason?.reasonText === undefined ? {} : { reasonText: i.amendmentReason.reasonText }),
      });
      await ctx.events.emit('lab.result.amended.v1', { result_id: t.resultId, version_no: versionNo });
    } else {
      await store.applyComputed(tx, tenantId, {
        resultId: t.resultId, expectedRowVersion: t.rowVersion, outcome, origin: 'calculated',
        ...(t.status === 'verified' ? { transition: { to: 'resulted' as const, rule: 'R5' as const, actorType: 'system' as const, reasonCode: 'input_changed' as const } } : {}),
      });
    }
    // Later targets in the chain read the fresh value, not the stale stored one.
    const fresh: CalcInput = {
      analyteCode: t.analyteCode, resultId: t.resultId, versionNo, resultType: 'numeric', unitCode: units[t.analyteCode] ?? '',
      status: outcome.calcStatus === 'computed' ? 'resulted' : 'pending',
      ...(outcome.calcStatus === 'computed' ? { value: outcome.value } : {}),
    };
    const at = inputs.findIndex((x) => x.analyteCode === t.analyteCode);
    if (at < 0) inputs.push(fresh); else inputs[at] = fresh;
    out.push({ resultId: t.resultId, analyteCode: t.analyteCode, outcome });
  }
  return out;
}
