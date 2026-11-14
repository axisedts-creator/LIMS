// C5 T-13 — dependency recompute in result.service (02-TRD §4.3 step 6, §4.4; 08 R3/R5/R7, R12a). In-memory fake store, no database.
// ACs: AC-09.1/09.2/09.3 (outcomes written to dependents), AC-09.4 (recompute in the SAME tx; verified -> resulted by system, reason input_changed),
//      AC-09.5 (approved dependent gets a NEW version with the same amendment reason + lab.result.amended.v1), AC-09.6, AC-09.7 (422 lab.result_value_invalid).
// Security (07-SECURITY): tenant only from ctx; thrown problems never echo values.
// Interface expected from the writer (../result.service.ts) — SEAM (names not in the spec; shapes follow 02-TRD §4.4):
//   export async function recomputeDependents(ctx: RecomputeCtx, i: { orderItemId: string; changedAnalyteCode: string;
//        trigger: 'enter' | 'amend'; amendmentReason?: { reasonCode: string; reasonText?: string } }): Promise<{ resultId: string; analyteCode: string; outcome: CalcOutcome }[]>
//     RecomputeCtx = { tenantId; actor:{type?:string; id:string; membershipId?:string}; now(): Date; tx: object; store: ResultStore; events: { publish(...) } }
//       events.publish takes the core PublishInput (services/api/src/core/events/publish.ts); the fake accepts publish(type, input) or publish(ctx, type, input) (string arg = type, last arg = input).
//     ResultStore (production impl wraps lab repositories on ctx.tx; EVERY call receives (tx, tenantId, ...) — tenant comes from ctx only):
//       listCalculatedTargets(tx, tenantId, orderItemId): { resultId; analyteCode; expression; status; versionNo; rowVersion; decimals; testRevision; catalogRevision; sex; ageDays?; ageYears?; orderId; testId; analyteId }[]
//       listInputs(tx, tenantId, orderItemId): CalcInput[]   (current value of every result of the order item, incl. already-calculated ones; see formulaInputs.test.ts)
//       inputUnitByCode(tx, tenantId, orderItemId): Record<string,string>      (catalog unitCode of each input analyte)
//       applyComputed(tx, tenantId, { resultId; expectedRowVersion; outcome: CalcOutcome; origin: 'calculated'; transition?: { to: 'resulted'; rule: 'R5'; actorType: 'system'; reasonCode: 'input_changed' } }): Promise<void>
//       amendCalculated(tx, tenantId, { resultId; newVersionNo; outcome: CalcOutcome; origin: 'calculated'; reasonCode: string; reasonText?: string }): Promise<void>   (R7: new approved version, outputs only in result_versions)
//     Behaviour: targets = calculated results of the order item whose expression references changedAnalyteCode (transitively); evaluated in topological order, each using the freshly computed values of earlier targets;
//       a target in a cycle -> not_computable 'formula_cycle'; an unparseable expression -> not_computable 'formula_unparseable'; never throws for a bad formula.
//       trigger 'enter': status verified -> applyComputed with transition R5/input_changed; resulted/pending -> applyComputed without transition. approved -> never applyComputed (row is locked).
//       trigger 'amend': an approved target -> amendCalculated (newVersionNo = versionNo + 1, same reason as the input amendment) + events.publish('lab.result.amended.v1', { aggregate: { type:'result', id: resultId, seq: newVersionNo }, idempotencyKey: `${resultId}:amended:${newVersionNo}`, payload: 03-IC §3.11 }) (review C5.T-13 item 1).
//       Formula ctx passed to the shared lib = { sex, ageDays, ageYears } (review item 2).
//                        a non-approved target -> as 'enter'.
//   export function assertManualValueAllowed(i: { analyte: { formula?: { expression: string } | null } }): void   — AC-09.7: calculated analyte -> throws LimsError('lab.result_value_invalid') (422).
import { describe, expect, it } from 'vitest';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { assertManualValueAllowed, recomputeDependents } from '../result.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const ITEM = '01a1a98a-ac40-7000-8000-0000000b0001';
const NOW = new Date('2026-06-15T05:00:00Z');
const FRIEDEWALD = 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)';

