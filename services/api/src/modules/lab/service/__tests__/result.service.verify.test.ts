// C5 T-16 — verify / bulk verify / return / auto-verify hook in result.service (02-TRD §3.3 R4/R5, §4.5 row 10-11, §5.4 #27-#29; 03-IC §3.9, §4.11, §10.2; 08 A13 D-2, A17.1, CR-C5-005, CR-C9-004).
// ACs: AC-12.3 (delta ack -> 409 lab.flag_ack_required, stored on the verification), AC-15.1 (manual verify: status/verification row/event mode manual), AC-15.2 (bulk per-id outcomes, foreign ids not_found),
//      AC-15.3 (pending -> lab.result_invalid_transition), AC-15.4 (return: resulted + kind 'returned' + roll-down S15), AC-15.5 (flag false -> hook never called; flag true + deny/feature_disabled -> stays resulted).
// Security (07-SECURITY): P-01/P-02/P-04 (foreign / invisible ids -> per-id common.not_found, others processed; no 403), S-03 (verify/return never write value columns), REQ-SEC-024 (tenant from ctx only), S-19 (no value in errors/events).
//
// SEAM (spec fixes behaviour, not names) — ../result.service.ts must export (all run in ctx.tx, every store call is (tx, tenantId, ...), tenant from ctx only):
//   verifyResult(ctx, { resultId, version, acknowledgedFlags? })                    -> ResultRow (the store's saved row); throws LimsError
//   bulkVerifyResults(ctx, { items: { resultId, version, acknowledgedFlags? }[] })  -> { results: { resultId, outcome: 'ok'|'error', code?, result? }[] } in input order (per-row LimsError -> error row, never a value;
//                                                                                    non-LimsError propagates = caller rolls back). Same batch rules as bulkEnterResults (T-14): ids locked once, unique + ascending;
//                                                                                    a second item for an id already saved in the batch is common.version_conflict.
//   returnResult(ctx, { resultId, version, reasonCode, comment? })                  -> ResultRow
//   autoVerifyAfterInstrumentSave(ctx, { resultId })                                -> { verified: boolean; result?: ResultRow }   (called by the T-22 ingest pipeline after each instrument-origin save)
//   ctx = EntryCtx of T-14 (tenantId, actor{type,id,membershipId}, tx, now(), events.publish(ctx,type,input), ports.IdentityPort.assertRole) + ports.QualityPort.canAutoVerify(ctx, ResultContext)
//         + config.autoverifyHookEnabled (LabConfig, config.ts) + store = VerifyStore:
//     lockForVerify(tx, tenantId, ids)  ids unique + ascending (02-TRD §3.2); returns the VISIBLE rows only:
//        VerifyRow = { resultId, rowVersion, status, onHold, unitMismatch, deltaStatus ('not_applicable'|'no_rule'|'no_previous'|'pass'|'fail'), isCritical, instrumentFlags: string[], origin, rangeUnavailableAgeUnknown,
//                      orderId, orderItemId, specimenId?, testId, analyteId, departmentId, instrumentId?, centreId, currentVersionNo, flag?, valueNumeric?, resultedAt: Date }
//     verify(tx, tenantId, { resultId, expectedRowVersion, mode: 'manual'|'auto', membershipId? (manual only), acknowledgedFlags: string[], ruleSetVersion? (auto), occurredAt: ISO })   -> ResultRow
//        = R4 UPDATE ... WHERE version = expectedRowVersion + lab.verifications row kind 'verified' (throws common.version_conflict on a lost race)
//     applyReturn(tx, tenantId, { resultId, expectedRowVersion, reasonCode, comment?, membershipId, occurredAt: ISO })                                                                -> ResultRow
//        = R5 + lab.verifications row kind 'returned'
//     returnReasonActive(tx, tenantId, code) -> boolean            (lab.return_reasons, global + tenant shadow; inactive/unknown -> common.validation_failed at /reason_code)
//     resolveUnitMismatchException(tx, tenantId, { resultId, resolverMembershipId, resolution: 'assigned' })   (02-TRD §4.5 row 10, finding C5 #42)
//     rollupSpecimen(tx, tenantId, specimenId)                      once per distinct specimen, AFTER all saves, ascending; never for specimen-less rows
//   Flags that need an acknowledgement before R4: delta (deltaStatus 'fail'), critical (isCritical), unit_mismatch (unitMismatch), instrument_flag (instrumentFlags non-empty) -> else 409 lab.flag_ack_required.
//   Check order: not found / no role (404) -> version (common.version_conflict) -> transition table (lab.result_invalid_transition) -> on hold (lab.result_on_hold) -> flag acknowledgement.
//   Event lab.result.verified.v1: aggregate result/seq = new row version, key `<result_id>:verified:<result_version_no>:<row_version>`; payload per 03-IC §3.9 (no value; D-2: no specimen_id when specimen-less,
//   verified_by_membership_id iff mode manual).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { autoVerifyAfterInstrumentSave, bulkVerifyResults, returnResult, verifyResult } from '../result.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const ORDER = '01a1a98a-ac40-7000-8000-0000000c0001', ITEM = '01a1a98a-ac40-7000-8000-0000000b0001', PATIENT = '01a1a98a-ac40-7000-8000-0000000d0001';
const CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', DEPT = '01a1a98a-ac40-7000-8000-000000150001', INSTR = '01a1a98a-ac40-7000-8000-0000000d00f1';
const SPEC1 = '01a1a98a-ac40-7000-8000-0000000e0001', SPEC2 = '01a1a98a-ac40-7000-8000-0000000e0002';
const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000a${n.toString(16).padStart(4, '0')}`;
const ALLOWED_PAYLOAD = ['result_id', 'result_version_no', 'order_id', 'order_item_id', 'specimen_id', 'test_id', 'analyte_id', 'department_id', 'instrument_id', 'origin', 'mode', 'verified_at', 'verified_by_membership_id', 'processing_branch_id'];

const row = (resultId: string, over: Record<string, unknown> = {}) => ({
  resultId, rowVersion: 4, status: 'resulted', onHold: false, unitMismatch: false, deltaStatus: 'pass', isCritical: false, instrumentFlags: [] as string[], origin: 'manual', rangeUnavailableAgeUnknown: false,
  orderId: ORDER, orderItemId: ITEM, specimenId: SPEC1, patientId: PATIENT, testId: 't-cbc', analyteId: 'a-HB', departmentId: DEPT, centreId: CENTRE, currentVersionNo: 1, flag: 'N', valueNumeric: '13.4',
  resultedAt: new Date('2026-06-15T04:00:00Z'), ...over,
});
const instrumentRow = (resultId: string, over: Record<string, unknown> = {}) => row(resultId, { origin: 'instrument', instrumentId: INSTR, instrumentFlags: [], ...over });

interface Opt {
  assertRole?: (c: any, r: any) => Promise<void>; verifyFails?: Record<string, Error>; returnReasonOk?: boolean; hookEnabled?: boolean; decision?: any; canAutoVerifyThrows?: Error;
  tenantSwitch?: boolean; actor?: any;
}
function make(rows: any[], opt: Opt = {}) {
  const tx = { id: 'tx-1' };
  const log: { fn: string; tenantId: unknown; arg: any; tx: unknown }[] = [];
  const emitted: { type: string; input: any }[] = [];
  const asked: any[] = [], auto: any[] = [];
  const byId = new Map(rows.map((r) => [r.resultId, r]));
  const rec = (fn: string, t: unknown, tenantId: unknown, arg: any) => log.push({ fn, tenantId, arg, tx: t });
  const out = (src: any, status: string, extra: Record<string, unknown> = {}) => ({
    id: src.resultId, version: src.rowVersion + 1, status, origin: src.origin, order_id: src.orderId, order_item_id: src.orderItemId, specimen_id: src.specimenId, test_id: src.testId, analyte_id: src.analyteId,
    analyte_code: 'HB', value_numeric: src.valueNumeric ?? null, flag: src.flag ?? null, on_hold: src.onHold, current_version_no: src.currentVersionNo, unit_mismatch: src.unitMismatch, ...extra,
  });
  const store = {
    async lockForVerify(t: unknown, tenantId: unknown, ids: string[]) { rec('lockForVerify', t, tenantId, ids); return ids.map((i) => byId.get(i)).filter(Boolean); },
    async verify(t: unknown, tenantId: unknown, a: any) {
      rec('verify', t, tenantId, a);
      if (opt.verifyFails?.[a.resultId]) throw opt.verifyFails[a.resultId];
      return out(byId.get(a.resultId), 'verified', { verified_at: a.occurredAt, ...(a.membershipId ? { verified_by_membership_id: a.membershipId } : {}) });
    },
    async applyReturn(t: unknown, tenantId: unknown, a: any) { rec('applyReturn', t, tenantId, a); return out(byId.get(a.resultId), 'resulted'); },
    async returnReasonActive(t: unknown, tenantId: unknown, code: string) { rec('returnReasonActive', t, tenantId, code); return opt.returnReasonOk ?? true; },
    async resolveUnitMismatchException(t: unknown, tenantId: unknown, a: any) { rec('resolveUnitMismatchException', t, tenantId, a); },
    async rollupSpecimen(t: unknown, tenantId: unknown, s: string) { rec('rollupSpecimen', t, tenantId, s); },
  };
  const ctx = {
    tenantId: TENANT, actor: opt.actor ?? { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx, now: () => NOW, store,
    config: { autoverifyHookEnabled: opt.hookEnabled ?? false },
    events: { async publish(...a: unknown[]) { emitted.push({ type: a.find((x) => typeof x === 'string') as string, input: a[a.length - 1] }); return { eventId: 'ev', duplicate: false }; } },
    audit: { async access() {} },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, r: any) { asked.push(r); await opt.assertRole?.(_c, r); },
        async getTenantSettings() { return { autoVerificationEnabled: opt.tenantSwitch ?? false }; },
      },
      QualityPort: {
        async canAutoVerify(c: unknown, rc: any) {
          auto.push({ ctx: c, rc });
          if (opt.canAutoVerifyThrows) throw opt.canAutoVerifyThrows;
          return opt.decision ?? { decision: 'deny', reasons: ['feature_disabled'] };
        },
      },
    },
  };
  return {
    ctx: ctx as never, tx, log, emitted, asked, auto,
    calls: (fn: string) => log.filter((l) => l.fn === fn),
    verifies: () => log.filter((l) => l.fn === 'verify').map((l) => l.arg),
    verifiedEvents: () => emitted.filter((e) => e.type === 'lab.result.verified.v1'),
  };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const forbidden = async () => { throw new LimsError('auth.forbidden'); };
const v = (resultId: string, over: Record<string, unknown> = {}) => ({ resultId, version: 4, ...over });

describe('T-16 AC-15.1 manual verify (R4)', () => {
  it('resulted, not on hold -> status verified; verification stored as mode manual by the caller membership; server clock; row version from the lock, never from trust', async () => {
    const m = make([row(id(1))]);
    const r = await verifyResult(m.ctx, v(id(1)));
    expect(r).toMatchObject({ id: id(1), status: 'verified' });
    expect(m.verifies()).toEqual([{ resultId: id(1), expectedRowVersion: 4, mode: 'manual', membershipId: MEMBERSHIP, acknowledgedFlags: [], occurredAt: NOW.toISOString() }]);
  });
  it('role lab.result.verify is asked for the result centre (not the request) and every store call carries ctx.tx + ctx.tenantId', async () => {
    const m = make([row(id(1))]);
    await verifyResult(m.ctx, v(id(1)));
    expect(m.asked).toEqual([{ permission: 'lab.result.verify', centreId: CENTRE }]);
    for (const l of m.log) { expect(l.tenantId, l.fn).toBe(TENANT); expect(l.tx, l.fn).toBe(m.tx); }
  });
  it('lab.result.verified.v1 with mode manual: aggregate result seq = new row version, key result:verified:version_no:row_version, payload per 03-IC §3.9 and no value (P3)', async () => {
    const m = make([instrumentRow(id(1), { flag: 'HH', valueNumeric: '6.9' })]);
    await verifyResult(m.ctx, v(id(1), { acknowledgedFlags: [] }));
    const [e] = m.verifiedEvents();
    expect(m.verifiedEvents()).toHaveLength(1);
    expect(e!.input.aggregate).toEqual({ type: 'result', id: id(1), seq: 5 });
    expect(e!.input.idempotencyKey).toBe(`${id(1)}:verified:1:5`);
    expect(e!.input.payload).toEqual({
      result_id: id(1), result_version_no: 1, order_id: ORDER, order_item_id: ITEM, specimen_id: SPEC1, test_id: 't-cbc', analyte_id: 'a-HB', department_id: DEPT, instrument_id: INSTR,
      origin: 'instrument', mode: 'manual', verified_at: NOW.toISOString(), verified_by_membership_id: MEMBERSHIP,
    });
    for (const k of Object.keys(e!.input.payload)) expect(ALLOWED_PAYLOAD).toContain(k);
    expect(JSON.stringify(e!.input.payload)).not.toContain('6.9');
  });
  it('D-2: a specimen-less result (usesExistingMaterial) emits the event WITHOUT specimen_id and no roll-up runs', async () => {
    const m = make([row(id(1), { specimenId: undefined })]);
    await verifyResult(m.ctx, v(id(1)));
    expect('specimen_id' in m.verifiedEvents()[0]!.input.payload).toBe(false);
    expect(m.calls('rollupSpecimen')).toHaveLength(0);
  });
  it('specimen roll-up (S8) runs once for the result specimen after the verification is stored', async () => {
    const m = make([row(id(1))]);
    await verifyResult(m.ctx, v(id(1)));
    expect(m.calls('rollupSpecimen').map((c) => c.arg)).toEqual([SPEC1]);
    expect(m.log.findIndex((l) => l.fn === 'rollupSpecimen')).toBeGreaterThan(m.log.findIndex((l) => l.fn === 'verify'));
  });
  it('S-03: the verification call carries no value / comment columns (verify can never change a value)', async () => {
    const m = make([row(id(1))]);
    await verifyResult(m.ctx, { ...v(id(1)), valueNumeric: '99', value: { numeric: '99' } } as never);
    expect(Object.keys(m.verifies()[0]).join(',')).not.toMatch(/value|comment|ordinal/i);
  });
  it('a stale If-Match version -> common.version_conflict; nothing stored, no event', async () => {
    const m = make([row(id(1))]);
    expect((await fail(verifyResult(m.ctx, v(id(1), { version: 3 })))).code).toBe('common.version_conflict');
    expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('a lost race inside the store (version_conflict from verify) is not swallowed and emits nothing', async () => {
    const m = make([row(id(1))], { verifyFails: { [id(1)]: new LimsError('common.version_conflict') } });
    expect((await fail(verifyResult(m.ctx, v(id(1))))).code).toBe('common.version_conflict');
    expect(m.emitted).toHaveLength(0); expect(m.calls('rollupSpecimen')).toHaveLength(0);
  });
});

describe('T-16 AC-15.3 / guards: transition table, hold, tenant isolation', () => {
  it.each(['pending', 'verified', 'approved', 'cancelled'])('status %s -> 409 lab.result_invalid_transition, nothing stored', async (status) => {
    const m = make([row(id(1), { status })]);
    expect((await fail(verifyResult(m.ctx, v(id(1))))).code).toBe('lab.result_invalid_transition');
    expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('on_hold -> 409 lab.result_on_hold even with every flag acknowledged', async () => {
    const m = make([row(id(1), { onHold: true, isCritical: true })]);
    expect((await fail(verifyResult(m.ctx, v(id(1), { acknowledgedFlags: ['critical'] })))).code).toBe('lab.result_on_hold');
    expect(m.verifies()).toHaveLength(0);
  });
  it('P-01: unknown / other tenant / invisible id -> common.not_found (the role is never asked for it)', async () => {
    const m = make([]);
    expect((await fail(verifyResult(m.ctx, v(id(9))))).code).toBe('common.not_found');
    expect(m.asked).toHaveLength(0);
  });
  it('P-02: a caller without lab.result.verify at the result centre gets common.not_found, never auth.forbidden; nothing stored', async () => {
    const m = make([row(id(1))], { assertRole: forbidden });
    expect((await fail(verifyResult(m.ctx, v(id(1))))).code).toBe('common.not_found');
    expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('an infrastructure error from the role check is not turned into not_found', async () => {
    const m = make([row(id(1))], { assertRole: async () => { throw new Error('identity down'); } });
    await expect(verifyResult(m.ctx, v(id(1)))).rejects.toThrow('identity down');
  });
});

describe('T-16 AC-12.3 flag acknowledgements (CR-C5-005)', () => {
  it('delta failure without acknowledged_flags -> 409 lab.flag_ack_required; nothing stored, no event, no roll-up', async () => {
    const m = make([row(id(1), { deltaStatus: 'fail' })]);
    expect((await fail(verifyResult(m.ctx, v(id(1))))).code).toBe('lab.flag_ack_required');
    expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0); expect(m.calls('rollupSpecimen')).toHaveLength(0);
  });
  it('with acknowledged_flags ["delta"] the verification succeeds and the acknowledgement is stored on the verification record', async () => {
    const m = make([row(id(1), { deltaStatus: 'fail' })]);
    expect((await verifyResult(m.ctx, v(id(1), { acknowledgedFlags: ['delta'] }))).status).toBe('verified');
    expect(m.verifies()[0]).toMatchObject({ acknowledgedFlags: ['delta'], mode: 'manual' });
  });
  it.each([
    ['critical', { isCritical: true }],
    ['unit_mismatch', { unitMismatch: true }],
    ['instrument_flag', { instrumentFlags: ['E01'] }],
    ['delta', { deltaStatus: 'fail' }],
  ])('%s needs its own acknowledgement, and only that flag satisfies it', async (flag, over) => {
    const m = make([row(id(1), over)]);
    expect((await fail(verifyResult(m.ctx, v(id(1))))).code).toBe('lab.flag_ack_required');
    const wrong = ['delta', 'critical', 'unit_mismatch', 'instrument_flag'].find((f) => f !== flag)!;
    expect((await fail(verifyResult(m.ctx, v(id(1), { acknowledgedFlags: [wrong] })))).code).toBe('lab.flag_ack_required');
    expect((await verifyResult(m.ctx, v(id(1), { acknowledgedFlags: [flag] }))).status).toBe('verified');
  });
  it('several flags: a partial acknowledgement is not enough, the full set is', async () => {
    const m = make([row(id(1), { deltaStatus: 'fail', isCritical: true, instrumentFlags: ['E01'] })]);
    expect((await fail(verifyResult(m.ctx, v(id(1), { acknowledgedFlags: ['delta', 'critical'] })))).code).toBe('lab.flag_ack_required');
    await verifyResult(m.ctx, v(id(1), { acknowledgedFlags: ['delta', 'critical', 'instrument_flag'] }));
    expect([...m.verifies()[0].acknowledgedFlags].sort()).toEqual(['critical', 'delta', 'instrument_flag']);
  });
  it('acknowledging a flag the result does not have is harmless (stored as sent)', async () => {
    const m = make([row(id(1))]);
    expect((await verifyResult(m.ctx, v(id(1), { acknowledgedFlags: ['delta'] }))).status).toBe('verified');
  });
  it('delta no_rule / no_previous / not_applicable / pass need no acknowledgement', async () => {
    for (const deltaStatus of ['no_rule', 'no_previous', 'not_applicable', 'pass']) {
      const m = make([row(id(1), { deltaStatus })]);
      expect((await verifyResult(m.ctx, v(id(1)))).status, deltaStatus).toBe('verified');
    }
  });
  it('02-TRD §4.5 row 10: verify with unit_mismatch acknowledged resolves the open unit_mismatch exception (resolution assigned, resolver = verifier) in the same tx', async () => {
    const m = make([row(id(1), { unitMismatch: true })]);
    await verifyResult(m.ctx, v(id(1), { acknowledgedFlags: ['unit_mismatch'] }));
    const [c] = m.calls('resolveUnitMismatchException');
    expect(m.calls('resolveUnitMismatchException')).toHaveLength(1);
    expect(c).toMatchObject({ tenantId: TENANT, tx: m.tx, arg: { resultId: id(1), resolverMembershipId: MEMBERSHIP, resolution: 'assigned' } });
  });
  it('no unit_mismatch acknowledgement -> the exception is not touched; a refused verification (no ack) leaves it open too', async () => {
    const a = make([row(id(1), { deltaStatus: 'fail' })]);
    await verifyResult(a.ctx, v(id(1), { acknowledgedFlags: ['delta'] }));
    expect(a.calls('resolveUnitMismatchException')).toHaveLength(0);
    const b = make([row(id(1), { unitMismatch: true })]);
    await fail(verifyResult(b.ctx, v(id(1))));
    expect(b.calls('resolveUnitMismatchException')).toHaveLength(0);
  });
});

describe('T-16 AC-15.2 bulk verify: per-id outcomes, isolation, batch rules', () => {
  it('50 ids, 5 of them foreign -> 45 ok + 5 common.not_found, in input order; foreign ids cause no side effect (P-04)', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => id(i + 1));
    const foreign = new Set(ids.filter((_, i) => i % 10 === 3));
    const m = make(ids.filter((x) => !foreign.has(x)).map((x) => row(x)));
    const out = await bulkVerifyResults(m.ctx, { items: ids.map((x) => v(x)) });
    expect(out.results.map((r: any) => r.resultId)).toEqual(ids);
    for (const r of out.results as any[]) {
      if (foreign.has(r.resultId)) { expect(r).toEqual({ resultId: r.resultId, outcome: 'error', code: 'common.not_found' }); }
      else { expect(r.outcome).toBe('ok'); expect(r.result.status).toBe('verified'); }
    }
    expect(m.verifies().map((a) => a.resultId)).toEqual(ids.filter((x) => !foreign.has(x)));
    expect(m.verifiedEvents()).toHaveLength(45);
  });
  it('rows are locked once, ids unique + ascending (02-TRD §3.2), with the ctx tenant', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(3))]);
    await bulkVerifyResults(m.ctx, { items: [v(id(3)), v(id(1)), v(id(2))] });
    expect(m.calls('lockForVerify')).toHaveLength(1);
    expect(m.calls('lockForVerify')[0]).toMatchObject({ tenantId: TENANT, arg: [id(1), id(2), id(3)] });
  });
  it('mixed outcomes: stale version, invalid transition, on hold, flag_ack_required, forbidden centre -> per-id codes; the clean rows are verified', async () => {
    const OTHER = '01a1a98a-ac40-7000-8000-00000000a202';
    const rows = [row(id(1)), row(id(2)), row(id(3), { status: 'pending' }), row(id(4), { onHold: true }), row(id(5), { deltaStatus: 'fail' }), row(id(6), { centreId: OTHER })];
    const m = make(rows, { assertRole: async (_c, r) => { if (r.centreId === OTHER) throw new LimsError('auth.forbidden'); } });
    const out = await bulkVerifyResults(m.ctx, { items: [v(id(1)), v(id(2), { version: 1 }), v(id(3)), v(id(4)), v(id(5)), v(id(6))] });
    expect(out.results.map((r: any) => [r.outcome, r.code])).toEqual([
      ['ok', undefined], ['error', 'common.version_conflict'], ['error', 'lab.result_invalid_transition'], ['error', 'lab.result_on_hold'], ['error', 'lab.flag_ack_required'], ['error', 'common.not_found'],
    ]);
    expect(m.verifies().map((a) => a.resultId)).toEqual([id(1)]);
  });
  it('per-item acknowledged_flags: item with the ack succeeds, the one without fails', async () => {
    const m = make([row(id(1), { isCritical: true }), row(id(2), { isCritical: true })]);
    const out = await bulkVerifyResults(m.ctx, { items: [v(id(1), { acknowledgedFlags: ['critical'] }), v(id(2))] });
    expect(out.results.map((r: any) => r.outcome)).toEqual(['ok', 'error']);
    expect((out.results[1] as any).code).toBe('lab.flag_ack_required');
    expect(m.verifies()[0]).toMatchObject({ resultId: id(1), acknowledgedFlags: ['critical'] });
  });
  it('error rows carry code only: no result, no value, no detail (S-19)', async () => {
    const m = make([row(id(1), { status: 'approved', valueNumeric: '123.456' })]);
    const out = await bulkVerifyResults(m.ctx, { items: [v(id(1))] });
    expect(out.results[0]).toEqual({ resultId: id(1), outcome: 'error', code: 'lab.result_invalid_transition' });
    expect(JSON.stringify(out)).not.toContain('123.456');
  });
  it('the same id twice in one batch: the first is verified, the second is common.version_conflict (no double event)', async () => {
    const m = make([row(id(1))]);
    const out = await bulkVerifyResults(m.ctx, { items: [v(id(1)), v(id(1))] });
    expect(out.results.map((r: any) => [r.outcome, r.code])).toEqual([['ok', undefined], ['error', 'common.version_conflict']]);
    expect(m.verifiedEvents()).toHaveLength(1);
  });
  it('roll-up once per distinct specimen after every verification, ascending; none for specimen-less rows', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(3), { specimenId: SPEC2 }), row(id(4), { specimenId: undefined })]);
    await bulkVerifyResults(m.ctx, { items: [v(id(3)), v(id(1)), v(id(2)), v(id(4))] });
    expect(m.calls('rollupSpecimen').map((c) => c.arg)).toEqual([SPEC1, SPEC2]);
    expect(m.log.findIndex((l) => l.fn === 'rollupSpecimen')).toBeGreaterThan(m.log.map((l) => l.fn).lastIndexOf('verify'));
  });
  it('a unit_mismatch acknowledgement in a bulk item resolves that result\'s exception only', async () => {
    const m = make([row(id(1), { unitMismatch: true }), row(id(2), { unitMismatch: true })]);
    await bulkVerifyResults(m.ctx, { items: [v(id(1), { acknowledgedFlags: ['unit_mismatch'] }), v(id(2))] });
    expect(m.calls('resolveUnitMismatchException').map((c) => c.arg.resultId)).toEqual([id(1)]);
  });
  it('a failure that is not a LimsError propagates (the caller rolls the whole transaction back)', async () => {
    const m = make([row(id(1)), row(id(2))], { verifyFails: { [id(2)]: new Error('db down') } });
    await expect(bulkVerifyResults(m.ctx, { items: [v(id(1)), v(id(2))] })).rejects.toThrow('db down');
  });
});

describe('T-16 AC-15.4 return for correction (R5)', () => {
  const ret = (resultId: string, over: Record<string, unknown> = {}) => ({ resultId, version: 4, reasonCode: 'RECHECK', ...over });
  it('verified -> resulted with the reason code and comment; verification kind returned is stored by the caller; row version from the lock', async () => {
    const m = make([row(id(1), { status: 'verified' })]);
    const r = await returnResult(m.ctx, ret(id(1), { comment: 'check dilution' }));
    expect(r).toMatchObject({ id: id(1), status: 'resulted' });
    expect(m.calls('applyReturn')).toHaveLength(1);
    expect(m.calls('applyReturn')[0]).toMatchObject({ tenantId: TENANT, tx: m.tx, arg: { resultId: id(1), expectedRowVersion: 4, reasonCode: 'RECHECK', comment: 'check dilution', membershipId: MEMBERSHIP, occurredAt: NOW.toISOString() } });
    expect(m.asked).toEqual([{ permission: 'lab.result.verify', centreId: CENTRE }]);
  });
  it('the specimen roll-up is recomputed after the return (S15: the specimen drops)', async () => {
    const m = make([row(id(1), { status: 'verified' })]);
    await returnResult(m.ctx, ret(id(1)));
    expect(m.calls('rollupSpecimen').map((c) => c.arg)).toEqual([SPEC1]);
    expect(m.log.findIndex((l) => l.fn === 'rollupSpecimen')).toBeGreaterThan(m.log.findIndex((l) => l.fn === 'applyReturn'));
  });
  it('specimen-less result: no roll-up', async () => {
    const m = make([row(id(1), { status: 'verified', specimenId: undefined })]);
    await returnResult(m.ctx, ret(id(1)));
    expect(m.calls('rollupSpecimen')).toHaveLength(0);
  });
  it('R5 has no event (03-IC §10.2): nothing is published', async () => {
    const m = make([row(id(1), { status: 'verified' })]);
    await returnResult(m.ctx, ret(id(1)));
    expect(m.emitted).toHaveLength(0);
  });
  it.each(['pending', 'resulted', 'approved', 'cancelled'])('status %s -> 409 lab.result_invalid_transition (only verified can be returned)', async (status) => {
    const m = make([row(id(1), { status })]);
    expect((await fail(returnResult(m.ctx, ret(id(1))))).code).toBe('lab.result_invalid_transition');
    expect(m.calls('applyReturn')).toHaveLength(0);
  });
  it('a reason code that is not an active lab.return_reasons code -> 400 common.validation_failed at /reason_code; nothing written', async () => {
    const m = make([row(id(1), { status: 'verified' })], { returnReasonOk: false });
    const e = await fail(returnResult(m.ctx, ret(id(1), { reasonCode: 'NOPE' })));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors?.[0]?.path).toBe('/reason_code');
    expect(m.calls('applyReturn')).toHaveLength(0);
    expect(m.calls('returnReasonActive')[0]).toMatchObject({ tenantId: TENANT, arg: 'NOPE' });
  });
  it('stale version -> common.version_conflict; unknown id -> common.not_found; no role at the centre -> common.not_found (P-01/P-02)', async () => {
    const m = make([row(id(1), { status: 'verified' })]);
    expect((await fail(returnResult(m.ctx, ret(id(1), { version: 2 })))).code).toBe('common.version_conflict');
    expect((await fail(returnResult(m.ctx, ret(id(9))))).code).toBe('common.not_found');
    const f = make([row(id(1), { status: 'verified' })], { assertRole: forbidden });
    expect((await fail(returnResult(f.ctx, ret(id(1))))).code).toBe('common.not_found');
    expect(f.calls('applyReturn')).toHaveLength(0);
  });
  it('S-03: the return call carries no value columns', async () => {
    const m = make([row(id(1), { status: 'verified' })]);
    await returnResult(m.ctx, { ...ret(id(1)), valueNumeric: '1' } as never);
    expect(Object.keys(m.calls('applyReturn')[0]!.arg).join(',')).not.toMatch(/value|ordinal/i);
  });
});

describe('T-16 AC-15.5 + CR-C9-004 + 08 A17.1: auto-verify hook behind LIMS_LAB_AUTOVERIFY_HOOK_ENABLED', () => {
  const allow = { decision: 'allow', reasons: [], ruleSetVersion: 'rs-7' };
  it('flag false (Phase-1 default): QualityPort.canAutoVerify is NOT called and nothing is verified', async () => {
    const m = make([instrumentRow(id(1))], { hookEnabled: false, decision: allow });
    const r = await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    expect(r.verified).toBe(false);
    expect(m.auto).toHaveLength(0); expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('flag true: called for an instrument-origin save regardless of the tenant autoVerificationEnabled switch (CR-C9-004), with the ResultContext of 03-IC §4.11', async () => {
    for (const tenantSwitch of [false, true]) {
      const m = make([instrumentRow(id(1), { flag: 'H', valueNumeric: '17.2', instrumentFlags: ['E01'], deltaStatus: 'fail', isCritical: false })], { hookEnabled: true, tenantSwitch });
      await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
      expect(m.auto, `switch ${tenantSwitch}`).toHaveLength(1);
      expect(m.auto[0].rc).toEqual({
        resultId: id(1), analyteId: 'a-HB', instrumentId: INSTR, valueNumeric: '17.2', instrumentFlags: ['E01'], rangeFlag: 'H', deltaCheckFailed: true, isCritical: false,
        resultedAt: new Date('2026-06-15T04:00:00Z').toISOString(),
      });
    }
  });
  it('fake allow -> R4 mode auto: verification stored without a membership, rule-set version kept, event mode auto WITHOUT verified_by_membership_id (D-2), roll-up runs', async () => {
    const m = make([instrumentRow(id(1))], { hookEnabled: true, decision: allow, actor: { type: 'system', id: ACTOR } });
    const r = await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    expect(r).toMatchObject({ verified: true, result: { id: id(1), status: 'verified' } });
    expect(m.verifies()).toEqual([{ resultId: id(1), expectedRowVersion: 4, mode: 'auto', acknowledgedFlags: [], ruleSetVersion: 'rs-7', occurredAt: NOW.toISOString() }]);
    expect('membershipId' in m.verifies()[0]).toBe(false);
    const [e] = m.verifiedEvents();
    expect(m.verifiedEvents()).toHaveLength(1);
    expect(e!.input.payload).toMatchObject({ result_id: id(1), mode: 'auto', origin: 'instrument', instrument_id: INSTR, specimen_id: SPEC1, verified_at: NOW.toISOString() });
    expect('verified_by_membership_id' in e!.input.payload).toBe(false);
    expect(e!.input.idempotencyKey).toBe(`${id(1)}:verified:1:5`);
    expect(m.calls('rollupSpecimen').map((c) => c.arg)).toEqual([SPEC1]);
    expect(m.asked).toHaveLength(0);   // system actor: no user role check
  });
  it('auto path for a specimen-less result omits specimen_id and verified_by_membership_id both', async () => {
    const m = make([instrumentRow(id(1), { specimenId: undefined })], { hookEnabled: true, decision: allow });
    await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    const p = m.verifiedEvents()[0]!.input.payload;
    expect('specimen_id' in p).toBe(false); expect('verified_by_membership_id' in p).toBe(false); expect(p.mode).toBe('auto');
  });
  it('flag true + fake deny/feature_disabled (tenant switch off) -> the result stays resulted: no verification, no event', async () => {
    const m = make([instrumentRow(id(1))], { hookEnabled: true, decision: { decision: 'deny', reasons: ['feature_disabled'] } });
    const r = await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    expect(r.verified).toBe(false);
    expect(m.auto).toHaveLength(1); expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('a critical / delta-failed / flagged result is still offered to the port (C9 decides), and auto-verifies only on allow', async () => {
    const m = make([instrumentRow(id(1), { isCritical: true, deltaStatus: 'fail', instrumentFlags: ['E01'] })], { hookEnabled: true, decision: { decision: 'deny', reasons: ['critical'] } });
    await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    expect(m.auto).toHaveLength(1);
    expect(m.auto[0].rc).toMatchObject({ isCritical: true, deltaCheckFailed: true, instrumentFlags: ['E01'] });
    expect(m.verifies()).toHaveLength(0);
  });
  it('08 A17.1: range_unavailable_age_unknown -> canAutoVerify is NEVER called and the result is never auto-verified, even though the fake would allow', async () => {
    const m = make([instrumentRow(id(1), { rangeUnavailableAgeUnknown: true })], { hookEnabled: true, decision: allow });
    const r = await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    expect(r.verified).toBe(false);
    expect(m.auto).toHaveLength(0); expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it.each([
    ['on hold', { onHold: true }],
    ['unit mismatch', { unitMismatch: true }],
    ['manual origin', { origin: 'manual', instrumentId: undefined }],
    ['calculated origin', { origin: 'calculated', instrumentId: undefined }],
    ['module origin', { origin: 'module', instrumentId: undefined }],
    ['already verified', { status: 'verified' }],
    ['still pending', { status: 'pending' }],
    ['approved', { status: 'approved' }],
  ])('not offered to the port: %s', async (_n, over) => {
    const m = make([instrumentRow(id(1), over)], { hookEnabled: true, decision: allow });
    const r = await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    expect(r.verified).toBe(false);
    expect(m.auto).toHaveLength(0); expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('fail closed: a QualityPort failure never verifies the result', async () => {
    const m = make([instrumentRow(id(1))], { hookEnabled: true, decision: allow, canAutoVerifyThrows: new Error('quality down') });
    await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) }).catch(() => undefined);
    expect(m.verifies()).toHaveLength(0); expect(m.emitted).toHaveLength(0);
  });
  it('unknown / invisible result id -> nothing happens (the port is not called)', async () => {
    const m = make([], { hookEnabled: true, decision: allow });
    await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) }).catch(() => undefined);
    expect(m.auto).toHaveLength(0); expect(m.verifies()).toHaveLength(0);
  });
  it('store calls of the hook carry ctx.tx and ctx.tenantId (REQ-SEC-024)', async () => {
    const m = make([instrumentRow(id(1))], { hookEnabled: true, decision: allow });
    await autoVerifyAfterInstrumentSave(m.ctx, { resultId: id(1) });
    for (const l of m.log) { expect(l.tenantId, l.fn).toBe(TENANT); expect(l.tx, l.fn).toBe(m.tx); }
  });
});
