// C5 T-14 — manual result entry in result.service: bulkEnterResults (02-TRD §4.3 steps 1-8, §5.4 #24, §3.2 row locking; 03-APP-FLOW R2/R3).
// ACs: AC-08.2 (resulted/manual/range snapshot/flag/roll-up), AC-08.3 (per-row 422 decimals), AC-08.4 (stale version per row), AC-08.5 (approved -> lab.result_locked),
//      AC-08.6 (ordinal codes, flag A), AC-08.7 (on_hold is surfaced to the caller; the verify guard itself is T-16 / result.state.test.ts), AC-09.7.
// LD-25 (2026-11-07, A33-2 downtime mode): the service receives the ALREADY-validated `downtime`, stores it and audits it; the limits are tested at handler level
//   (handlers/__tests__/resultEntry.handlers.test.ts) like the C4 precedent (frontdesk downtime.test.ts). The schema has no column for it -> see notes (CR gap).
// Security (07-SECURITY): P-01/P-02/P-04 (foreign / invisible ids -> per-row common.not_found, others processed), S-12 (event payload has no value), S-19 (error rows never echo a value),
//   REQ-SEC-024 (tenant from ctx only). In-memory fake store/ports, no database (DB integration is NOT covered, see notes).
//
// SEAM (spec fixes behaviour, not names) — ../result.service.ts exports
//   bulkEnterResults(ctx, input): Promise<{ results: { resultId; outcome: 'ok'|'error'; code?: string; result?: ResultRow }[]; recomputed: ResultRow[] }>
//     input = { entries: { resultId; version; valueNumeric?; valueText?; ordinalCode?; manualAbnormal?; commentCodes?; commentText? }[];
//               downtime?: { occurredAt: string; downtimeRef: string } }      (handler validates 1..200 entries and the LD-25 limits)
//     ResultRow = the lab.v_result_current row (snake_case columns of lab.results, + cur_*); the handler maps it with mappers/result.mapper.ts.
//   ctx = RecomputeCtx of T-13 (tenantId, actor{id,membershipId}, tx, now(), store, events.publish(ctx,type,input)) + ports { CatalogPort, IdentityPort{assertRole} } + audit { access(entry) }.
//   store = ResultStore of T-13 PLUS (EVERY call takes (tx, tenantId, ...); tenant comes from ctx only):
//     lockResults(tx, tenantId, ids)  — ids unique + ascending (02-TRD §3.2 lock order); returns EntryRow[] for the rows visible to the caller (absent = not found / other tenant / other centre by RLS)
//        EntryRow = { resultId, rowVersion, status, orderId, orderItemId, specimenId?, patientId, testId, analyteId, centreId, currentVersionNo, sex, patientAgeDays: number|null,
//                     specimenTypeCode?, collectedAt?, unitCode?, analyte: { id, code, resultType, decimals?, ordinalSetValues?, formula? } }
//     deltaInputs(tx, tenantId, entryRow): { rule?, candidates[] }
//     saveEntry(tx, tenantId, { resultId, expectedRowVersion, transition?: 'R2'|'R3' (absent for comment-only), origin: 'manual', value?: { numeric?|text?|ordinalCode? }, manualAbnormal?, commentCodes?, commentText?,
//                               evaluation?: Evaluation (evaluation.service.ts), enteredByMembershipId, downtime? }): ResultRow   — also appends the lab.result_observations row; throws common.version_conflict on a lost race
//     rollupSpecimen(tx, tenantId, specimenId): void        — once per distinct specimen, AFTER all saves, ascending specimen id; never for specimen-less rows
//     getResults(tx, tenantId, ids): ResultRow[]            — used for `recomputed`
//     listCriticalLog(tx, tenantId, resultId): { valueSha256Prefix16, status }[];  insertCriticalLog(tx, tenantId, {...}): { criticalEventId };  markCriticalValueChanged(tx, tenantId, resultId): void
//   Per-row failures are LimsErrors turned into { outcome: 'error', code } (no result, no value); anything that is not a LimsError propagates (caller rolls the transaction back).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { valueSha256Prefix16 } from '../../events/publish.js';
import { bulkEnterResults } from '../result.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const ORDER = '01a1a98a-ac40-7000-8000-0000000c0001', ITEM = '01a1a98a-ac40-7000-8000-0000000b0001', PATIENT = '01a1a98a-ac40-7000-8000-0000000d0001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const SPEC1 = '01a1a98a-ac40-7000-8000-0000000e0001', SPEC2 = '01a1a98a-ac40-7000-8000-0000000e0002';
const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000a${n.toString(16).padStart(4, '0')}`;
const NEG_POS = [{ code: 'NEG', display: 'Negative', sortOrder: 1 }, { code: 'POS', display: 'Positive', sortOrder: 2 }];
const HB = { id: 'a-HB', code: 'HB', resultType: 'numeric', decimals: 1 };

const row = (resultId: string, over: Record<string, unknown> = {}) => ({
  resultId, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC1, patientId: PATIENT, testId: 't-cbc', analyteId: 'a-HB', centreId: CENTRE,
  currentVersionNo: 1, sex: 'female', patientAgeDays: 10950, specimenTypeCode: 'WB', unitCode: 'g/dL', analyte: HB, ...over,
});
const entry = (resultId: string, over: Record<string, unknown> = {}) => ({ resultId, version: 3, valueNumeric: '13.4', ...over });

function make(rows: any[], opt: { range?: any; critical?: any; existingCritical?: any[]; targets?: any[]; inputs?: any[]; assertRole?: (c: any, r: any) => Promise<void>; saveFails?: Record<string, Error>; catalogError?: Error; insertCriticalLogFails?: Error } = {}) {
  const tx = { id: 'tx-1' };
  const log: { fn: string; tenantId: unknown; arg: any }[] = [];
  const emitted: { type: string; input: any }[] = [];
  const access: any[] = [];
  const catalogQueries: any[] = [];
  const byId = new Map(rows.map((r) => [r.resultId, r]));
  const rec = (fn: string, tenantId: unknown, arg: any) => log.push({ fn, tenantId, arg });
  const store = {
    async lockResults(_t: unknown, tenantId: unknown, ids: string[]) { rec('lockResults', tenantId, ids); return ids.map((i) => byId.get(i)).filter(Boolean); },
    async deltaInputs(_t: unknown, tenantId: unknown, r: any) { rec('deltaInputs', tenantId, r.resultId); return { candidates: [] }; },
    async saveEntry(_t: unknown, tenantId: unknown, a: any) {
      rec('saveEntry', tenantId, a);
      if (opt.saveFails?.[a.resultId]) throw opt.saveFails[a.resultId];
      const src = byId.get(a.resultId);
      return { id: a.resultId, version: a.expectedRowVersion + 1, status: a.transition ? 'resulted' : src.status, origin: 'manual', order_id: src.orderId, order_item_id: src.orderItemId, specimen_id: src.specimenId,
        test_id: src.testId, analyte_id: src.analyteId, analyte_code: src.analyte.code, value_numeric: a.value?.numeric ?? null, flag: a.evaluation?.flag ?? null, on_hold: false };
    },
    async rollupSpecimen(_t: unknown, tenantId: unknown, s: string) { rec('rollupSpecimen', tenantId, s); },
    async getResults(_t: unknown, tenantId: unknown, ids: string[]) { rec('getResults', tenantId, ids); return ids.map((i) => ({ id: i, version: 9, status: 'resulted', origin: 'calculated' })); },
    async listCriticalLog(_t: unknown, tenantId: unknown, r: string) { rec('listCriticalLog', tenantId, r); return opt.existingCritical ?? []; },
    async insertCriticalLog(_t: unknown, tenantId: unknown, a: any) { rec('insertCriticalLog', tenantId, a); if (opt.insertCriticalLogFails) throw opt.insertCriticalLogFails; return { criticalEventId: 'ce-1' }; },
    async markCriticalValueChanged(_t: unknown, tenantId: unknown, r: string) { rec('markCriticalValueChanged', tenantId, r); },
    // T-13 store
    async listCalculatedTargets(_t: unknown, tenantId: unknown, i: string) { rec('listCalculatedTargets', tenantId, i); return opt.targets ?? []; },
    async listInputs(_t: unknown, tenantId: unknown, i: string) { rec('listInputs', tenantId, i); return opt.inputs ?? []; },
    async inputUnitByCode(_t: unknown, tenantId: unknown, i: string) { rec('inputUnitByCode', tenantId, i); return { TC: 'mg/dL', HDL: 'mg/dL', TG: 'mg/dL' }; },
    async applyComputed(_t: unknown, tenantId: unknown, a: any) { rec('applyComputed', tenantId, a); },
    async amendCalculated(_t: unknown, tenantId: unknown, a: any) { rec('amendCalculated', tenantId, a); },
  };
  const ctx = {
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx, now: () => NOW, store,
    events: { async publish(...a: unknown[]) { emitted.push({ type: a.find((x) => typeof x === 'string') as string, input: a[a.length - 1] }); return { eventId: 'ev', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: {
      CatalogPort: {
        async referenceRangeFor(_c: unknown, q: any) { catalogQueries.push({ fn: 'range', q }); if (opt.catalogError) throw opt.catalogError; return opt.range ?? { referenceRangeId: 'rr-1', version: 2, low: '12.0', high: '16.0', unitCode: 'g/dL' }; },
        async criticalLimitsFor(_c: unknown, q: any) { catalogQueries.push({ fn: 'critical', q }); return opt.critical === null ? undefined : (opt.critical ?? { criticalLimitId: 'cl-1', version: 1, low: '7.0', high: '20.0' }); },
        // T-18 (CR-C5-001): comment codes are re-resolved server-side; this fake knows every code (not recorded in catalogQueries, which is the range/critical call log). Detail: result.service.shortcodes.test.ts.
        async resolveCommentCodes(_c: unknown, q: { codes: string[] }) { const up = [...new Set(q.codes.map((c) => c.toUpperCase()))]; return { resolved: up.map((c) => ({ code: c, commentCodeId: `cc-${c}`, version: 1, text: `Library text ${c}` })), unknown: [] }; },
      },
      IdentityPort: { async assertRole(c: unknown, r: unknown) { await opt.assertRole?.(c, r); } },
    },
  };
  return { ctx: ctx as any, log, emitted, access, catalogQueries, saves: () => log.filter((l) => l.fn === 'saveEntry').map((l) => l.arg), calls: (fn: string) => log.filter((l) => l.fn === fn) };
}
const run = (m: ReturnType<typeof make>, entries: any[], extra: Record<string, unknown> = {}): Promise<any> => bulkEnterResults(m.ctx, { entries, ...extra } as any);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

describe('T-14 AC-08.2 save a numeric value (R2)', () => {
  it('pending row -> R2, origin manual, range snapshot + flag from the catalog, row version sent as expectedRowVersion, result row returned', async () => {
    const m = make([row(id(1))]);
    const out = await run(m, [entry(id(1), { valueNumeric: '17.2' })]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ resultId: id(1), outcome: 'ok' });
    expect(out.results[0].result).toMatchObject({ id: id(1), status: 'resulted', origin: 'manual' });
    const [s] = m.saves();
    expect(s).toMatchObject({ resultId: id(1), expectedRowVersion: 3, transition: 'R2', origin: 'manual', enteredByMembershipId: MEMBERSHIP });
    expect(s.value).toEqual({ numeric: '17.2' });
    expect(s.evaluation.flag).toBe('H');
    expect(s.evaluation.rangeSnapshot).toMatchObject({ referenceRangeId: 'rr-1', version: 2, low: '12.0', high: '16.0' });
  });
  it.each([['13.4', 'N'], ['11.0', 'L'], ['17.2', 'H'], ['6.9', 'LL'], ['20.1', 'HH']])('value %s -> flag %s (LL/HH from critical limits first, exact decimals)', async (v, flag) => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { valueNumeric: v })]);
    expect(m.saves()[0].evaluation.flag).toBe(flag);
  });
  it('a resulted row entered again is R3 (not R2)', async () => {
    const m = make([row(id(1), { status: 'resulted' })]);
    await run(m, [entry(id(1))]);
    expect(m.saves()[0].transition).toBe('R3');
  });
  it('no reference range for the analyte (catalog.no_reference_range) never fails the save: no flag, no snapshot', async () => {
    const m = make([row(id(1))], { catalogError: new LimsError('catalog.no_reference_range'), critical: null });
    const out = await run(m, [entry(id(1))]);
    expect(out.results[0].outcome).toBe('ok');
    expect(m.saves()[0].evaluation.flag).toBeUndefined();
    expect(m.saves()[0].evaluation.rangeSnapshot).toBeUndefined();
  });
  it('a catalog failure other than "no range" is not swallowed (nothing saved, caller rolls back)', async () => {
    const m = make([row(id(1))], { catalogError: new Error('catalog down') });
    await expect(run(m, [entry(id(1))])).rejects.toThrow();
    expect(m.saves()).toHaveLength(0);
  });
  it('specimen roll-up: once per distinct specimen, after every save, ascending; none for a specimen-less result', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(3), { specimenId: SPEC2 }), row(id(4), { specimenId: undefined })]);
    await run(m, [entry(id(3)), entry(id(1)), entry(id(2)), entry(id(4))]);
    expect(m.calls('rollupSpecimen').map((c) => c.arg)).toEqual([SPEC1, SPEC2]);
    const lastSave = m.log.map((l) => l.fn).lastIndexOf('saveEntry');
    expect(m.log.findIndex((l) => l.fn === 'rollupSpecimen')).toBeGreaterThan(lastSave);
  });
  it('unknown age (patientAgeDays null): catalog queried WITHOUT ageDays/birthOn (08 A17.1); known age: ageDays passed', async () => {
    const a = make([row(id(1), { patientAgeDays: null })]);
    await run(a, [entry(id(1))]);
    for (const c of a.catalogQueries) { expect('ageDays' in c.q, c.fn).toBe(false); expect('birthOn' in c.q, c.fn).toBe(false); }
    const b = make([row(id(1), { patientAgeDays: 10950 })]);
    await run(b, [entry(id(1))]);
    for (const c of b.catalogQueries) expect(c.q.ageDays, c.fn).toBe(10950);
  });
  it('manual abnormal flag on a non-numeric result is passed through to evaluation and stored', async () => {
    const m = make([row(id(1), { analyte: { id: 'a-X', code: 'X', resultType: 'text' } })]);
    await run(m, [{ resultId: id(1), version: 3, valueText: 'turbid', manualAbnormal: true }]);
    expect(m.saves()[0]).toMatchObject({ manualAbnormal: true, value: { text: 'turbid' } });
  });
});

describe('T-14 AC-08.3 per-row value validation (422 lab.result_value_invalid per row, others still save)', () => {
  it('more decimals than the analyte allows (13.45 for decimals 1): that row errors, the other row saves', async () => {
    const m = make([row(id(1)), row(id(2))]);
    const out = await run(m, [entry(id(1), { valueNumeric: '13.45' }), entry(id(2), { valueNumeric: '13.4' })]);
    expect(out.results.map((r: any) => [r.resultId, r.outcome, r.code])).toEqual([[id(1), 'error', 'lab.result_value_invalid'], [id(2), 'ok', undefined]]);
    expect(out.results[0].result).toBeUndefined();
    expect(m.saves().map((s) => s.resultId)).toEqual([id(2)]);
  });
  it.each([['abc'], ['1e3'], ['--1'], ['']])('non-decimal numeric %j is rejected for that row', async (v) => {
    const m = make([row(id(1))]);
    expect((await run(m, [entry(id(1), { valueNumeric: v })])).results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_value_invalid' });
    expect(m.saves()).toHaveLength(0);
  });
  it('results come back in request order, one per entry', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(3))]);
    const out = await run(m, [entry(id(3)), entry(id(1), { valueNumeric: 'x' }), entry(id(2))]);
    expect(out.results.map((r: any) => r.resultId)).toEqual([id(3), id(1), id(2)]);
  });
  it('exactly one value field: numeric + text together -> row error', async () => {
    const m = make([row(id(1))]);
    expect((await run(m, [entry(id(1), { valueText: 'x' })])).results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_value_invalid' });
    expect(m.saves()).toHaveLength(0);
  });
  it('value field of the wrong kind for the analyte (text for a numeric analyte; ordinal code for a numeric analyte) -> row error', async () => {
    const m = make([row(id(1)), row(id(2))]);
    const out = await run(m, [{ resultId: id(1), version: 3, valueText: 'high' }, { resultId: id(2), version: 3, ordinalCode: 'POS' }]);
    expect(out.results.map((r: any) => r.code)).toEqual(['lab.result_value_invalid', 'lab.result_value_invalid']);
  });
  it('narrative analyte cannot be typed in', async () => {
    const m = make([row(id(1), { analyte: { id: 'a-N', code: 'NARR', resultType: 'narrative' } })]);
    expect((await run(m, [{ resultId: id(1), version: 3, valueText: 'free text' }])).results[0].code).toBe('lab.result_value_invalid');
  });
  it('AC-09.7: a calculated analyte (formula) never takes a manual value; recompute is not triggered', async () => {
    const m = make([row(id(1), { analyte: { ...HB, code: 'LDL', formula: { expression: 'TC - HDL - TG / 5' } } })]);
    expect((await run(m, [entry(id(1))])).results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_value_invalid' });
    expect(m.saves()).toHaveLength(0);
    expect(m.calls('listCalculatedTargets')).toHaveLength(0);
  });
  it('S-19: error rows carry no submitted value (not in code, not anywhere in the output)', async () => {
    const m = make([row(id(1))]);
    const out = await run(m, [entry(id(1), { valueNumeric: '13.456789' })]);
    expect(JSON.stringify(out)).not.toContain('13.456789');
    expect(Object.keys(out.results[0]).sort()).toEqual(['code', 'outcome', 'resultId']);
  });
});

describe('T-14 AC-08.4 optimistic concurrency per row (common.version_conflict)', () => {
  it('stale version for one row: that row errors, no save for it, the other row saves', async () => {
    const m = make([row(id(1)), row(id(2))]);
    const out = await run(m, [entry(id(1), { version: 2 }), entry(id(2))]);
    expect(out.results.map((r: any) => [r.outcome, r.code])).toEqual([['error', 'common.version_conflict'], ['ok', undefined]]);
    expect(m.saves().map((s) => s.resultId)).toEqual([id(2)]);
  });
  it('a version that is too NEW is also a conflict (never trust the client number)', async () => {
    const m = make([row(id(1))]);
    expect((await run(m, [entry(id(1), { version: 4 })])).results[0].code).toBe('common.version_conflict');
  });
  it('lost race inside the store (UPDATE ... WHERE version) -> per-row common.version_conflict, rows saved before it stay saved', async () => {
    const m = make([row(id(1)), row(id(2))], { saveFails: { [id(2)]: new LimsError('common.version_conflict') } });
    const out = await run(m, [entry(id(1)), entry(id(2))]);
    expect(out.results.map((r: any) => r.outcome)).toEqual(['ok', 'error']);
    expect(out.results[1].code).toBe('common.version_conflict');
  });
  it('lock order (02-TRD §3.2): one lockResults call with unique ids, ascending, whatever the request order', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(10))]);
    await run(m, [entry(id(10)), entry(id(2)), entry(id(1))]);
    expect(m.calls('lockResults')).toHaveLength(1);
    expect(m.calls('lockResults')[0]!.arg).toEqual([id(1), id(2), id(10)]);
  });
  it('the same result_id twice in one batch: second occurrence is a per-row version_conflict (the first one bumped the row), one save only', async () => {
    const m = make([row(id(1))]);
    const out = await run(m, [entry(id(1)), entry(id(1))]);
    expect(out.results.map((r: any) => r.outcome)).toEqual(['ok', 'error']);
    expect(out.results[1].code).toBe('common.version_conflict');
    expect(m.saves()).toHaveLength(1);
  });
});

describe('T-14 AC-08.5 locked / invalid states', () => {
  it('approved -> lab.result_locked for that row, value untouched, nothing saved for it', async () => {
    const m = make([row(id(1), { status: 'approved' }), row(id(2))]);
    const out = await run(m, [entry(id(1)), entry(id(2))]);
    expect(out.results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_locked' });
    expect(out.results[1].outcome).toBe('ok');
    expect(m.saves().map((s) => s.resultId)).toEqual([id(2)]);
  });
  it.each([['verified'], ['cancelled']])('%s -> lab.result_invalid_transition (return it first / terminal)', async (status) => {
    const m = make([row(id(1), { status })]);
    expect((await run(m, [entry(id(1))])).results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_invalid_transition' });
    expect(m.saves()).toHaveLength(0);
  });
});

describe('T-14 AC-08.6 ordinal analytes', () => {
  const ord = (over: Record<string, unknown> = {}) => row(id(1), { analyte: { id: 'a-U', code: 'UGLU', resultType: 'ordinal', ordinalSetValues: NEG_POS, ...over } });
  const normalNeg = { referenceRangeId: 'rr-9', version: 1, normalCodes: ['NEG'] };
  it('code from ordinalSetValues accepted and stored as ordinalCode', async () => {
    const m = make([ord()], { range: normalNeg, critical: null });
    expect((await run(m, [{ resultId: id(1), version: 3, ordinalCode: 'NEG' }])).results[0].outcome).toBe('ok');
    expect(m.saves()[0]).toMatchObject({ transition: 'R2', value: { ordinalCode: 'NEG' } });
  });
  it('code outside the range match normalCodes -> flag A (08 A13 D-9); inside -> no flag', async () => {
    const a = make([ord()], { range: normalNeg, critical: null });
    await run(a, [{ resultId: id(1), version: 3, ordinalCode: 'POS' }]);
    expect(a.saves()[0].evaluation.flag).toBe('A');
    const b = make([ord()], { range: normalNeg, critical: null });
    await run(b, [{ resultId: id(1), version: 3, ordinalCode: 'NEG' }]);
    expect(b.saves()[0].evaluation.flag).toBeUndefined();
  });
  it.each([['MAYBE'], ['neg'], ['NEG '], ['']])('code %j not in the set -> lab.result_value_invalid, nothing saved', async (code) => {
    const m = make([ord()], { range: normalNeg });
    expect((await run(m, [{ resultId: id(1), version: 3, ordinalCode: code }])).results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_value_invalid' });
    expect(m.saves()).toHaveLength(0);
  });
  it('free text (value_text) on an ordinal analyte is rejected', async () => {
    const m = make([ord()]);
    expect((await run(m, [{ resultId: id(1), version: 3, valueText: 'positive' }])).results[0].code).toBe('lab.result_value_invalid');
  });
});

describe('T-14 comments-only rows', () => {
  it('comment text/codes only: saved without a status transition and without evaluation (catalog not called), no roll-up', async () => {
    const m = make([row(id(1), { status: 'resulted' })]);
    const out = await run(m, [{ resultId: id(1), version: 3, commentText: 'Hemolysed', commentCodes: ['HEMOLYSED'] }]);
    expect(out.results[0].outcome).toBe('ok');
    const [s] = m.saves();
    expect(s.transition).toBeUndefined();
    expect(s.value).toBeUndefined();
    expect(s).toMatchObject({ commentText: 'Hemolysed', commentCodes: ['HEMOLYSED'] });
    expect(m.catalogQueries).toHaveLength(0);
  });
  it('an entry with neither a value nor a comment is a row error', async () => {
    const m = make([row(id(1))]);
    expect((await run(m, [{ resultId: id(1), version: 3 }])).results[0]).toMatchObject({ outcome: 'error', code: 'lab.result_value_invalid' });
  });
  it('S-14: comment text is stored verbatim (inert at render time), not executed or stripped by the service', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { commentText: '<script>alert(1)</script>' })]);
    expect(m.saves()[0].commentText).toBe('<script>alert(1)</script>');
  });
});

describe('T-14 tenant / centre isolation (07 P-01, P-02, P-04; REQ-SEC-024)', () => {
  it('ids the store does not return (other tenant / invisible) -> per-row common.not_found, no save, the visible row is processed', async () => {
    const m = make([row(id(1))]);
    const out = await run(m, [entry(id(9)), entry(id(1))]);
    expect(out.results.map((r: any) => [r.resultId, r.outcome, r.code])).toEqual([[id(9), 'error', 'common.not_found'], [id(1), 'ok', undefined]]);
    expect(m.saves().map((s) => s.resultId)).toEqual([id(1)]);
  });
  it('IdentityPort.assertRole(lab.result.enter, row centre) is checked per row; auth.forbidden for a centre the user lacks is reported as common.not_found (P-02: 404, not 403)', async () => {
    const asked: any[] = [];
    const m = make([row(id(1), { centreId: 'c-A1' }), row(id(2), { centreId: 'c-A2' })], {
      assertRole: async (_c, r) => { asked.push(r); if (r.centreId === 'c-A2') throw new LimsError('auth.forbidden'); },
    });
    const out = await run(m, [entry(id(1)), entry(id(2))]);
    expect(asked.map((a) => [a.permission, a.centreId])).toEqual([['lab.result.enter', 'c-A1'], ['lab.result.enter', 'c-A2']]);
    expect(out.results.map((r: any) => [r.outcome, r.code])).toEqual([['ok', undefined], ['error', 'common.not_found']]);
    expect(m.saves().map((s) => s.resultId)).toEqual([id(1)]);
  });
  it('every store call receives ctx.tenantId and the caller tx (never a value from the request)', async () => {
    const m = make([row(id(1))]);
    await run(m, [{ ...entry(id(1)), tenantId: 'EVIL', tenant_id: 'EVIL' }]);
    expect(m.log.length).toBeGreaterThan(0);
    for (const l of m.log) expect(l.tenantId, l.fn).toBe(TENANT);
    expect(JSON.stringify(m.log.map((l) => l.arg))).not.toContain('EVIL');
  });
});

describe('T-14 critical values (02-TRD §4.3 step 4; S-12)', () => {
  const hash = valueSha256Prefix16({ kind: 'n', value: '6.0' });
  it('critical value: log row inserted once, lab.critical_value.detected.v1 published with the contract key and a value-free payload', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { valueNumeric: '6.0' })]);
    expect(m.calls('insertCriticalLog')).toHaveLength(1);
    const ev = m.emitted.filter((e) => e.type === 'lab.critical_value.detected.v1');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.input.idempotencyKey).toBe(`${id(1)}:critical:1:${hash}`);
    expect(ev[0]!.input.aggregate).toMatchObject({ type: 'result', id: id(1) });
    const p = ev[0]!.input.payload;
    expect(p).toMatchObject({ critical_event_id: 'ce-1', result_id: id(1), result_version_no: 1, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, analyte_id: 'a-HB', direction: 'low' });
    expect(Object.keys(p).every((k) => ['critical_event_id', 'result_id', 'result_version_no', 'order_id', 'patient_id', 'centre_id', 'referrer_id', 'analyte_id', 'direction', 'detected_at'].includes(k))).toBe(true);
    expect(JSON.stringify(p)).not.toContain('6.0');
  });
  it('same critical value already logged (same hash) -> no second log row, no second event', async () => {
    const m = make([row(id(1), { status: 'resulted' })], { existingCritical: [{ valueSha256Prefix16: hash, status: 'open' }] });
    await run(m, [entry(id(1), { valueNumeric: '6.0' })]);
    expect(m.calls('insertCriticalLog')).toHaveLength(0);
    expect(m.emitted.filter((e) => e.type === 'lab.critical_value.detected.v1')).toHaveLength(0);
  });
  it('open critical event replaced by a normal value -> value_changed_after_detection marked, no event', async () => {
    const m = make([row(id(1), { status: 'resulted' })], { existingCritical: [{ valueSha256Prefix16: hash, status: 'open' }] });
    await run(m, [entry(id(1), { valueNumeric: '13.4' })]);
    expect(m.calls('markCriticalValueChanged')).toHaveLength(1);
    expect(m.emitted).toHaveLength(0);
  });
  it('a LimsError AFTER the row was saved (critical log insert fails) rolls the whole batch back: rejects, no ok/error outcome for the stored row (no value saved without its critical log)', async () => {
    const m = make([row(id(1))], { insertCriticalLogFails: new LimsError('common.version_conflict') });
    const e = await fail(run(m, [entry(id(1), { valueNumeric: '6.0' })]));
    expect(e).toBeInstanceOf(LimsError);
    expect(e.code).toBe('common.version_conflict');
    expect(m.saves()).toHaveLength(1);
    expect(m.emitted.filter((x) => x.type === 'lab.critical_value.detected.v1')).toHaveLength(0);
  });
  it('non-critical value: no log row, no event', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1))]);
    expect(m.calls('insertCriticalLog')).toHaveLength(0);
    expect(m.emitted).toHaveLength(0);
  });
});

describe('T-14 dependents (AC-09.1 trigger) — recompute after save, returned as `recomputed`', () => {
  const FRIED = 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)';
  const tgRow = row(id(5), { analyte: { id: 'a-TG', code: 'TG', resultType: 'numeric', decimals: 0 }, unitCode: 'mg/dL' });
  const ldl = { resultId: 'r-LDL', analyteCode: 'LDL', expression: FRIED, status: 'pending', versionNo: 1, rowVersion: 4, decimals: 0, testRevision: 3, catalogRevision: 17, sex: 'female', ageDays: 10950, ageYears: 30, orderId: ORDER, testId: 't-lipid', analyteId: 'a-LDL' };
  const inp = (c: string, v: string) => ({ analyteCode: c, resultId: `r-${c}`, versionNo: 1, status: 'resulted', resultType: 'numeric', value: v, unitCode: 'mg/dL' });
  it('saving TG recomputes LDL in the same tx (trigger enter), response.recomputed carries the dependent row', async () => {
    const m = make([tgRow], { targets: [ldl], inputs: [inp('TC', '200'), inp('HDL', '50'), inp('TG', '150')] });
    const out = await run(m, [{ resultId: id(5), version: 3, valueNumeric: '150' }], {});
    expect(m.calls('listCalculatedTargets')[0]!.arg).toBe(ITEM);
    expect(m.calls('applyComputed')).toHaveLength(1);
    expect(m.calls('applyComputed')[0]!.arg).toMatchObject({ resultId: 'r-LDL', origin: 'calculated' });
    expect(m.calls('getResults').at(-1)!.arg).toEqual(['r-LDL']);
    expect(out.recomputed.map((r: any) => r.id)).toEqual(['r-LDL']);
    expect(m.log.findIndex((l) => l.fn === 'saveEntry')).toBeLessThan(m.log.findIndex((l) => l.fn === 'applyComputed'));
  });
  it('failed rows and comment-only rows trigger no recompute; recomputed is []', async () => {
    const m = make([tgRow], { targets: [ldl], inputs: [] });
    const out = await run(m, [{ resultId: id(5), version: 1, valueNumeric: '150' }]);   // stale
    expect(m.calls('listCalculatedTargets')).toHaveLength(0);
    expect(out.recomputed).toEqual([]);
    const c = make([tgRow], { targets: [ldl] });
    await run(c, [{ resultId: id(5), version: 3, commentText: 'note' }]);
    expect(c.calls('listCalculatedTargets')).toHaveLength(0);
  });
});

describe('T-14 LD-25 downtime back-entry (service side: store + audit; limits are tested at handler level)', () => {
  const down = { occurredAt: '2026-06-14T09:00:00.000Z', downtimeRef: 'PB-000123' };
  it('downtime passed to the store with the entry and audited with the paper serial + original time; server clock still used for everything else', async () => {
    const m = make([row(id(1)), row(id(2))]);
    await run(m, [entry(id(1)), entry(id(2))], { downtime: down });
    for (const s of m.saves()) expect(s.downtime).toEqual(down);
    const audit = JSON.stringify(m.access);
    expect(audit).toContain('downtime_backentry');
    expect(audit).toContain('PB-000123');
    expect(audit).toContain('2026-06-14T09:00:00.000Z');
  });
  it('only saved rows are audited (a rejected row writes no back-entry audit)', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { valueNumeric: 'bad' })], { downtime: down });
    expect(m.access).toHaveLength(0);
  });
  it('live entry carries no downtime and writes no downtime audit', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1))]);
    expect(m.saves()[0].downtime).toBeUndefined();
    expect(JSON.stringify(m.access)).not.toContain('downtime');
  });
  it('S-12: the critical event of a back-entered value carries neither downtime_ref nor occurred_at (no back-dated instant on the bus)', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { valueNumeric: '6.0' })], { downtime: down });
    expect(JSON.stringify(m.emitted)).not.toContain('PB-000123');
    expect(JSON.stringify(m.emitted)).not.toContain('2026-06-14');
  });
});