interface Target { resultId: string; analyteCode: string; expression: string; status: string; versionNo: number; rowVersion: number; decimals: number; testRevision: number; catalogRevision: number; sex: string; ageDays?: number; ageYears?: number; orderId: string; testId: string; analyteId: string }
const target = (over: Partial<Target> = {}): Target => ({ resultId: 'r-LDL', analyteCode: 'LDL', expression: FRIEDEWALD, status: 'pending', versionNo: 1, rowVersion: 4, decimals: 0, testRevision: 3, catalogRevision: 17, sex: 'female', ageDays: 10950, ageYears: 30, orderId: 'o-1', testId: 't-lipid', analyteId: 'a-LDL', ...over });
const input = (analyteCode: string, value: string | undefined, over: Record<string, unknown> = {}) => ({ analyteCode, resultId: `r-${analyteCode}`, versionNo: 1, status: 'resulted', resultType: 'numeric', value, unitCode: 'mg/dL', ...over });
const lipids = (tg = '150', over: Record<string, Record<string, unknown>> = {}) => [input('TC', '200', over['TC']), input('HDL', '50', over['HDL']), input('TG', tg, over['TG'])];

function make(targets: Target[], inputs: any[], units: Record<string, string> = { TC: 'mg/dL', HDL: 'mg/dL', TG: 'mg/dL' }) {
  const tx = { id: 'tx-1' };
  const log: { fn: string; tx: unknown; tenantId: unknown; arg: any }[] = [];
  const emitted: { type: string; input: any }[] = [];
  const store = {
    async listCalculatedTargets(t: unknown, tenantId: unknown, orderItemId: string) { log.push({ fn: 'listCalculatedTargets', tx: t, tenantId, arg: orderItemId }); return targets; },
    async listInputs(t: unknown, tenantId: unknown, orderItemId: string) { log.push({ fn: 'listInputs', tx: t, tenantId, arg: orderItemId }); return inputs; },
    async inputUnitByCode(t: unknown, tenantId: unknown, orderItemId: string) { log.push({ fn: 'inputUnitByCode', tx: t, tenantId, arg: orderItemId }); return units; },
    async applyComputed(t: unknown, tenantId: unknown, arg: any) { log.push({ fn: 'applyComputed', tx: t, tenantId, arg }); },
    async amendCalculated(t: unknown, tenantId: unknown, arg: any) { log.push({ fn: 'amendCalculated', tx: t, tenantId, arg }); },
  };
  const ctx = { tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, now: () => NOW, tx, store, events: { async publish(...a: unknown[]) { emitted.push({ type: a.find((x) => typeof x === 'string') as string, input: a[a.length - 1] }); } } };
  return { ctx: ctx as any, tx, log, emitted, writes: () => log.filter((l) => l.fn === 'applyComputed' || l.fn === 'amendCalculated') };
}
const run = (m: ReturnType<typeof make>, over: Record<string, unknown> = {}) =>
  recomputeDependents(m.ctx, { orderItemId: ITEM, changedAnalyteCode: 'TG', trigger: 'enter', ...over } as any);

describe('T-13 recomputeDependents — AC-09.1 / 09.2 / 09.3 outcomes', () => {
  it('last input saved -> LDL computed 120, origin calculated, provenance carries inputs + revisions', async () => {
    const m = make([target()], lipids());
    const out: any = await run(m);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ resultId: 'r-LDL', analyteCode: 'LDL' });
    const w = m.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.fn).toBe('applyComputed');
    expect(w[0]!.arg).toMatchObject({ resultId: 'r-LDL', expectedRowVersion: 4, origin: 'calculated' });
    expect(w[0]!.arg.outcome.calcStatus).toBe('computed');
    expect(Number(w[0]!.arg.outcome.value)).toBe(120);
    expect(w[0]!.arg.outcome.provenance).toMatchObject({ expression: FRIEDEWALD, test_revision: 3, catalog_revision: 17 });
    expect(w[0]!.arg.outcome.provenance.inputs.map((x: any) => [x.analyte_code, x.result_id, x.version_no, x.value])).toEqual([['TC', 'r-TC', 1, '200'], ['HDL', 'r-HDL', 1, '50'], ['TG', 'r-TG', 1, '150']]);
    expect(w[0]!.arg.transition).toBeUndefined();
  });
  it('TG 450 -> not_computable tg_over_400 written; result is not given a value', async () => {
    const m = make([target()], lipids('450'));
    await run(m);
    const o = m.writes()[0]!.arg.outcome;
    expect(o).toMatchObject({ calcStatus: 'not_computable', reason: 'tg_over_400' });
    expect(o.value).toBeUndefined();
  });
  it('HDL missing -> waiting_for_inputs [HDL]; missing is never 0', async () => {
    const m = make([target()], [input('TC', '200'), input('TG', '150')]);
    await run(m);
    const o = m.writes()[0]!.arg.outcome;
    expect(o).toMatchObject({ calcStatus: 'waiting_for_inputs', waitingFor: ['HDL'] });
    expect(o.value).toBeUndefined();
  });
  it('AC-09.6 stored unit differs from catalog unit -> not_computable unit_mismatch', async () => {
    const m = make([target()], lipids('150', { TC: { unitCode: 'mmol/L' } }));
    await run(m);
    expect(m.writes()[0]!.arg.outcome).toMatchObject({ calcStatus: 'not_computable', reason: 'unit_mismatch' });
  });
  it('a calculated result that does not reference the changed analyte is not touched', async () => {
    const m = make([target({ resultId: 'r-NLR', analyteCode: 'NLR', expression: 'NEUT_ABS / LYMPH_ABS' })], lipids());
    expect(await run(m)).toEqual([]);
    expect(m.writes()).toEqual([]);
  });
  it('formula ctx carries ageYears: @age_years formula with ageYears set -> computed (review item 2)', async () => {
    const m = make([target({ expression: 'TC + @age_years', ageYears: 30 })], lipids());
    await run(m, { changedAnalyteCode: 'TC' });
    const o = m.writes()[0]!.arg.outcome;
    expect(o.calcStatus).toBe('computed');
    expect(Number(o.value)).toBe(230);
  });
  it('a bad formula never throws out of recompute (formula_unparseable is stored)', async () => {
    const m = make([target({ expression: 'TC - ' })], lipids());
    await expect(run(m)).resolves.toBeDefined();
    expect(m.writes()[0]!.arg.outcome).toMatchObject({ calcStatus: 'not_computable', reason: 'formula_unparseable' });
  });
});

