// C5 T-12 — value evaluation service (02-TRD §4.3 steps 1–5; 06 row T-12; 08 A17.1 / CR-C5-012; 08 A13 D-9). No database: fake CatalogPort + recording fake tx.
// ACs: AC-08.2 (range snapshot + flag), AC-08.6 (ordinal), AC-08.8 (age unknown), AC-12.1/12.2 (delta), AC-13.1/13.2/13.3 (critical decision, hash).
// Security: 07-SECURITY — tenant comes from ctx only; thrown problems never echo the value (REQ-SEC-095 style); R7 outputs only to lab.result_versions (the approved lab.results row is locked).
// Interface expected from the writer (../evaluation.service.ts) — SEAM (spec fixes behaviour, not the names):
//   EvalCtx = { tenantId: string; actor: { type?: string; id: string }; tx: { query(text, values?): Promise<{ rows: any[] }> }; now(): Date;
//               ports: { CatalogPort: { referenceRangeFor(ctx, q: RangeQuery): Promise<ReferenceRangeMatch>; criticalLimitsFor(ctx, q: RangeQuery): Promise<CriticalLimitsMatch | undefined> } } }
//   export async function evaluateValue(ctx: EvalCtx, i: {
//       analyte: { id: string; resultType: 'numeric' | 'ordinal' | 'coded' | 'text' | 'attachment' | 'narrative'; decimals?: number; ordinalSetValues?: {code,display,sortOrder}[] };
//       value: string; sex: Sex; patientAgeDays: number | null; birthOn?: string; specimenTypeCode?: string; collectedAt?: Date; unitCode?: string; manualAbnormal?: boolean;
//       deltaRule?: DeltaRule; deltaCandidates?: readonly DeltaCandidate[] }): Promise<Evaluation>
//   Evaluation = { flag?: Flag; rangeSnapshot?: { referenceRangeId; version; low?; high?; text?; unitCode? };
//                  critical: { isCritical: boolean; direction?: 'low'|'high'|'abnormal'; criticalLimitId?: string; version?: number };
//                  rangeUnavailableAgeUnknown: boolean; valueSha256Prefix16: string; delta: DeltaOutcome | { status: 'not_applicable' } }
//   Port query = { analyteId, sex, specimenTypeCode?, at: ISO of (collectedAt ?? ctx.now()), ageDays? (key ABSENT when patientAgeDays is null), birthOn? (key absent when not given or age unknown) }; both lookups get the same query.
//   Validation (step 1) throws LimsError('lab.result_value_invalid') BEFORE any port call. catalog.no_reference_range from referenceRangeFor = "no range" (never fails the save); any other port error propagates.
//   export function criticalAction(i: { isCritical: boolean; valueSha256Prefix16: string; existing: readonly { valueSha256Prefix16: string; status: 'open'|'notified'|'closed' }[] }):
//        { insertLogAndEmit: boolean; markValueChangedAfterDetection: boolean }      (02-TRD §4.3 step 4; AC-13.2 / AC-13.3)
//   export async function persistEvaluation(ctx: EvalCtx, i: { stage: 'R2' | 'R3' | 'R7'; resultId: string; versionNo: number; evaluation: Evaluation }): Promise<void>
//        R2/R3 -> one UPDATE on lab.results (tenant-scoped, $tenant from ctx); R7 -> rejects (result_versions is immutable; ruling per T-12 review).
//   export function evaluationColumns(e: Evaluation, stage: 'R2'|'R3'|'R7'): { cols: string[]; values: unknown[] }   (R7 outputs bound into the amendment INSERT; no ref_unit_code for R7)
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { criticalAction, evaluateValue, evaluationColumns, persistEvaluation } from '../evaluation.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const ANALYTE = '01a1a98a-ac40-7000-8000-0000000a0001';
const RESULT = '01a1a98a-ac40-7000-8000-0000000e0001';
const NOW = new Date('2026-06-15T05:00:00Z');
const COLLECTED = new Date('2026-06-15T03:30:00Z');
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const RANGE = { referenceRangeId: '01a1a98a-ac40-7000-8000-0000000c0001', version: 2, low: '3.5', high: '5.1', text: '3.5 - 5.1', unitCode: 'mmol/L' };
const CRIT = { criticalLimitId: '01a1a98a-ac40-7000-8000-0000000c0002', version: 4, low: '2.5', high: '6.5' };
const noRange = () => new LimsError('catalog.no_reference_range');

