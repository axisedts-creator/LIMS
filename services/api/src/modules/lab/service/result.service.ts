// Result service — T-13: calculated-result recompute (02-TRD §4.3 step 6, §4.4; 08 R3/R5/R7, R12a). Runs in the caller's transaction (ctx.tx).
// Tenant comes from ctx only; thrown problems never carry values. R7 outputs go only to the NEW result_versions row (store.amendCalculated).
import { LimsError } from '../../../core/errors.js';
import type { PublishInput } from '../../../core/events/publish.js';
import { computeCalculated, formulaRefsOf, orderCalculated, type CalcInput, type CalcOutcome } from '../domain/formulaInputs.js';
import type { DeltaCandidate, DeltaRule } from '../domain/delta.js';
import { assertResultValueEditable, type ResultStatus } from '../domain/result.state.js';
import { createLabEvents } from '../events/publish.js';
import { criticalAction, evaluateValue, type EvalCtx, type Evaluation } from './evaluation.service.js';

type Sex = 'female' | 'male' | 'other' | 'unknown';
export interface CalcTarget {
  resultId: string; analyteCode: string; expression: string; status: string; versionNo: number; rowVersion: number;
  decimals: number; testRevision: number; catalogRevision: number; sex: Sex; ageDays?: number; ageYears?: number;
  orderId: string; testId: string; analyteId: string; // 03-IC §3.11 payload fields (review C5.T-13 item 1)
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
  readonly requestId?: string;
  readonly actor: { readonly type?: string; readonly id: string; readonly membershipId?: string };
  readonly tx: object;
  now(): Date;
  readonly store: ResultStore;
  /** core ctx.events.publish (services/api/src/core/events/publish.ts). */
  readonly events: { publish(ctx: RecomputeCtx, type: string, input: PublishInput): Promise<unknown> };
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
        ctx: { sex: t.sex, ...(t.ageDays === undefined ? {} : { ageDays: t.ageDays }), ...(t.ageYears === undefined ? {} : { ageYears: t.ageYears }) }, // 02-TRD §4.4
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
      // 03-IC §3.11: no value and no reason text in the payload (P3).
      await ctx.events.publish(ctx, 'lab.result.amended.v1', {
        aggregate: { type: 'result', id: t.resultId, seq: versionNo },
        idempotencyKey: `${t.resultId}:amended:${versionNo}`,
        payload: {
          result_id: t.resultId, previous_version_no: t.versionNo, new_version_no: versionNo,
          order_id: t.orderId, order_item_id: i.orderItemId, test_id: t.testId, analyte_id: t.analyteId,
          amendment_reason_code: (i.amendmentReason as { reasonCode: string }).reasonCode,
          amended_at: ctx.now().toISOString(), amended_by_membership_id: ctx.actor.membershipId,
        },
      });
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-14 manual entry: bulkEnterResults (02-TRD §4.3 steps 1-8, §5.4 #24, §3.2 row locking; 03-APP-FLOW R2/R3). Runs in the caller's transaction.
// Per-row failures are LimsErrors -> { outcome: 'error', code } with no result and NEVER the submitted value (S-19); any other error propagates and
// the caller rolls the whole transaction back. Tenant comes from ctx only (REQ-SEC-024); every store call is (ctx.tx, ctx.tenantId, ...).
// LD-25 (2026-11-07, A33-2 downtime mode): the handler validates entry_mode / occurred_at / downtime_ref; this service stores the already-validated
// `downtime` with each saved row and audits it. The server keeps its own clock for everything else (created_at, critical detected_at, events).
// ---------------------------------------------------------------------------------------------------------------------------------------------
type ResultType = 'numeric' | 'ordinal' | 'coded' | 'text' | 'attachment' | 'narrative';
export type ResultRow = Record<string, any>;
export interface EntryAnalyte {
  id: string; code: string; resultType: ResultType; decimals?: number;
  ordinalSetValues?: readonly { code: string; display: string; sortOrder: number }[]; formula?: { expression: string } | null;
}
export interface EntryRow {
  resultId: string; rowVersion: number; status: ResultStatus; orderId: string; orderItemId: string; specimenId?: string | undefined; patientId: string; testId: string;
  analyteId: string; centreId: string; currentVersionNo: number; sex: Sex; patientAgeDays: number | null; specimenTypeCode?: string; collectedAt?: Date; unitCode?: string;
  analyte: EntryAnalyte;
}
export interface Downtime { occurredAt: string; downtimeRef: string }
export interface EntryValue { numeric?: string; text?: string; ordinalCode?: string }
export interface SaveEntryInput {
  resultId: string; expectedRowVersion: number; transition?: 'R2' | 'R3'; origin: 'manual'; value?: EntryValue; manualAbnormal?: boolean; commentCodes?: readonly string[];
  commentText?: string; evaluation?: Evaluation; enteredByMembershipId?: string; downtime?: Downtime;
}
export interface CriticalLogInput {
  resultId: string; resultVersionNo: number; orderId: string; patientId: string; analyteId: string; centreId: string; direction: 'low' | 'high' | 'abnormal';
  valueSha256Prefix16: string; value: EntryValue; criticalLimitId?: string; criticalLimitVersion?: number; detectedAt: string;
}
/** ResultStore of T-13 plus the manual-entry operations. EVERY call takes (tx, tenantId, ...). The production (SQL) store is wired by the core pipeline task. */
export interface EntryStore extends ResultStore {
  /** ids unique + ascending (02-TRD §3.2 lock order); returns only the rows visible to the caller (absent = not found / other tenant / other centre by RLS). */
  lockResults(tx: unknown, tenantId: string, ids: readonly string[]): Promise<EntryRow[]>;
  deltaInputs(tx: unknown, tenantId: string, row: EntryRow): Promise<{ rule?: DeltaRule; candidates: readonly DeltaCandidate[] }>;
  /** UPDATE ... WHERE version = expectedRowVersion (throws common.version_conflict on a lost race) + appends the lab.result_observations row. */
  saveEntry(tx: unknown, tenantId: string, a: SaveEntryInput): Promise<ResultRow>;
  rollupSpecimen(tx: unknown, tenantId: string, specimenId: string): Promise<void>;
  getResults(tx: unknown, tenantId: string, ids: readonly string[]): Promise<ResultRow[]>;
  listCriticalLog(tx: unknown, tenantId: string, resultId: string): Promise<{ valueSha256Prefix16: string; status: 'open' | 'notified' | 'closed' }[]>;
  insertCriticalLog(tx: unknown, tenantId: string, a: CriticalLogInput): Promise<{ criticalEventId: string }>;
  markCriticalValueChanged(tx: unknown, tenantId: string, resultId: string): Promise<void>;
}
export interface EntryCtx extends Omit<RecomputeCtx, 'store'> {
  readonly store: EntryStore;
  readonly ports: EvalCtx['ports'] & { readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId: string }): Promise<void> } };
  readonly audit: { access(entry: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied'; detail?: Record<string, string | number | boolean> }): Promise<unknown> };
}
export interface EntryInput {
  entries: readonly { resultId: string; version: number; valueNumeric?: string; valueText?: string; ordinalCode?: string; manualAbnormal?: boolean; commentCodes?: readonly string[]; commentText?: string }[];
  downtime?: Downtime;
}
export interface EntryOutcome { resultId: string; outcome: 'ok' | 'error'; code?: string; result?: ResultRow }

const invalidValue = () => new LimsError('lab.result_value_invalid');
const KIND_FIELD: Record<string, 'numeric' | 'ordinal' | 'text' | undefined> = { numeric: 'numeric', ordinal: 'ordinal', coded: 'ordinal', text: 'text' };
// [CONV] access-log action for a manual result entry (03-IC §13.1 lists lab_result.view only); needs a seed row in audit.g_cs_access_actions -> CR C5-T14-audit-action.
export const ENTRY_AUDIT_ACTION = 'lab_result.enter';

export async function bulkEnterResults(rawCtx: unknown, input: EntryInput): Promise<{ results: EntryOutcome[]; recomputed: ResultRow[] }> {
  const ctx = rawCtx as EntryCtx;
  const { tx, tenantId, store } = ctx;
  const ids = [...new Set(input.entries.map((e) => e.resultId))].sort();   // 02-TRD §3.2: lock order = result id ascending
  const rows = new Map((await store.lockResults(tx, tenantId, ids)).map((r) => [r.resultId, r]));
  const labEvents = createLabEvents(ctx.events as never);
  const saved = new Map<string, EntryRow>();   // value rows saved in this batch (drives roll-up, critical, recompute)
  const touched = new Set<string>();           // ids saved in this batch (a second entry for the same row is a lost race)
  const results: EntryOutcome[] = [];

  for (const e of input.entries) {
    let rowSaved = false;   // after the save, any failure rolls the whole batch back (no savepoint; critical log/event must not be lost)
    try {
      const row = rows.get(e.resultId);
      if (!row) throw new LimsError('common.not_found');   // P-01: unknown / other tenant / invisible
      try { await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'lab.result.enter', centreId: row.centreId }); }
      catch (err) { throw err instanceof LimsError && err.code === 'auth.forbidden' ? new LimsError('common.not_found') : err; }   // P-02: 404, not 403
      if (touched.has(e.resultId)) throw new LimsError('common.version_conflict');   // ASSUMPTION: first occurrence bumped the row
      assertResultValueEditable(row.status);                                           // approved -> lab.result_locked; verified / cancelled -> lab.result_invalid_transition
      if (e.version !== row.rowVersion) throw new LimsError('common.version_conflict'); // never trust the client number

      const given = [e.valueNumeric, e.valueText, e.ordinalCode].filter((v) => v !== undefined).length;
      const hasComment = e.commentText !== undefined || (e.commentCodes?.length ?? 0) > 0;
      if (given > 1 || (given === 0 && !hasComment)) throw invalidValue();

      let value: EntryValue | undefined, evaluation: Evaluation | undefined, kind: 'n' | 'o' | 't' | undefined;
      if (given === 1) {
        assertManualValueAllowed(row);   // AC-09.7: calculated analytes never take a manual value
        const want = KIND_FIELD[row.analyte.resultType];
        const [field, v] = e.valueNumeric !== undefined ? ['numeric', e.valueNumeric] as const : e.valueText !== undefined ? ['text', e.valueText] as const : ['ordinal', e.ordinalCode as string] as const;
        if (want === undefined || want !== field) throw invalidValue();   // narrative / attachment are not typed in; wrong field for the analyte
        value = field === 'numeric' ? { numeric: v } : field === 'text' ? { text: v } : { ordinalCode: v };
        kind = field === 'numeric' ? 'n' : field === 'text' ? 't' : 'o';
        const delta = await store.deltaInputs(tx, tenantId, row);
        evaluation = await evaluateValue(ctx as unknown as EvalCtx, {
          analyte: { id: row.analyte.id, resultType: row.analyte.resultType, ...(row.analyte.decimals === undefined ? {} : { decimals: row.analyte.decimals }), ...(row.analyte.ordinalSetValues === undefined ? {} : { ordinalSetValues: row.analyte.ordinalSetValues }) },
          value: v, sex: row.sex, patientAgeDays: row.patientAgeDays,
          ...(row.specimenTypeCode === undefined ? {} : { specimenTypeCode: row.specimenTypeCode }),
          ...(row.collectedAt === undefined ? {} : { collectedAt: row.collectedAt }),
          ...(row.unitCode === undefined ? {} : { unitCode: row.unitCode }),
          ...(e.manualAbnormal === undefined ? {} : { manualAbnormal: e.manualAbnormal }),
          ...(delta.rule === undefined ? {} : { deltaRule: delta.rule }), deltaCandidates: delta.candidates,
        });
      }

      const out = await store.saveEntry(tx, tenantId, {
        resultId: e.resultId, expectedRowVersion: e.version, origin: 'manual',
        ...(value === undefined ? {} : { transition: row.status === 'pending' ? 'R2' as const : 'R3' as const, value }),
        ...(e.manualAbnormal === undefined ? {} : { manualAbnormal: e.manualAbnormal }),
        ...(e.commentCodes === undefined ? {} : { commentCodes: e.commentCodes }),
        ...(e.commentText === undefined ? {} : { commentText: e.commentText }),
        ...(evaluation === undefined ? {} : { evaluation }),
        ...(ctx.actor.membershipId === undefined ? {} : { enteredByMembershipId: ctx.actor.membershipId }),
        ...(input.downtime === undefined ? {} : { downtime: input.downtime }),
      });
      touched.add(e.resultId);
      rowSaved = true;

      if (input.downtime) {   // LD-25: audited with the paper serial and the original time; only saved rows are audited
        await ctx.audit.access({
          action: ENTRY_AUDIT_ACTION, entityType: 'result', entityId: e.resultId, centreId: row.centreId, outcome: 'allowed',
          detail: { entry_mode: 'downtime_backentry', downtime_ref: input.downtime.downtimeRef, occurred_at: input.downtime.occurredAt },
        });
      }

      if (value && evaluation && kind) {
        saved.set(e.resultId, row);
        const hash = evaluation.valueSha256Prefix16;
        const existing = await store.listCriticalLog(tx, tenantId, e.resultId);
        const act = criticalAction({ isCritical: evaluation.critical.isCritical, valueSha256Prefix16: hash, existing });
        if (act.markValueChangedAfterDetection) await store.markCriticalValueChanged(tx, tenantId, e.resultId);
        if (act.insertLogAndEmit && evaluation.critical.direction) {
          const detectedAt = ctx.now().toISOString();   // server clock, never the back-entry time (S-12 / LD-25)
          const { criticalEventId } = await store.insertCriticalLog(tx, tenantId, {
            resultId: e.resultId, resultVersionNo: row.currentVersionNo, orderId: row.orderId, patientId: row.patientId, analyteId: row.analyteId, centreId: row.centreId,
            direction: evaluation.critical.direction, valueSha256Prefix16: hash, value,
            ...(evaluation.critical.criticalLimitId === undefined ? {} : { criticalLimitId: evaluation.critical.criticalLimitId }),
            ...(evaluation.critical.version === undefined ? {} : { criticalLimitVersion: evaluation.critical.version }), detectedAt,
          });
          // 03-IC §3.13 payload: ids + direction only — no value, no comment, no downtime fields (S-12 / REQ-SEC-006).
          await labEvents.criticalValueDetected(ctx as never, {
            critical_event_id: criticalEventId, result_id: e.resultId, result_version_no: row.currentVersionNo, order_id: row.orderId, patient_id: row.patientId,
            centre_id: row.centreId, analyte_id: row.analyteId, direction: evaluation.critical.direction, detected_at: detectedAt,
          }, { value: { kind, value: (value.numeric ?? value.text ?? value.ordinalCode) as string }, resultRowVersion: Number(out['version']) });
        }
      }
      results.push({ resultId: e.resultId, outcome: 'ok', result: out });
    } catch (err) {
      if (!(err instanceof LimsError) || rowSaved) throw err;   // not a per-row problem, or the value is already saved: caller rolls back
      results.push({ resultId: e.resultId, outcome: 'error', code: err.code });   // never the value, never err.detail (S-19)
    }
  }

  // AC-09.1: dependents of every saved value row, in the same transaction (trigger 'enter').
  const recomputedIds = new Set<string>();
  const seen = new Set<string>();
  for (const row of saved.values()) {
    const k = `${row.orderItemId}\u0000${row.analyte.code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const r of await recomputeDependents(ctx as unknown as RecomputeCtx, { orderItemId: row.orderItemId, changedAnalyteCode: row.analyte.code, trigger: 'enter' })) recomputedIds.add(r.resultId);
  }
  const recomputed = recomputedIds.size ? await store.getResults(tx, tenantId, [...recomputedIds]) : [];

  // Roll-up once per distinct specimen, after every save, ascending (02-TRD §3.2: results by id first, then the specimen); none for specimen-less rows.
  const specimens = new Set<string>();
  for (const row of saved.values()) if (row.specimenId) specimens.add(row.specimenId);
  for (const r of recomputed) if (typeof r['specimen_id'] === 'string') specimens.add(r['specimen_id']);
  for (const s of [...specimens].sort()) await store.rollupSpecimen(tx, tenantId, s);

  return { results, recomputed };
}