describe('T-13 recomputeDependents — AC-09.4 same transaction, verified -> resulted (R5)', () => {
  it('every store call receives the SAME ctx.tx and ctx.tenantId', async () => {
    const m = make([target({ status: 'verified' })], lipids());
    await run(m);
    expect(m.log.length).toBeGreaterThanOrEqual(2);
    for (const l of m.log) { expect(l.tx).toBe(m.tx); expect(l.tenantId).toBe(TENANT); }
  });
  it('verified dependent -> applyComputed with transition R5 / system / input_changed', async () => {
    const m = make([target({ status: 'verified' })], lipids('160'));
    await run(m);
    expect(m.writes()[0]!.arg.transition).toEqual({ to: 'resulted', rule: 'R5', actorType: 'system', reasonCode: 'input_changed' });
    expect(Number(m.writes()[0]!.arg.outcome.value)).toBe(118);
  });
  it('resulted / pending dependent -> recomputed without a transition', async () => {
    for (const status of ['resulted', 'pending']) {
      const m = make([target({ status })], lipids());
      await run(m);
      expect(m.writes()[0]!.arg.transition).toBeUndefined();
    }
  });
  it('approved dependent on trigger "enter" is never overwritten in place (row is locked)', async () => {
    const m = make([target({ status: 'approved' })], lipids());
    await run(m);
    expect(m.writes().filter((w) => w.fn === 'applyComputed')).toEqual([]);
  });
});

describe('T-13 recomputeDependents — AC-09.5 amended input -> new approved version of the calculated result', () => {
  const reason = { reasonCode: 'transcription_error', reasonText: 'wrong TC' };
  it('approved dependent -> amendCalculated v+1 with the same reason; event emitted for it', async () => {
    const m = make([target({ status: 'approved', versionNo: 2 })], lipids('150', { TC: { status: 'approved', versionNo: 2 } }));
    await run(m, { changedAnalyteCode: 'TC', trigger: 'amend', amendmentReason: reason });
    const w = m.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.fn).toBe('amendCalculated');
    expect(w[0]!.arg).toMatchObject({ resultId: 'r-LDL', newVersionNo: 3, origin: 'calculated', reasonCode: 'transcription_error', reasonText: 'wrong TC' });
    expect(Number(w[0]!.arg.outcome.value)).toBe(120);
    expect(w[0]!.arg.outcome.provenance.inputs.find((x: any) => x.analyte_code === 'TC')).toMatchObject({ version_no: 2 });
    expect(m.emitted).toEqual([{
      type: 'lab.result.amended.v1',
      input: {
        aggregate: { type: 'result', id: 'r-LDL', seq: 3 },
        idempotencyKey: 'r-LDL:amended:3',
        payload: {
          result_id: 'r-LDL', previous_version_no: 2, new_version_no: 3, order_id: 'o-1', order_item_id: ITEM, test_id: 't-lipid', analyte_id: 'a-LDL',
          amendment_reason_code: 'transcription_error', amended_at: NOW.toISOString(), amended_by_membership_id: MEMBERSHIP,
        },
      },
    }]);
    expect(JSON.stringify(m.emitted[0]!.input.payload)).not.toMatch(/wrong TC|"value"/); // P3: no value, no free-text reason
  });
  it('amend trigger with a not-approved dependent behaves like an edit (no new version, no amended event)', async () => {
    const m = make([target({ status: 'verified' })], lipids());
    await run(m, { changedAnalyteCode: 'TC', trigger: 'amend', amendmentReason: reason });
    expect(m.writes()[0]!.fn).toBe('applyComputed');
    expect(m.emitted).toEqual([]);
  });
  it('amend trigger without a reason is rejected for an approved dependent (R7 always has a reason)', async () => {
    const m = make([target({ status: 'approved' })], lipids());
    await expect(run(m, { changedAnalyteCode: 'TC', trigger: 'amend' })).rejects.toSatisfy((e: unknown) => e instanceof Error);
    expect(m.writes()).toEqual([]);
    expect(m.emitted).toEqual([]);
  });
});