interface Opts { range?: unknown; crit?: unknown; rangeThrows?: () => unknown; critThrows?: () => unknown }
function makeCtx(o: Opts = {}) {
  const calls: { fn: 'range' | 'crit'; q: Record<string, unknown> }[] = [];
  const stmts: { text: string; values: unknown[] }[] = [];
  const ctx = {
    tenantId: TENANT, actor: { type: 'user', id: ACTOR }, now: () => NOW,
    tx: { async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: [] }; } },
    ports: {
      CatalogPort: {
        async referenceRangeFor(_c: unknown, q: Record<string, unknown>) { calls.push({ fn: 'range', q }); if (o.rangeThrows) throw o.rangeThrows(); return 'range' in o ? o.range : RANGE; },
        async criticalLimitsFor(_c: unknown, q: Record<string, unknown>) { calls.push({ fn: 'crit', q }); if (o.critThrows) throw o.critThrows(); return 'crit' in o ? o.crit : CRIT; },
      },
    },
  };
  return { ctx: ctx as any, calls, stmts };
}
const base = { analyte: { id: ANALYTE, resultType: 'numeric' as const, decimals: 1 }, sex: 'female' as const, patientAgeDays: 10950, specimenTypeCode: 'SERUM', collectedAt: COLLECTED };
const ev = (c: ReturnType<typeof makeCtx>, over: Record<string, unknown> = {}) => evaluateValue(c.ctx, { ...base, value: '4.0', ...over } as any);

describe('T-12 evaluateValue — AC-08.2 / AC-13.1 numeric path', () => {
  it('in range: flag N, snapshot id+version+low/high/text, not critical, hash of n:<value>', async () => {
    const c = makeCtx();
    const r = await ev(c);
    expect(r.flag).toBe('N');
    expect(r.rangeSnapshot).toMatchObject({ referenceRangeId: RANGE.referenceRangeId, version: 2, low: '3.5', high: '5.1', text: '3.5 - 5.1' });
    expect(r.critical.isCritical).toBe(false);
    expect(r.rangeUnavailableAgeUnknown).toBe(false);
    expect(r.valueSha256Prefix16).toBe(sha16('n:4.0'));
    expect(r.delta.status).toBe('no_rule');
  });
  it('AC-13.1: 7.0 vs critical high 6.5 -> HH, critical high, limit id+version', async () => {
    const r = await ev(makeCtx(), { value: '7.0' });
    expect(r.flag).toBe('HH');
    expect(r.critical).toMatchObject({ isCritical: true, direction: 'high', criticalLimitId: CRIT.criticalLimitId, version: 4 });
    expect(r.valueSha256Prefix16).toBe(sha16('n:7.0'));
  });
  it('equal-to-limit is not flagged: 5.1 -> N, 6.5 -> H (not critical)', async () => {
    expect((await ev(makeCtx(), { value: '5.1' })).flag).toBe('N');
    const r = await ev(makeCtx(), { value: '6.5' });
    expect(r.flag).toBe('H');
    expect(r.critical.isCritical).toBe(false);
  });
  it('low critical: 2.0 -> LL, direction low', async () => {
    const r = await ev(makeCtx(), { value: '2.0' });
    expect(r.flag).toBe('LL');
    expect(r.critical).toMatchObject({ isCritical: true, direction: 'low' });
  });
  it('both lookups get the same query: analyte, sex, specimen type, at = collected_at, ageDays; birthOn only when given', async () => {
    const c = makeCtx();
    await ev(c, { birthOn: '1996-06-15' });
    expect(c.calls.map((x) => x.fn).sort()).toEqual(['crit', 'range']);
    for (const { q } of c.calls) {
      expect(q).toMatchObject({ analyteId: ANALYTE, sex: 'female', specimenTypeCode: 'SERUM', at: COLLECTED.toISOString(), ageDays: 10950, birthOn: '1996-06-15' });
    }
    const c2 = makeCtx();
    await ev(c2, { collectedAt: undefined });
    for (const { q } of c2.calls) { expect(q.at).toBe(NOW.toISOString()); expect('birthOn' in q).toBe(false); }
  });
  it('no range from the catalog: no snapshot, no flag, never throws (AC: catalog.no_reference_range never fails the save)', async () => {
    const r = await ev(makeCtx({ rangeThrows: noRange, crit: undefined }));
    expect(r.rangeSnapshot).toBeUndefined();
    expect(r.flag).toBeUndefined();
    expect(r.rangeUnavailableAgeUnknown).toBe(false); // age is known
    expect(r.critical.isCritical).toBe(false);
  });
  it('no critical limits with a known age: range flag still applies, not marked unavailable', async () => {
    const r = await ev(makeCtx({ crit: undefined }), { value: '7.0' });
    expect(r.flag).toBe('H');
    expect(r.critical.isCritical).toBe(false);
    expect(r.rangeUnavailableAgeUnknown).toBe(false);
  });
  it('other port errors propagate (fail closed, no silent unflagged result)', async () => {
    await expect(ev(makeCtx({ critThrows: () => new LimsError('common.dependency_unavailable') }))).rejects.toSatisfy((e: unknown) => isLimsError(e, 'common.dependency_unavailable'));
    await expect(ev(makeCtx({ rangeThrows: () => new Error('boom') }))).rejects.toThrow('boom');
  });
});

