// Result service — T-13: calculated-result recompute (02-TRD §4.3 step 6, §4.4; 08 R3/R5/R7, R12a). Runs in the caller's transaction (ctx.tx).
// Tenant comes from ctx only; thrown problems never carry values. R7 outputs go only to the NEW result_versions row (store.amendCalculated).
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { PublishInput } from '../../../core/events/publish.js';
import { computeCalculated, formulaRefsOf, orderCalculated, type CalcInput, type CalcOutcome } from '../domain/formulaInputs.js';
import type { DeltaCandidate, DeltaRule } from '../domain/delta.js';
import { assertResultValueEditable, resultTransition, type ResultStatus } from '../domain/result.state.js';
import { createLabEvents } from '../events/publish.js';
import { criticalAction, evaluateValue, type EvalCtx, type Evaluation } from './evaluation.service.js';
import { evaluateOrderReadiness, type ReadinessStore } from './order.service.js';

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
  departmentId?: string;   // T-18: comment codes resolve against the row's department (03-IC §4.2)
  analyte: EntryAnalyte;
}
export interface Downtime { occurredAt: string; downtimeRef: string }
export interface EntryValue { numeric?: string; text?: string; ordinalCode?: string }
export interface SaveEntryInput {
  resultId: string; expectedRowVersion: number; transition?: 'R2' | 'R3'; origin: 'manual'; value?: EntryValue; manualAbnormal?: boolean; commentCodes?: readonly string[];
  commentText?: string; commentLibVersions?: Record<string, number>; evaluation?: Evaluation; enteredByMembershipId?: string; downtime?: Downtime;
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
/** CR-C5-001 = CR-C3-001 (03-IC §4.2): CatalogPort.resolveCommentCodes; <= 50 codes per call (C3 02-TRD §4.14); unknown codes come back in `unknown`, never thrown. */
export interface CommentCatalog {
  resolveCommentCodes(ctx: unknown, q: { codes: readonly string[]; departmentId?: string; asOf?: string }): Promise<{ resolved: readonly { code: string; version: number; text: string }[]; unknown: readonly string[] }>;
}
export interface EntryCtx extends Omit<RecomputeCtx, 'store'> {
  readonly store: EntryStore;
  readonly ports: Omit<EvalCtx['ports'], 'CatalogPort'> & { readonly CatalogPort: EvalCtx['ports']['CatalogPort'] & CommentCatalog } & { readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId: string }): Promise<void> } };
  readonly audit: { access(entry: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied'; detail?: Record<string, string | number | boolean> }): Promise<unknown> };
}
export interface EntryInput {
  entries: readonly { resultId: string; version: number; valueNumeric?: string; valueText?: string; ordinalCode?: string; manualAbnormal?: boolean; commentCodes?: readonly string[]; commentText?: string }[];
  downtime?: Downtime;
}
export interface EntryOutcome { resultId: string; outcome: 'ok' | 'error'; code?: string; result?: ResultRow }

const invalidValue = () => new LimsError('lab.result_value_invalid');
const MAX_COMMENT_CODES = 10;      // lab.results CHECK results__comment_codes__ck
const CATALOG_CODES_PER_CALL = 50; // C3 02-TRD §4.14
const MAX_COMMENT_TEXT = 1000;     // lab.results CHECK results__comment_text__ck
const fieldInvalid = (path: string): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' }); // fixed text: nothing submitted is echoed (S-19)

/**
 * AC-10.2 / AC-10.3 (CR-C5-001): re-resolve every comment code of the batch up front, so an unknown code saves nothing. Codes are upper-cased and de-duplicated
 * per entry ([CONV]: order kept, first occurrence wins). Rejects the whole request with common.validation_failed + errors[] paths /entries/n/comment_codes[/k].
 * Returns, per entry index, the codes, the { code: library version } jsonb and the expanded library text (texts joined by one space, in entry order).
 */
async function resolveEntryComments(ctx: EntryCtx, entries: EntryInput['entries'], rows: ReadonlyMap<string, EntryRow>): Promise<Map<number, { codes: string[]; versions: Record<string, number>; text: string }>> {
  const errors: FieldError[] = [];
  const wanted = new Map<number, string[]>();
  entries.forEach((e, n) => {
    if (!e.commentCodes?.length) return;
    if (e.commentCodes.length > MAX_COMMENT_CODES) { errors.push(fieldInvalid(`/entries/${n}/comment_codes`)); return; }
    e.commentCodes.forEach((c, k) => { if (typeof c !== 'string' || !c) errors.push(fieldInvalid(`/entries/${n}/comment_codes/${k}`)); });
    if (rows.has(e.resultId)) wanted.set(n, e.commentCodes.map((c) => String(c).toUpperCase()));   // missing row: its per-row common.not_found handles it
  });
  if (errors.length) throw new LimsError('common.validation_failed', undefined, errors);
  // 03-IC §4.2: a department-specific active code wins over tenant-wide -> one resolve per department of the rows (review T-18 #1).
  const dept = (n: number) => rows.get(entries[n]!.resultId)?.departmentId;
  const byDept = new Map<string | undefined, Set<string>>();
  for (const [n, codes] of wanted) { const d = dept(n); const s = byDept.get(d) ?? new Set<string>(); codes.forEach((c) => s.add(c)); byDept.set(d, s); }
  const lib = new Map<string | undefined, Map<string, { version: number; text: string }>>();
  for (const [d, set] of byDept) {
    const m = new Map<string, { version: number; text: string }>();
    const distinct = [...set];
    for (let i = 0; i < distinct.length; i += CATALOG_CODES_PER_CALL) {
      const r = await ctx.ports.CatalogPort.resolveCommentCodes(ctx, { codes: distinct.slice(i, i + CATALOG_CODES_PER_CALL), ...(d === undefined ? {} : { departmentId: d }) });   // tenant from ctx only; a catalog failure propagates (not "unknown")
      for (const x of r.resolved) m.set(x.code.toUpperCase(), { version: x.version, text: x.text });
    }
    lib.set(d, m);
  }
  const out = new Map<number, { codes: string[]; versions: Record<string, number>; text: string }>();
  for (const [n, codes] of wanted) {
    const l = lib.get(dept(n))!;
    codes.forEach((c, k) => { if (!l.has(c)) errors.push(fieldInvalid(`/entries/${n}/comment_codes/${k}`)); });
    const uniq = [...new Set(codes)];
    const text = uniq.map((c) => l.get(c)?.text ?? '').join(' ');
    // results__comment_text__ck / #24: comment_text <= 1000 chars; only the server-built expansion is checked (a sent text is validated by the contract). Review T-18 #2.
    if (entries[n]!.commentText === undefined && text.length > MAX_COMMENT_TEXT) errors.push(fieldInvalid(`/entries/${n}/comment_codes`));
    out.set(n, { codes: uniq, versions: Object.fromEntries(uniq.map((c) => [c, l.get(c)?.version ?? 0])), text });
  }
  if (errors.length) throw new LimsError('common.validation_failed', undefined, errors);
  return out;
}
const KIND_FIELD: Record<string, 'numeric' | 'ordinal' | 'text' | undefined> = { numeric: 'numeric', ordinal: 'ordinal', coded: 'ordinal', text: 'text' };
// [CONV] access-log action for a manual result entry (03-IC §13.1 lists lab_result.view only); needs a seed row in audit.g_cs_access_actions -> CR C5-T14-audit-action.
export const ENTRY_AUDIT_ACTION = 'lab_result.enter';

export async function bulkEnterResults(rawCtx: unknown, input: EntryInput): Promise<{ results: EntryOutcome[]; recomputed: ResultRow[] }> {
  const ctx = rawCtx as EntryCtx;
  const { tx, tenantId, store } = ctx;
  const ids = [...new Set(input.entries.map((e) => e.resultId))].sort();   // 02-TRD §3.2: lock order = result id ascending
  const rows = new Map((await store.lockResults(tx, tenantId, ids)).map((r) => [r.resultId, r]));
  const comments = await resolveEntryComments(ctx, input.entries, rows);   // AC-10.3: after the lock (needs the row's department), before any save; unknown code -> 400, nothing saved
  const labEvents = createLabEvents(ctx.events as never);
  const saved = new Map<string, EntryRow>();   // value rows saved in this batch (drives roll-up, critical, recompute)
  const touched = new Set<string>();           // ids saved in this batch (a second entry for the same row is a lost race)
  const results: EntryOutcome[] = [];

  for (const [n, e] of input.entries.entries()) {
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

      const cm = comments.get(n);
      const out = await store.saveEntry(tx, tenantId, {
        resultId: e.resultId, expectedRowVersion: e.version, origin: 'manual',
        ...(value === undefined ? {} : { transition: row.status === 'pending' ? 'R2' as const : 'R3' as const, value }),
        ...(e.manualAbnormal === undefined ? {} : { manualAbnormal: e.manualAbnormal }),
        ...(cm ? { commentCodes: cm.codes, commentLibVersions: cm.versions } : e.commentCodes === undefined ? {} : { commentCodes: e.commentCodes }),
        ...(e.commentText !== undefined ? { commentText: e.commentText } : cm ? { commentText: cm.text } : {}),   // AC-10.2: sent text kept verbatim (UI expanded it); else the stored expansion
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-16 verify / bulk verify / return / auto-verify hook (02-TRD §3.3 R4/R5, §4.5 rows 10-11, §5.4 #27-#29; 03-IC §3.9, §4.11, §10.2; 08 A13 D-2, A17.1, CR-C5-005, CR-C9-004).
// Same rules as bulkEnterResults: caller's tx, tenant from ctx only, per-row LimsError -> error row (code only, S-19), P-01/P-02 -> common.not_found.
// Check order: not found / no role -> version -> transition table -> on hold -> flag acknowledgement. verify/return never write a value column (S-03).
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type AckFlag = 'delta' | 'critical' | 'unit_mismatch' | 'instrument_flag';
export interface VerifyRow {
  resultId: string; rowVersion: number; status: ResultStatus; onHold: boolean; unitMismatch: boolean; deltaStatus: 'not_applicable' | 'no_rule' | 'no_previous' | 'pass' | 'fail';
  isCritical: boolean; instrumentFlags: readonly string[]; origin: 'manual' | 'instrument' | 'calculated' | 'module'; rangeUnavailableAgeUnknown: boolean;
  orderId: string; orderItemId: string; specimenId?: string | undefined; testId: string; analyteId: string; departmentId: string; instrumentId?: string | undefined; centreId: string;
  currentVersionNo: number; flag?: string | undefined; valueNumeric?: string | undefined; resultedAt: Date;
}
/** Every call takes (tx, tenantId, ...). The production (SQL) store is wired with the core pipeline (as T-14/T-15). */
export interface VerifyStore {
  /** ids unique + ascending (02-TRD §3.2); returns the rows visible to the caller only. */
  lockForVerify(tx: unknown, tenantId: string, ids: readonly string[]): Promise<VerifyRow[]>;
  /** R4 UPDATE ... WHERE version = expectedRowVersion (throws common.version_conflict on a lost race) + lab.verifications row kind 'verified'. */
  verify(tx: unknown, tenantId: string, a: { resultId: string; expectedRowVersion: number; mode: 'manual' | 'auto'; membershipId?: string; acknowledgedFlags: readonly string[]; ruleSetVersion?: string; occurredAt: string }): Promise<ResultRow>;
  /** R5 + lab.verifications row kind 'returned'. */
  applyReturn(tx: unknown, tenantId: string, a: { resultId: string; expectedRowVersion: number; reasonCode: string; comment?: string; membershipId?: string; occurredAt: string }): Promise<ResultRow>;
  returnReasonActive(tx: unknown, tenantId: string, code: string): Promise<boolean>;
  resolveUnitMismatchException(tx: unknown, tenantId: string, a: { resultId: string; resolverMembershipId?: string; resolution: 'assigned' }): Promise<void>;
  rollupSpecimen(tx: unknown, tenantId: string, specimenId: string): Promise<void>;
}
export interface VerifyCtx extends Omit<RecomputeCtx, 'store'> {
  readonly store: VerifyStore;
  readonly config: { readonly autoverifyHookEnabled: boolean };
  readonly ports: {
    readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string; centreId: string }): Promise<void> };
    readonly QualityPort?: { canAutoVerify(ctx: unknown, rc: Record<string, unknown>): Promise<{ decision: 'allow' | 'deny'; reasons: readonly string[]; ruleSetVersion?: string }> };
  };
}
export interface VerifyItem { resultId: string; version: number; acknowledgedFlags?: readonly string[] }
export interface ReturnInput { resultId: string; version: number; reasonCode: string; comment?: string }

const needed = (r: VerifyRow): AckFlag[] => [
  ...(r.deltaStatus === 'fail' ? ['delta' as const] : []), ...(r.isCritical ? ['critical' as const] : []),
  ...(r.unitMismatch ? ['unit_mismatch' as const] : []), ...(r.instrumentFlags.length > 0 ? ['instrument_flag' as const] : []),
];

/** P-01 / P-02: unknown, foreign or role-less centre is the same 404; any other role-check failure propagates. */
async function visibleRow(ctx: VerifyCtx, row: VerifyRow | undefined): Promise<VerifyRow> {
  if (!row) throw new LimsError('common.not_found');
  try { await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'lab.result.verify', centreId: row.centreId }); }
  catch (err) { throw err instanceof LimsError && err.code === 'auth.forbidden' ? new LimsError('common.not_found') : err; }
  return row;
}

/** R4 for an already checked row. Returns the saved row; any failure after the store call propagates (caller rolls back). */
async function applyVerify(ctx: VerifyCtx, row: VerifyRow, a: { mode: 'manual' | 'auto'; acknowledgedFlags: readonly string[]; ruleSetVersion?: string }): Promise<ResultRow> {
  const { tx, tenantId, store } = ctx;
  const occurredAt = ctx.now().toISOString();   // server clock
  const manual = a.mode === 'manual';
  const out = await store.verify(tx, tenantId, {
    resultId: row.resultId, expectedRowVersion: row.rowVersion, mode: a.mode,
    ...(manual && ctx.actor.membershipId !== undefined ? { membershipId: ctx.actor.membershipId } : {}),
    acknowledgedFlags: a.acknowledgedFlags, ...(a.ruleSetVersion === undefined ? {} : { ruleSetVersion: a.ruleSetVersion }), occurredAt,
  });
  if (manual && row.unitMismatch && a.acknowledgedFlags.includes('unit_mismatch')) {   // 02-TRD §4.5 row 10: the acknowledgement resolves the open exception
    await store.resolveUnitMismatchException(tx, tenantId, { resultId: row.resultId, resolution: 'assigned', ...(ctx.actor.membershipId === undefined ? {} : { resolverMembershipId: ctx.actor.membershipId }) });
  }
  // 03-IC §3.9 / D-2: no value; no specimen_id when specimen-less; verified_by_membership_id only for mode manual.
  await createLabEvents(ctx.events as never).resultVerified(ctx as never, {
    result_id: row.resultId, result_version_no: row.currentVersionNo, order_id: row.orderId, order_item_id: row.orderItemId,
    ...(row.specimenId === undefined ? {} : { specimen_id: row.specimenId }),
    test_id: row.testId, analyte_id: row.analyteId, department_id: row.departmentId,
    ...(row.instrumentId === undefined ? {} : { instrument_id: row.instrumentId }),
    origin: row.origin, mode: a.mode, verified_at: occurredAt,
    ...(manual && ctx.actor.membershipId !== undefined ? { verified_by_membership_id: ctx.actor.membershipId } : {}),
  }, { resultRowVersion: Number(out['version']) });
  return out;
}

/** Table -> hold -> flag acknowledgement (CR-C5-005). Returns the de-duplicated acknowledgements to store. */
function checkVerifiable(row: VerifyRow, acknowledged: readonly string[] | undefined): string[] {
  resultTransition(row.status, 'verified', { onHold: row.onHold });
  const acks = [...new Set(acknowledged ?? [])];
  if (needed(row).some((f) => !acks.includes(f))) throw new LimsError('lab.flag_ack_required');
  return acks;
}

export async function verifyResult(rawCtx: unknown, i: VerifyItem): Promise<ResultRow> {
  const ctx = rawCtx as VerifyCtx;
  const row = await visibleRow(ctx, (await ctx.store.lockForVerify(ctx.tx, ctx.tenantId, [i.resultId]))[0]);
  if (i.version !== row.rowVersion) throw new LimsError('common.version_conflict');   // never trust the client number for the write
  const acks = checkVerifiable(row, i.acknowledgedFlags);
  const out = await applyVerify(ctx, row, { mode: 'manual', acknowledgedFlags: acks });
  if (row.specimenId) await ctx.store.rollupSpecimen(ctx.tx, ctx.tenantId, row.specimenId);
  return out;
}

export async function bulkVerifyResults(rawCtx: unknown, input: { items: readonly VerifyItem[] }): Promise<{ results: EntryOutcome[] }> {
  const ctx = rawCtx as VerifyCtx;
  const ids = [...new Set(input.items.map((x) => x.resultId))].sort();   // 02-TRD §3.2: lock order = result id ascending
  const rows = new Map((await ctx.store.lockForVerify(ctx.tx, ctx.tenantId, ids)).map((r) => [r.resultId, r]));
  const done = new Set<string>();   // ids verified in this batch (a second item for the same id is a lost race)
  const specimens = new Set<string>();
  const results: EntryOutcome[] = [];
  for (const it of input.items) {
    let stored = false;   // once the store call started, a failure rolls the whole batch back
    try {
      const row = await visibleRow(ctx, rows.get(it.resultId));
      if (done.has(it.resultId) || it.version !== row.rowVersion) throw new LimsError('common.version_conflict');
      const acks = checkVerifiable(row, it.acknowledgedFlags);
      stored = true;
      const out = await applyVerify(ctx, row, { mode: 'manual', acknowledgedFlags: acks });
      done.add(it.resultId);
      if (row.specimenId) specimens.add(row.specimenId);
      results.push({ resultId: it.resultId, outcome: 'ok', result: out });
    } catch (err) {
      if (!(err instanceof LimsError) || stored) throw err;
      results.push({ resultId: it.resultId, outcome: 'error', code: err.code });   // never the value, never err.detail (S-19)
    }
  }
  for (const s of [...specimens].sort()) await ctx.store.rollupSpecimen(ctx.tx, ctx.tenantId, s);   // once per specimen, after every save
  return { results };
}

/** R5 verified -> resulted (no event, 03-IC §10.2); only a verified row can be returned. */
export async function returnResult(rawCtx: unknown, i: ReturnInput): Promise<ResultRow> {
  const ctx = rawCtx as VerifyCtx;
  const { tx, tenantId, store } = ctx;
  const row = await visibleRow(ctx, (await store.lockForVerify(tx, tenantId, [i.resultId]))[0]);
  if (i.version !== row.rowVersion) throw new LimsError('common.version_conflict');
  if (row.status !== 'verified') throw new LimsError('lab.result_invalid_transition');   // resulted>resulted is R3, not a return
  if (!(await store.returnReasonActive(tx, tenantId, i.reasonCode))) {
    throw new LimsError('common.validation_failed', undefined, [{ path: '/reason_code', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  const out = await store.applyReturn(tx, tenantId, {
    resultId: row.resultId, expectedRowVersion: row.rowVersion, reasonCode: i.reasonCode, ...(i.comment === undefined ? {} : { comment: i.comment }),
    ...(ctx.actor.membershipId === undefined ? {} : { membershipId: ctx.actor.membershipId }), occurredAt: ctx.now().toISOString(),
  });
  if (row.specimenId) await store.rollupSpecimen(tx, tenantId, row.specimenId);   // S15: the specimen drops back
  return out;
}

/** Called by the T-22 ingest pipeline after each instrument-origin save. Behind LIMS_LAB_AUTOVERIFY_HOOK_ENABLED (false in Phase 1). A port failure fails closed: the result stays resulted. */
export async function autoVerifyAfterInstrumentSave(rawCtx: unknown, i: { resultId: string }): Promise<{ verified: boolean; result?: ResultRow }> {
  const ctx = rawCtx as VerifyCtx;
  const no = { verified: false };
  if (!ctx.config.autoverifyHookEnabled) return no;   // AC-15.5: flag false -> the port is never called
  // CR-C9-004: the tenant autoVerificationEnabled switch is NOT read here; C9 answers deny/feature_disabled.
  const row = (await ctx.store.lockForVerify(ctx.tx, ctx.tenantId, [i.resultId]))[0];
  if (!row || row.origin !== 'instrument' || row.status !== 'resulted' || row.onHold || row.unitMismatch) return no;
  if (row.rangeUnavailableAgeUnknown || !ctx.ports.QualityPort) return no;   // 08 A17.1: never offered, never auto-verified
  let decision;
  try {
    decision = await ctx.ports.QualityPort.canAutoVerify(ctx, {
      resultId: row.resultId, analyteId: row.analyteId, ...(row.instrumentId === undefined ? {} : { instrumentId: row.instrumentId }),
      ...(row.valueNumeric === undefined ? {} : { valueNumeric: row.valueNumeric }), instrumentFlags: row.instrumentFlags,
      ...(row.flag === undefined ? {} : { rangeFlag: row.flag }), deltaCheckFailed: row.deltaStatus === 'fail', isCritical: row.isCritical, resultedAt: row.resultedAt.toISOString(),
    });
  } catch { return no; }
  if (decision.decision !== 'allow') return no;
  const result = await applyVerify(ctx, row, { mode: 'auto', acknowledgedFlags: [], ...(decision.ruleSetVersion === undefined ? {} : { ruleSetVersion: decision.ruleSetVersion }) });
  if (row.specimenId) await ctx.store.rollupSpecimen(ctx.tx, ctx.tenantId, row.specimenId);
  return { verified: true, result };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-17 approve / bulk approve / amend / versions (02-TRD §3.3 R6/R7, §4.3, §4.7, §5.4 #30-#33, §5.5; 03-IC §3.10-§3.12, §10.2; 07-SECURITY S-01..S-04, S-19, P-01/P-02; 08 A13 P-1).
// Same rules as T-14/T-16: caller's tx, tenant from ctx only, per-row LimsError -> error row (code only, S-19), P-01/P-02 -> common.not_found.
// Check order approve: not found / no role -> version -> transition table -> on hold -> self-approval (domain, S-02) -> critical acknowledgement (AC-13.5).
// Check order amend: not found -> role lab.result.amend (forbidden -> lab.amend_requires_pathologist, AC-17.2; auth.mfa_required untouched) -> version -> approved -> reason -> value.
// After every write of an order the readiness is evaluated once per order (order.service evaluateOrderReadiness): after the specimen roll-ups (02-TRD §3.2 lock order).
// ---------------------------------------------------------------------------------------------------------------------------------------------
export interface ApproveRow {
  resultId: string; rowVersion: number; status: ResultStatus; onHold: boolean; origin: 'manual' | 'instrument' | 'calculated' | 'module';
  orderId: string; orderItemId: string; specimenId?: string | undefined; testId: string; analyteId: string; departmentId: string; centreId: string;
  currentVersionNo: number; verifiedByMembershipId?: string | undefined;
}
export interface ApproveStore {
  /** ids unique + ascending (02-TRD §3.2); returns the rows visible to the caller only. */
  lockForApprove(tx: unknown, tenantId: string, ids: readonly string[]): Promise<ApproveRow[]>;
  /** R6 UPDATE ... WHERE version = expectedRowVersion (throws common.version_conflict on a lost race) + lab.approvals row (kind approval, aal2) + immutable result_versions v1 copy. */
  approve(tx: unknown, tenantId: string, a: { resultId: string; expectedRowVersion: number; membershipId: string; occurredAt: string }): Promise<ResultRow>;
  /** An open critical event of the result without a notification outcome reached + read_back_confirmed (AC-13.5). */
  hasUnconfirmedCritical(tx: unknown, tenantId: string, resultId: string): Promise<boolean>;
  getLabSettings(tx: unknown, tenantId: string): Promise<{ criticalNotificationBlocksApproval: boolean }>;
  closeOpenCriticalEvents(tx: unknown, tenantId: string, a: { resultId: string; closedAt: string }): Promise<string[]>;
  rollupSpecimen(tx: unknown, tenantId: string, specimenId: string): Promise<void>;
}
export interface AmendRow extends EntryRow { currentValue: EntryValue }
export interface AmendInput {
  resultId: string; version: number; value?: EntryValue; commentCodes?: readonly string[]; commentText?: string; reasonCode?: string | undefined; reasonText?: string;
}
export interface AmendStore extends ResultStore, Pick<EntryStore, 'deltaInputs' | 'listCriticalLog' | 'insertCriticalLog' | 'markCriticalValueChanged' | 'getResults' | 'rollupSpecimen'> {
  lockForAmend(tx: unknown, tenantId: string, ids: readonly string[]): Promise<AmendRow[]>;
  amendReasonActive(tx: unknown, tenantId: string, code: string): Promise<boolean>;
  /** INSERT lab.result_versions v(n+1) (approved at creation, evaluation bound at INSERT only, R7), previous version superseded, results.current_version_no := n+1,
   *  lab.approvals row kind 'amendment'; the locked results row's value columns are never written. Returns the result as read through lab.v_result_current. */
  amendResult(tx: unknown, tenantId: string, a: {
    resultId: string; expectedRowVersion: number; previousVersionNo: number; newVersionNo: number; value: EntryValue; evaluation: Evaluation; commentCodes?: readonly string[];
    commentText?: string; reasonCode: string; reasonText?: string; membershipId: string; occurredAt: string;
  }): Promise<ResultRow>;
  /** { centreId, versions in version_no ascending } or undefined when unknown / invisible. */
  listResultVersions(tx: unknown, tenantId: string, resultId: string): Promise<{ centreId: string; versions: ResultRow[] } | undefined>;
}
type Role = { permission: string; centreId: string };
interface ApprovalCtx extends Omit<RecomputeCtx, 'store'> {
  readonly store: ApproveStore & AmendStore & ReadinessStore;
  readonly ports: EvalCtx['ports'] & { readonly IdentityPort: { assertRole(ctx: unknown, r: Role): Promise<void> } };
}

/** P-01 / P-02: unknown, foreign or role-less centre is the same 404; any other role-check failure (auth.mfa_required, infrastructure) propagates unchanged. */
async function assertAtCentre(ctx: ApprovalCtx, permission: string, centreId: string): Promise<void> {
  try { await ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId }); }
  catch (err) { throw err instanceof LimsError && err.code === 'auth.forbidden' ? new LimsError('common.not_found') : err; }
}
async function visibleAt<T extends { centreId: string }>(ctx: ApprovalCtx, permission: string, row: T | undefined): Promise<T> {
  if (!row) throw new LimsError('common.not_found');
  await assertAtCentre(ctx, permission, row.centreId);
  return row;
}

/** Table -> hold -> self-approval (domain: fail closed when the verifier or the approver is unknown) -> AC-13.5 critical acknowledgement. */
async function checkApprovable(ctx: ApprovalCtx, row: ApproveRow): Promise<void> {
  if (row.status === 'approved') throw new LimsError('lab.result_invalid_transition');   // approved>approved is R7 (amend), never an approval
  resultTransition(row.status, 'approved', {
    onHold: row.onHold,
    ...(row.verifiedByMembershipId === undefined ? {} : { verifiedBy: row.verifiedByMembershipId }),
    ...(ctx.actor.membershipId === undefined ? {} : { approvedBy: ctx.actor.membershipId }),
  });
  const { tx, tenantId, store } = ctx;
  if ((await store.getLabSettings(tx, tenantId)).criticalNotificationBlocksApproval && (await store.hasUnconfirmedCritical(tx, tenantId, row.resultId))) {
    throw new LimsError('lab.critical_ack_required');   // no value, no notification detail in the problem (S-19)
  }
}

/** R6 for an already checked row; the approval call carries no value column (S-03). Any failure after the store call propagates (caller rolls back). */
async function applyApprove(ctx: ApprovalCtx, row: ApproveRow): Promise<ResultRow> {
  const { tx, tenantId, store } = ctx;
  const occurredAt = ctx.now().toISOString();   // server clock
  const membershipId = ctx.actor.membershipId as string;   // checkApprovable fails closed without it
  const out = await store.approve(tx, tenantId, { resultId: row.resultId, expectedRowVersion: row.rowVersion, membershipId, occurredAt });
  await store.closeOpenCriticalEvents(tx, tenantId, { resultId: row.resultId, closedAt: occurredAt });   // 02-TRD §5.5: R6 closes the events
  // 03-IC §3.10: no value, no verifier; result_version_no is always 1 (the schema pins it).
  await createLabEvents(ctx.events as never).resultApproved(ctx as never, {
    result_id: row.resultId, result_version_no: 1, order_id: row.orderId, order_item_id: row.orderItemId, test_id: row.testId, analyte_id: row.analyteId,
    department_id: row.departmentId, approved_at: occurredAt, approved_by_membership_id: membershipId,
  }, { resultRowVersion: Number(out['version']) });
  return out;
}

/** Roll-up once per distinct specimen (ascending), then readiness once per distinct order (ascending), after every write. */
async function finishApprovals(ctx: ApprovalCtx, specimens: ReadonlySet<string>, orders: ReadonlySet<string>): Promise<void> {
  for (const s of [...specimens].sort()) await ctx.store.rollupSpecimen(ctx.tx, ctx.tenantId, s);
  for (const o of [...orders].sort()) await evaluateOrderReadiness(ctx, o);
}

export async function approveResult(rawCtx: unknown, i: { resultId: string; version: number }): Promise<ResultRow> {
  const ctx = rawCtx as ApprovalCtx;
  const row = await visibleAt(ctx, 'lab.result.approve', (await ctx.store.lockForApprove(ctx.tx, ctx.tenantId, [i.resultId]))[0]);
  if (i.version !== row.rowVersion) throw new LimsError('common.version_conflict');   // never trust the client number for the write
  await checkApprovable(ctx, row);
  const out = await applyApprove(ctx, row);
  await finishApprovals(ctx, new Set(row.specimenId ? [row.specimenId] : []), new Set([row.orderId]));
  return out;
}

export async function bulkApproveResults(rawCtx: unknown, input: { items: readonly { resultId: string; version: number }[] }): Promise<{ results: EntryOutcome[] }> {
  const ctx = rawCtx as ApprovalCtx;
  const ids = [...new Set(input.items.map((x) => x.resultId))].sort();   // 02-TRD §3.2: lock order = result id ascending
  const rows = new Map((await ctx.store.lockForApprove(ctx.tx, ctx.tenantId, ids)).map((r) => [r.resultId, r]));
  const done = new Set<string>();   // ids approved in this batch (a second item for the same id is a lost race)
  const specimens = new Set<string>(), orders = new Set<string>();
  const results: EntryOutcome[] = [];
  for (const it of input.items) {
    let stored = false;   // once the store call started, a failure rolls the whole batch back
    try {
      const row = await visibleAt(ctx, 'lab.result.approve', rows.get(it.resultId));
      if (done.has(it.resultId) || it.version !== row.rowVersion) throw new LimsError('common.version_conflict');
      await checkApprovable(ctx, row);
      stored = true;
      const out = await applyApprove(ctx, row);
      done.add(it.resultId);
      if (row.specimenId) specimens.add(row.specimenId);
      orders.add(row.orderId);
      results.push({ resultId: it.resultId, outcome: 'ok', result: out });
    } catch (err) {
      if (!(err instanceof LimsError) || stored) throw err;
      results.push({ resultId: it.resultId, outcome: 'error', code: err.code });   // never the value, never err.detail (S-19)
    }
  }
  await finishApprovals(ctx, specimens, orders);
  return { results };
}

const valueOf = (v: EntryValue): { field: 'numeric' | 'text' | 'ordinal'; text: string } | undefined =>
  v.numeric !== undefined ? { field: 'numeric', text: v.numeric } : v.text !== undefined ? { field: 'text', text: v.text } : v.ordinalCode !== undefined ? { field: 'ordinal', text: v.ordinalCode } : undefined;

/** R7 approved -> approved with a NEW result_versions row (02-TRD §4.3 finding C5 #10). Evaluates the new value, cascades to formulas in the same transaction (AC-09.5). */
export async function amendResult(rawCtx: unknown, i: AmendInput): Promise<ResultRow> {
  const ctx = rawCtx as ApprovalCtx;
  const { tx, tenantId, store } = ctx;
  const row = (await store.lockForAmend(tx, tenantId, [i.resultId]))[0];
  if (!row) throw new LimsError('common.not_found');   // P-01
  // auth.forbidden propagates: the handlers/index.ts gate maps a missing role to lab.amend_requires_pathologist (AC-17.2 / S-04) BEFORE this runs, so a refusal here is the
  // centre scope (P-02: foreign centre = common.not_found, mapped in the gate wrapper); auth.mfa_required passes through.
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'lab.result.amend', centreId: row.centreId });
  const membershipId = ctx.actor.membershipId;
  if (!membershipId) throw new LimsError('lab.amend_requires_pathologist');
  if (i.version !== row.rowVersion) throw new LimsError('common.version_conflict');
  if (row.status !== 'approved') throw new LimsError('lab.result_invalid_transition');   // a value change before approval is R3, not an amendment
  const reasonCode = i.reasonCode?.trim();
  if (!reasonCode) throw new LimsError('lab.amendment_reason_required');                  // AC-17.3
  if (!(await store.amendReasonActive(tx, tenantId, reasonCode))) {
    // [CONV] the path is also in `detail` (fixed text, never a submitted value): the T-17 tests read e.detail, the LimsError has no fieldErrors property.
    throw new LimsError('common.validation_failed', 'Invalid field /amendment_reason_code', [{ path: '/amendment_reason_code', code: 'common.field_invalid', message: 'Field invalid' }]);
  }

  assertManualValueAllowed(row);   // AC-09.7
  const given = [i.value?.numeric, i.value?.text, i.value?.ordinalCode].filter((v) => v !== undefined).length;
  const hasComment = i.commentText !== undefined || (i.commentCodes?.length ?? 0) > 0;
  if (given > 1 || (given === 0 && !hasComment)) throw invalidValue();
  // [CONV] spec silent: a comment-only amendment keeps the current value (and re-evaluates it); the same value without a comment is not an amendment.
  const value: EntryValue = given === 1 ? (i.value as EntryValue) : row.currentValue;
  const v = valueOf(value);
  const want = KIND_FIELD[row.analyte.resultType];
  if (!v || want === undefined || want !== v.field) throw invalidValue();
  const cur = valueOf(row.currentValue);
  if (given === 1 && !hasComment && cur?.field === v.field && (v.field === 'numeric' ? Number(cur.text) === Number(v.text) : cur.text === v.text)) throw invalidValue();

  const delta = await store.deltaInputs(tx, tenantId, row);
  const evaluation = await evaluateValue(ctx as unknown as EvalCtx, {
    analyte: { id: row.analyte.id, resultType: row.analyte.resultType, ...(row.analyte.decimals === undefined ? {} : { decimals: row.analyte.decimals }), ...(row.analyte.ordinalSetValues === undefined ? {} : { ordinalSetValues: row.analyte.ordinalSetValues }) },
    value: v.text, sex: row.sex, patientAgeDays: row.patientAgeDays,
    ...(row.specimenTypeCode === undefined ? {} : { specimenTypeCode: row.specimenTypeCode }),
    ...(row.collectedAt === undefined ? {} : { collectedAt: row.collectedAt }),
    ...(row.unitCode === undefined ? {} : { unitCode: row.unitCode }),
    ...(delta.rule === undefined ? {} : { deltaRule: delta.rule }), deltaCandidates: delta.candidates,
  });

  const occurredAt = ctx.now().toISOString();   // server clock
  const previousVersionNo = row.currentVersionNo, newVersionNo = previousVersionNo + 1;
  const out = await store.amendResult(tx, tenantId, {
    resultId: row.resultId, expectedRowVersion: row.rowVersion, previousVersionNo, newVersionNo, value, evaluation,
    ...(i.commentCodes === undefined ? {} : { commentCodes: i.commentCodes }), ...(i.commentText === undefined ? {} : { commentText: i.commentText }),
    reasonCode, ...(i.reasonText === undefined ? {} : { reasonText: i.reasonText }), membershipId, occurredAt,
  });
  const labEvents = createLabEvents(ctx.events as never);
  // 03-IC §3.11: no value and no reason text in the payload (P3).
  await labEvents.resultAmended(ctx as never, {
    result_id: row.resultId, previous_version_no: previousVersionNo, new_version_no: newVersionNo, order_id: row.orderId, order_item_id: row.orderItemId,
    test_id: row.testId, analyte_id: row.analyteId, amendment_reason_code: reasonCode, amended_at: occurredAt, amended_by_membership_id: membershipId,
  }, { resultRowVersion: Number(out['version']) });

  // 02-TRD §5.5: a critical amended value is a NEW critical event for the new version (the older events are not matched by hash); a non-critical one only marks open events.
  const act = criticalAction({ isCritical: evaluation.critical.isCritical, valueSha256Prefix16: evaluation.valueSha256Prefix16, existing: evaluation.critical.isCritical ? [] : await store.listCriticalLog(tx, tenantId, row.resultId) });
  if (act.markValueChangedAfterDetection) await store.markCriticalValueChanged(tx, tenantId, row.resultId);
  if (act.insertLogAndEmit && evaluation.critical.direction) {
    const { criticalEventId } = await store.insertCriticalLog(tx, tenantId, {
      resultId: row.resultId, resultVersionNo: newVersionNo, orderId: row.orderId, patientId: row.patientId, analyteId: row.analyteId, centreId: row.centreId,
      direction: evaluation.critical.direction, valueSha256Prefix16: evaluation.valueSha256Prefix16, value,
      ...(evaluation.critical.criticalLimitId === undefined ? {} : { criticalLimitId: evaluation.critical.criticalLimitId }),
      ...(evaluation.critical.version === undefined ? {} : { criticalLimitVersion: evaluation.critical.version }), detectedAt: occurredAt,
    });
    await labEvents.criticalValueDetected(ctx as never, {
      critical_event_id: criticalEventId, result_id: row.resultId, result_version_no: newVersionNo, order_id: row.orderId, patient_id: row.patientId,
      centre_id: row.centreId, analyte_id: row.analyteId, direction: evaluation.critical.direction, detected_at: occurredAt,
    }, { value: { kind: v.field === 'numeric' ? 'n' : v.field === 'text' ? 't' : 'o', value: v.text }, resultRowVersion: Number(out['version']) });
  }

  // AC-09.5: approved formula dependents get their own new version (same reason, same transaction); others are recomputed and returned to resulted (R5).
  const dependents = await recomputeDependents(ctx as unknown as RecomputeCtx, {
    orderItemId: row.orderItemId, changedAnalyteCode: row.analyte.code, trigger: 'amend', amendmentReason: { reasonCode, ...(i.reasonText === undefined ? {} : { reasonText: i.reasonText }) },
  });
  // An amendment never rolls the specimen of the amended result down; only a dependent returned to resulted (R5) can change the roll-up.
  const returned = dependents.length ? await store.getResults(tx, tenantId, dependents.map((d) => d.resultId)) : [];
  await finishApprovals(ctx, new Set(returned.filter((r) => r['status'] !== 'approved' && typeof r['specimen_id'] === 'string').map((r) => r['specimen_id'] as string)), new Set([row.orderId]));
  return out;
}

/** #33: version history of one result, version_no ascending; lab.result.read at the result's centre (P-01 / P-02 -> common.not_found). */
export async function listResultVersions(rawCtx: unknown, i: { resultId: string }): Promise<ResultRow[]> {
  const ctx = rawCtx as ApprovalCtx;
  const r = await ctx.store.listResultVersions(ctx.tx, ctx.tenantId, i.resultId);
  if (!r) throw new LimsError('common.not_found');
  await assertAtCentre(ctx, 'lab.result.read', r.centreId);
  return r.versions;
}