describe('T-13 recomputeDependents — chains and cycles (02-TRD §4.4)', () => {
  it('chain: B = A * 2, C = B + 1; A changes -> B then C, C uses the fresh B (not the stale stored B)', async () => {
    const targets = [
      target({ resultId: 'r-C', analyteCode: 'C', expression: 'B + 1' }),
      target({ resultId: 'r-B', analyteCode: 'B', expression: 'A * 2' }),
    ];
    const m = make(targets, [input('A', '5', { unitCode: 'u' }), input('B', '999', { unitCode: 'u' })], { A: 'u', B: 'u' });
    await run(m, { changedAnalyteCode: 'A' });
    const w = m.writes();
    expect(w.map((x) => x.arg.resultId)).toEqual(['r-B', 'r-C']);
    expect(Number(w[0]!.arg.outcome.value)).toBe(10);
    expect(Number(w[1]!.arg.outcome.value)).toBe(11);
  });
  it('cycle: B = C + 1, C = B + 1 -> both not_computable formula_cycle (terminates)', async () => {
    const targets = [target({ resultId: 'r-B', analyteCode: 'B', expression: 'C + 1' }), target({ resultId: 'r-C', analyteCode: 'C', expression: 'B + 1' })];
    const m = make(targets, [input('B', '1', { unitCode: 'u' }), input('C', '1', { unitCode: 'u' })], { B: 'u', C: 'u' });
    await run(m, { changedAnalyteCode: 'B' });
    expect(m.writes().map((x) => x.arg.outcome)).toEqual([
      expect.objectContaining({ calcStatus: 'not_computable', reason: 'formula_cycle' }),
      expect.objectContaining({ calcStatus: 'not_computable', reason: 'formula_cycle' }),
    ]);
  });
});

describe('T-13 security / hostile', () => {
  it('a store failure propagates (caller rolls back the whole transaction — no partial recompute swallowed)', async () => {
    const m = make([target()], lipids());
    m.ctx.store.applyComputed = async () => { throw new Error('db down'); };
    await expect(run(m)).rejects.toThrow('db down');
  });
  it('outcomes never echo input values into thrown problems (reason is a code, not a value)', async () => {
    const m = make([target()], lipids('450'));
    const out: any = await run(m);
    expect(JSON.stringify(out[0].outcome.reason)).not.toMatch(/450|200|50/);
  });
  it('tenant is taken from ctx only: a tenant id smuggled in the input is ignored', async () => {
    const m = make([target()], lipids());
    await run(m, { tenantId: '01a1a98a-ac40-7000-8000-00000000b001' });
    for (const l of m.log) expect(l.tenantId).toBe(TENANT);
  });
});

describe('T-13 assertManualValueAllowed — AC-09.7', () => {
  it('calculated analyte (has formula) -> LimsError lab.result_value_invalid (422), no value in the problem', () => {
    try { assertManualValueAllowed({ analyte: { formula: { expression: FRIEDEWALD } } }); } catch (e) {
      expect(e).toBeInstanceOf(LimsError);
      expect(isLimsError(e, 'lab.result_value_invalid')).toBe(true);
      expect((e as LimsError).statusCode).toBe(422);
      return;
    }
    throw new Error('expected lab.result_value_invalid');
  });
  it('analyte without a formula (undefined / null) accepts manual entry', () => {
    expect(() => assertManualValueAllowed({ analyte: {} })).not.toThrow();
    expect(() => assertManualValueAllowed({ analyte: { formula: null } })).not.toThrow();
  });
});