describe('T-12 evaluateValue — AC-08.8 unknown age (08 A17.1)', () => {
  const unknown = { patientAgeDays: null, birthOn: '1996-06-15' }; // even a stray birthOn must not be sent when age is unknown
  it('ports are called WITHOUT ageDays and birthOn (keys absent, not undefined-valued)', async () => {
    const c = makeCtx();
    await ev(c, unknown);
    expect(c.calls).toHaveLength(2);
    for (const { q } of c.calls) { expect('ageDays' in q).toBe(false); expect('birthOn' in q).toBe(false); expect(q.analyteId).toBe(ANALYTE); }
  });
  it('age-unrestricted range and critical found -> normal flag and critical check, not marked', async () => {
    const r = await ev(makeCtx(), { ...unknown, value: '7.0' });
    expect(r.flag).toBe('HH');
    expect(r.critical).toMatchObject({ isCritical: true, direction: 'high' });
    expect(r.rangeUnavailableAgeUnknown).toBe(false);
  });
  it('range missing (catalog.no_reference_range) while age unknown -> range_unavailable_age_unknown = true', async () => {
    const r = await ev(makeCtx({ rangeThrows: noRange }), unknown);
    expect(r.rangeUnavailableAgeUnknown).toBe(true);
    expect(r.rangeSnapshot).toBeUndefined();
    expect(r.flag).toBeUndefined();
  });
  it('critical limits missing (undefined) while age unknown -> true, even though the range matched (fail safe)', async () => {
    const r = await ev(makeCtx({ crit: undefined }), unknown);
    expect(r.rangeUnavailableAgeUnknown).toBe(true);
    expect(r.flag).toBe('N');
  });
  it('both missing -> true', async () => {
    expect((await ev(makeCtx({ rangeThrows: noRange, crit: undefined }), unknown)).rangeUnavailableAgeUnknown).toBe(true);
  });
  it('recomputed on every evaluation: known age is never marked, even if both are missing', async () => {
    expect((await ev(makeCtx({ rangeThrows: noRange, crit: undefined }))).rangeUnavailableAgeUnknown).toBe(false);
  });
  it('age 0 days is a known age (newborn), not unknown', async () => {
    const c = makeCtx();
    const r = await ev(c, { patientAgeDays: 0 });
    for (const { q } of c.calls) expect(q.ageDays).toBe(0);
    expect(r.rangeUnavailableAgeUnknown).toBe(false);
  });
});

describe('T-12 evaluateValue — step 1 validation (02-TRD §4.3 step 1; AC-08.3, AC-08.6)', () => {
  const invalid = async (over: Record<string, unknown>, c = makeCtx()) => {
    try { await ev(c, over); } catch (e) {
      expect(isLimsError(e, 'lab.result_value_invalid')).toBe(true);
      expect(c.calls).toHaveLength(0); // no port call for an invalid value
      return;
    }
    throw new Error(`expected lab.result_value_invalid for ${JSON.stringify(over)}`);
  };
  it.each(['abc', '', '1,5', '1e3', '--1', '.', '12.', ' 4.0', '4.0 ', 'NaN', 'Infinity', '0x10'])('numeric %j rejected', (value) => invalid({ value }));
  it('the problem never echoes the submitted value (clinical data stays out of error bodies)', async () => {
    for (const over of [{ value: 'SECRETVALUE42' }, { value: 'ZZZ-SECRET', analyte: { id: ANALYTE, resultType: 'ordinal', ordinalSetValues: [{ code: 'NEG', display: 'Negative', sortOrder: 1 }] } }]) {
      try { await ev(makeCtx(), over); throw new Error('expected rejection'); } catch (e) {
        expect(isLimsError(e, 'lab.result_value_invalid')).toBe(true);
        expect(JSON.stringify({ m: (e as Error).message, d: (e as LimsError).detail, f: (e as LimsError).errors })).not.toContain('SECRET');
      }
    }
  });
  it('numeric: more fraction digits than analyte decimals rejected; missing decimals -> at most 6', async () => {
    await invalid({ value: '13.45' });                                              // decimals 1
    await invalid({ value: '1.1234567', analyte: { id: ANALYTE, resultType: 'numeric' } });
    expect((await ev(makeCtx(), { value: '1.123456', analyte: { id: ANALYTE, resultType: 'numeric' } })).flag).toBeDefined();
    expect((await ev(makeCtx(), { value: '13.4' })).flag).toBeDefined();
  });
  it('narrative and attachment cannot be typed in; text over 2,000 chars rejected, 2,000 accepted', async () => {
    await invalid({ value: 'free text', analyte: { id: ANALYTE, resultType: 'narrative' } });
    await invalid({ value: 'blob', analyte: { id: ANALYTE, resultType: 'attachment' } });
    await invalid({ value: 'x'.repeat(2001), analyte: { id: ANALYTE, resultType: 'text' } });
    const ok = await ev(makeCtx({ rangeThrows: noRange, crit: undefined }), { value: 'x'.repeat(2000), analyte: { id: ANALYTE, resultType: 'text' } });
    expect(ok.valueSha256Prefix16).toBe(sha16(`t:${'x'.repeat(2000)}`));
  });
});

describe('T-12 evaluateValue — ordinal / coded (AC-08.6, 08 A13 D-9)', () => {
  const SET = [{ code: 'NEG', display: 'Negative', sortOrder: 1 }, { code: '1+', display: 'One plus', sortOrder: 2 }, { code: '2+', display: 'Two plus', sortOrder: 3 }];
  const analyte = { id: ANALYTE, resultType: 'ordinal' as const, ordinalSetValues: SET };
  const rng = { referenceRangeId: RANGE.referenceRangeId, version: 1, kind: 'ordinal', normalCodes: ['NEG'], text: 'Negative' };
  it('code outside normalCodes -> flag A; hash is o:<code>; ordinal never gets a numeric flag', async () => {
    const r = await ev(makeCtx({ range: rng, crit: undefined }), { value: '2+', analyte });
    expect(r.flag).toBe('A');
    expect(r.critical.isCritical).toBe(false); // A from normalCodes alone is not critical
    expect(r.valueSha256Prefix16).toBe(sha16('o:2+'));
  });
  it('code inside normalCodes -> no flag', async () => {
    expect((await ev(makeCtx({ range: rng, crit: undefined }), { value: 'NEG', analyte })).flag).toBeUndefined();
  });
  it('code in critical.abnormalCodes -> A and critical direction abnormal', async () => {
    const r = await ev(makeCtx({ range: rng, crit: { criticalLimitId: CRIT.criticalLimitId, version: 1, abnormalCodes: ['2+'] } }), { value: '2+', analyte });
    expect(r.flag).toBe('A');
    expect(r.critical).toMatchObject({ isCritical: true, direction: 'abnormal' });
  });
  it('a code that is not in ordinalSetValues is rejected before any port call (free text, wrong case, unlisted)', async () => {
    for (const value of ['3+', 'neg', 'positive']) {
      const c = makeCtx();
      await expect(ev(c, { value, analyte })).rejects.toSatisfy((e: unknown) => isLimsError(e, 'lab.result_value_invalid'));
      expect(c.calls).toHaveLength(0);
    }
  });
  it('coded behaves like ordinal; manual abnormal flag -> A', async () => {
    const r = await ev(makeCtx({ range: { ...rng, normalCodes: undefined }, crit: undefined }), { value: 'NEG', analyte: { ...analyte, resultType: 'coded' }, manualAbnormal: true });
    expect(r.flag).toBe('A');
  });
});

describe('T-12 evaluateValue — delta (AC-12.1 / AC-12.2)', () => {
  const rule = { ruleId: '01a1a98a-ac40-7000-8000-0000000d0001', ruleVersion: 3, windowSeconds: 7 * 86_400, absThreshold: '1.0' };
  const prev = { resultId: '01a1a98a-ac40-7000-8000-0000000f0001', value: '4.0', unitCode: 'mmol/L', approvedAt: new Date(COLLECTED.getTime() - 3 * 86_400_000) };
  it('AC-12.1: K+ 5.2 vs approved 4.0 three days earlier -> fail, abs 1.2; window anchored at collected_at', async () => {
    const r = await ev(makeCtx(), { value: '5.2', unitCode: 'mmol/L', deltaRule: rule, deltaCandidates: [prev] });
    expect(r.delta).toMatchObject({ status: 'fail', previousResultId: prev.resultId, previousValue: '4.0', ruleId: rule.ruleId, ruleVersion: 3 });
    expect(Number((r.delta as { abs?: string }).abs)).toBe(1.2);
  });
  it('AC-12.2: no candidate in the window -> no_previous', async () => {
    expect((await ev(makeCtx(), { value: '5.2', unitCode: 'mmol/L', deltaRule: rule, deltaCandidates: [] })).delta.status).toBe('no_previous');
  });
  it('non-numeric results get delta not_applicable', async () => {
    const SET = [{ code: 'NEG', display: 'Negative', sortOrder: 1 }];
    const r = await ev(makeCtx({ range: { referenceRangeId: RANGE.referenceRangeId, version: 1 }, crit: undefined }), { value: 'NEG', analyte: { id: ANALYTE, resultType: 'ordinal', ordinalSetValues: SET }, deltaRule: rule, deltaCandidates: [prev] });
    expect(r.delta.status).toBe('not_applicable');
  });
});

describe('T-12 criticalAction — AC-13.1 / AC-13.2 / AC-13.3 (02-TRD §4.3 step 4)', () => {
  const H = sha16('n:7.0'), H2 = sha16('n:8.0'), HN = sha16('n:4.0');
  it('AC-13.1: critical and no log row for the hash -> insert log + emit', () => {
    expect(criticalAction({ isCritical: true, valueSha256Prefix16: H, existing: [] })).toEqual({ insertLogAndEmit: true, markValueChangedAfterDetection: false });
  });
  it('AC-13.2: the same value re-saved -> nothing (idempotent), whatever the log status', () => {
    for (const status of ['open', 'notified', 'closed'] as const) {
      expect(criticalAction({ isCritical: true, valueSha256Prefix16: H, existing: [{ valueSha256Prefix16: H, status }] }).insertLogAndEmit).toBe(false);
    }
  });
  it('AC-13.2: a different critical value -> new log row and event', () => {
    expect(criticalAction({ isCritical: true, valueSha256Prefix16: H2, existing: [{ valueSha256Prefix16: H, status: 'open' }] }).insertLogAndEmit).toBe(true);
  });
  it('AC-13.3: critical corrected to a non-critical value -> keep the row, mark value_changed_after_detection, NO new row/event (no retraction)', () => {
    expect(criticalAction({ isCritical: false, valueSha256Prefix16: HN, existing: [{ valueSha256Prefix16: H, status: 'open' }] }))
      .toEqual({ insertLogAndEmit: false, markValueChangedAfterDetection: true });
  });
  it('non-critical and nothing logged -> nothing; a closed log row is not touched', () => {
    expect(criticalAction({ isCritical: false, valueSha256Prefix16: HN, existing: [] })).toEqual({ insertLogAndEmit: false, markValueChangedAfterDetection: false });
    expect(criticalAction({ isCritical: false, valueSha256Prefix16: HN, existing: [{ valueSha256Prefix16: H, status: 'closed' }] }).markValueChangedAfterDetection).toBe(false);
  });
});

describe('T-12 persistEvaluation / evaluationColumns — R2/R3 UPDATE lab.results; R7 outputs only via INSERT columns for lab.result_versions (02-TRD §4.3 "Where the output goes")', () => {
  const evaluation = {
    flag: 'HH', rangeSnapshot: { referenceRangeId: RANGE.referenceRangeId, version: 2, low: '3.5', high: '5.1', text: '3.5 - 5.1', unitCode: 'mmol/L' },
    critical: { isCritical: true, direction: 'high', criticalLimitId: CRIT.criticalLimitId, version: 4 },
    rangeUnavailableAgeUnknown: false, valueSha256Prefix16: sha16('n:7.0'), delta: { status: 'no_rule' },
  } as any;
  const hitsVersions = (t: string) => /\blab\.result_versions\b/i.test(t);

  it.each(['R2', 'R3'] as const)('%s: UPDATE lab.results, tenant-scoped, carrying flag / delta_status / range_unavailable_age_unknown / is_critical', async (stage) => {
    const c = makeCtx();
    await persistEvaluation(c.ctx, { stage, resultId: RESULT, versionNo: 1, evaluation });
    expect(c.stmts.length).toBeGreaterThan(0);
    const all = c.stmts.map((s) => s.text).join('\n');
    expect(all).toMatch(/UPDATE\s+lab\.results\b/i);
    expect(c.stmts.some((s) => hitsVersions(s.text))).toBe(false);
    for (const col of ['flag', 'delta_status', 'range_unavailable_age_unknown', 'is_critical']) expect(all).toContain(col);
    for (const s of c.stmts) { expect(s.text).toMatch(/tenant_id\s*=\s*\$\d/i); expect(s.values).toContain(TENANT); }
    expect(c.stmts.some((s) => s.values.includes(RESULT))).toBe(true);
    expect(c.stmts.some((s) => s.values.includes('HH'))).toBe(true);
  });

  it('R7: persistEvaluation rejects and writes nothing (result_versions is immutable-by-trigger; R7 outputs go in at INSERT time via evaluationColumns)', async () => {
    const c = makeCtx();
    await expect(persistEvaluation(c.ctx, { stage: 'R7', resultId: RESULT, versionNo: 3, evaluation })).rejects.toThrow();
    expect(c.stmts).toHaveLength(0);
  });

  it('R7: evaluationColumns returns the INSERT column/value pairs — no ref_unit_code, has flag / is_critical / range_unavailable_age_unknown / delta_status', () => {
    const { cols, values } = evaluationColumns(evaluation, 'R7');
    expect(cols).toHaveLength(values.length);
    expect(cols).not.toContain('ref_unit_code');
    for (const col of ['flag', 'is_critical', 'range_unavailable_age_unknown', 'delta_status']) expect(cols).toContain(col);
    expect(values[cols.indexOf('flag')]).toBe('HH');
    expect(values[cols.indexOf('is_critical')]).toBe(true);
  });

  it('R2/R3: evaluationColumns includes ref_unit_code', () => {
    for (const stage of ['R2', 'R3'] as const) expect(evaluationColumns(evaluation, stage).cols).toContain('ref_unit_code');
  });

  it('tenant comes from ctx only: a tenant id inside the evaluation payload is never used', async () => {
    const other = '01a1a98a-ac40-7000-8000-00000000b001';
    const c = makeCtx();
    await persistEvaluation(c.ctx, { stage: 'R3', resultId: RESULT, versionNo: 2, evaluation: { ...evaluation, tenantId: other } });
    for (const s of c.stmts) expect(s.values).not.toContain(other);
    expect(evaluationColumns({ ...evaluation, tenantId: other }, 'R7').values).not.toContain(other);
  });

  it('rejects an unknown stage and writes nothing (R6 copy is not this function)', async () => {
    const c = makeCtx();
    await expect(persistEvaluation(c.ctx, { stage: 'R6' as any, resultId: RESULT, versionNo: 1, evaluation })).rejects.toThrow();
    expect(c.stmts).toHaveLength(0);
  });
});
