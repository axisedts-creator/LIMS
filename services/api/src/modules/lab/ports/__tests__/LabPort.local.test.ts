// C5 T-24 — C5-local LabPort cases beyond the shared suite, real impl + real PG17 under RLS (harness: ./harness.ts, ./labPort.harness.ts).
// Covers: 08 A17.2-a/b + AC-05.8/05.10 (getOrderItemProcessingState), AC-17.5 + 08 R1/A17 D-61 guard matrix, AC-17.6 (verified resubmission = system R5 module_resubmitted + R3, versionNo = current_version_no),
// AC-19.4 (holdResultsSince idempotency, counts), AC-14.6 + CR-C7-011 (replay re-evaluates open exceptions), host query (02-TRD §6.1, S6 pick-up, P-09), listPendingForInstrument, lookupSpecimens,
// getAnalyteHistory, getOrderResults, validation, non-staff actors, concurrency (many callers), no PHI in outputs/errors (07-SECURITY S-17, S-20, S-21, S-22, P-09).
// Needs the database of tests/db/c5-t03/run.sh. Fails now: ../LabPort.impl.ts does not exist.
// ASSUMED (spec silent): unknown amendment code / malformed input -> a LimsError common.validation_failed or lab.module_result_invalid (never a raw pg error); host query for an instrument with no outbound maps -> tests: [].
import { afterAll, describe, expect, it, vi } from 'vitest';
import { asAdmin, closePools, L, live, q, requireDb, TENANT } from './harness.js';
import { realLabPortHarness, type RealHarness } from './labPort.harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
afterAll(closePools);
const make = realLabPortHarness();

describe('T-24 local harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); });
});

// ---------------------------------------------------------------- ids and fixture builders (namespace of ./harness.ts NS)
const A = TENANT.A, B = TENANT.B;
const CEN = L(204), CEN2 = L(206), CENB = L(205), INS = L(207), INS2 = L(208), DEP = L(209);
const T_STD = L(210), T_MIC = L(211), T_ANA = L(212);
const AN1 = L(213), AN2 = L(214), AN3 = L(215), ANM = L(216);
const P = L(201), P2 = L(202), PB = L(203);
const NOW = '2026-11-05T04:15:00.000Z';
const ord = (id: string, patientId = P, tenantId = A, centreId = CEN) => ({ id, tenantId, patientId, centreId, priority: 'routine', patient: { sex: 'female', ageDays: 12000 } });
const item = (id: string, orderId: string, workflowType = 'standard', testId = T_STD, extra: Record<string, unknown> = {}) => ({ id, tenantId: A, orderId, testId, departmentId: DEP, workflowType, ...extra });
const spec = (id: string, orderId: string, barcode: string, status: string, itemIds: string[], extra: Record<string, unknown> = {}) =>
  ({ id, tenantId: A, orderId, barcode, specimenTypeCode: 'BLOOD', status, itemIds, version: 1, ...extra });
const res = (id: string, orderItemId: string, analyteId: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, tenantId: A, orderItemId, testId: T_STD, analyteId, versionNo: 1, status, origin: 'manual', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
     ...(status === 'approved' ? { approvedAt: '2026-11-01T05:00:00.000Z' } : {}), ...extra });
const mod = (module: 'micro' | 'anatomic', entityId: string, phase: 'preliminary' | 'final') => ({ moduleRef: { module, entityId, versionNo: 1 }, lastPhase: phase, lastPayloadVersion: 1 });
const BASE = (h: RealHarness) => ({
  grants: {
    [h.ctxFor('A:user:reader').actor.id]: ['lab.result.read'],
    [h.ctxFor('A:user:amender').actor.id]: ['lab.result.amend', 'lab.result.read'],
    [h.ctxFor('A:user:spec').actor.id]: ['lab.specimen.read'],
    [h.ctxFor('A:user:hc').actor.id]: ['homecollection.visit.read'],
    [h.ctxFor('A:user:orderread').actor.id]: ['frontdesk.order.read'],
    [h.ctxFor('A:user:orderedit').actor.id]: ['frontdesk.order.edit'],
  },
  mappings: [AN1, AN2].map((analyteId, i) => ({ id: L(100 + i), tenantId: A, instrumentId: INS, instrumentCode: `C${i}`, analyteId, testId: T_STD })),
  criticalLimits: [{ id: L(110), tenantId: A, analyteId: AN2, low: '2.0', high: '30.0' }],
  qcHolds: [] as unknown[],
});
type Fx = { orders?: any[]; items?: any[]; specimens?: any[]; results?: any[] };
async function boot(fx: Fx): Promise<RealHarness> {
  const h = await make();
  await h.seed({ ...BASE(h), orders: [], items: [], specimens: [], results: [], ...fx });
  return h;
}
const sys = (h: RealHarness, t: 'A' | 'B' = 'A') => h.ctxFor(`${t}:system`);
const code = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; return undefined; } catch (e: any) { return e?.code; } };
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };
const moduleInput = (orderItemId: string, module: 'micro' | 'anatomic', entityId: string, versionNo: number, extra: Record<string, unknown> = {}) =>
  ({ orderItemId, kind: 'narrative', reportPhase: 'final', payloadRef: { module, entityId, versionNo }, summaryText: 'Synthetic summary', submittedAt: NOW, idempotencyKey: `${module}:${entityId}:${versionNo}`, ...extra });
const ingestInput = (barcode: string, analyteId: string | undefined, value: string, extra: Record<string, unknown> = {}, msg = L(231)) => ({
  instrumentMessageId: msg, instrumentId: INS, agentId: L(232), centreId: CEN, protocol: 'astm', sampleBarcode: barcode, recordKind: 'quantitative', instrumentAnalyteCode: `X-${analyteId ?? 'none'}`,
  mappingStatus: analyteId ? 'mapped' : 'unmapped', ...(analyteId ? { analyteId, testId: T_STD } : {}), valueNumeric: value, instrumentResultTime: '2026-11-05T04:00:00.000Z', receivedAt: NOW, ...extra });
const resultRow = async (id: string) => (await q('SELECT * FROM lab.results WHERE id = $1', [id]))[0];
const COUNT = async (sql: string, v: unknown[]) => Number((await q(sql, v))[0].c);
const SAFE_REJECT = /^(common\.validation_failed|lab\.module_result_invalid)$/;

// ================================================================ A17.2 / AC-05.8 / AC-05.10
describe.skipIf(!live)('getOrderItemProcessingState (08 A13 D-5, A17.2; AC-05.8, AC-05.10)', () => {
  const O = { a: L(60 + 0x80), b: L(61 + 0x80), c: L(62 + 0x80), d: L(63 + 0x80) };
  const I = { a: L(70 + 0x80), b: L(71 + 0x80), c1: L(72 + 0x80), c2: L(73 + 0x80), d: L(74 + 0x80), v: L(75 + 0x80) };
  const fx = (): Fx => ({
    orders: [ord(O.a), ord(O.b), ord(O.c), ord(O.d), ord(L(0xe5), PB, B, CENB)],
    items: [item(I.a, O.a, 'anatomic', T_ANA), item(I.b, O.b), item(I.c1, O.c), item(I.c2, O.c, 'anatomic', T_ANA), item(I.d, O.d, 'anatomic', T_ANA), item(I.v, O.d, 'anatomic', T_ANA)],
    specimens: [spec(L(0x90), O.b, 'SYN-S0B', 'collected', [I.b]), spec(L(0x91), O.c, 'SYN-S0C', 'received', [I.c1])],
    results: [
      res(L(0x92), I.a, AN1, 'resulted', { testId: T_ANA }), res(L(0x93), I.b, AN1, 'pending'),
      res(L(0x94), I.c1, AN1, 'resulted'), res(L(0x95), I.c2, AN1, 'resulted', { testId: T_ANA }),
      res(L(0x96), I.d, AN1, 'pending', { testId: T_ANA }), res(L(0x97), I.v, AN1, 'approved', { testId: T_ANA }),
    ],
  });
  const state = async (h: RealHarness, orderId: string) => Object.fromEntries((await h.impl.getOrderItemProcessingState(sys(h), { orderId })).map((x: any) => [x.orderItemId, x]));

  it('(A17.2-a) existing-material item (no specimen) with a resulted result -> removable false, result_entered, in_progress (not not_started)', async () => {
    const h = await boot(fx());
    expect((await state(h, O.a))[I.a]).toEqual({ orderItemId: I.a, removable: false, reasonCode: 'result_entered', processingStatus: 'in_progress' });
  });
  it('(A17.2-b) item with no received specimen and only pending results -> removable true, not_started, no reasonCode', async () => {
    const h = await boot(fx());
    const r = (await state(h, O.b))[I.b];
    expect(r).toMatchObject({ orderItemId: I.b, removable: true, processingStatus: 'not_started' });
    expect(r).not.toHaveProperty('reasonCode');
  });
  it('existing-material item with only a pending result -> removable true, not_started; one with an approved result -> result_entered (resulted OR LATER), still in_progress until reported', async () => {
    const h = await boot(fx());
    const s = await state(h, O.d);
    expect(s[I.d]).toMatchObject({ removable: true, processingStatus: 'not_started' });
    expect(s[I.v]).toMatchObject({ removable: false, reasonCode: 'result_entered', processingStatus: 'in_progress' });
  });
  it('precedence: received specimen AND resulted result -> specimen_received; the specimen-less sibling in the same order -> result_entered', async () => {
    const h = await boot(fx());
    const s = await state(h, O.c);
    expect(s[I.c1]).toMatchObject({ removable: false, reasonCode: 'specimen_received', processingStatus: 'in_progress' });
    expect(s[I.c2]).toMatchObject({ removable: false, reasonCode: 'result_entered', processingStatus: 'in_progress' });
  });
  it('AC-05.8: the rejected-without-recollection item is removable: true / cancelled and its cancelled result does not make it non-removable', async () => {
    const o = L(0xa0), i = L(0xa1);
    const h = await boot({ orders: [ord(o)], items: [item(i, o)], specimens: [spec(L(0xa2), o, 'SYN-S0R', 'rejected', [i])], results: [res(L(0xa3), i, AN1, 'cancelled')] });
    expect((await state(h, o))[i]).toMatchObject({ removable: true, processingStatus: 'cancelled' });
  });
  it('callers: frontdesk.order.read, frontdesk.order.edit and system pass; no grant, device, patient, portal, partner -> auth.forbidden; other tenant / unknown order -> common.not_found; no PHI in the output', async () => {
    const h = await boot(fx());
    const input = { orderId: O.b };
    for (const k of ['A:user:orderread', 'A:user:orderedit', 'A:system']) expect(await code(h.impl.getOrderItemProcessingState(h.ctxFor(k), input)), k).toBeUndefined();
    for (const k of ['A', 'A:user:reader', 'A:device', 'A:patient', 'A:portal', 'A:partner']) expect(await code(h.impl.getOrderItemProcessingState(h.ctxFor(k), input)), k).toBe('auth.forbidden');
    expect(await code(h.impl.getOrderItemProcessingState(sys(h), { orderId: L(0xe5) }))).toBe('common.not_found');
    expect(await code(h.impl.getOrderItemProcessingState(sys(h), { orderId: L(0xef) }))).toBe('common.not_found');
    const out = await h.impl.getOrderItemProcessingState(sys(h), input);
    for (const r of out) expect(Object.keys(r).every((k) => ['orderItemId', 'removable', 'reasonCode', 'processingStatus'].includes(k))).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/SYN-S0B|SYNS0B/);
  });
});

// ================================================================ submitModuleResult: AC-17.6, AC-17.5, validation
describe.skipIf(!live)('submitModuleResult (AC-17.5, AC-17.6; 08 R1, A13 D-7, A17 D-61)', () => {
  const o = L(0xb0);
  const I = { ver: L(0xb1), gp: L(0xb2), gf: L(0xb3), ga: L(0xb4), pend: L(0xb5) };
  const R = { ver: L(0xc1), gp: L(0xc2), gf: L(0xc3), ga: L(0xc4), pend: L(0xc5) };
  const E = { ver: L(0xd1), gp: L(0xd2), gf: L(0xd3), ga: L(0xd4), pend: L(0xd5) };
  const fx = (): Fx => ({
    orders: [ord(o)],
    items: [item(I.ver, o, 'microbiology', T_MIC), item(I.gp, o, 'microbiology', T_MIC), item(I.gf, o, 'microbiology', T_MIC), item(I.ga, o, 'anatomic', T_ANA), item(I.pend, o, 'microbiology', T_MIC)],
    results: [
      res(R.ver, I.ver, ANM, 'verified', { testId: T_MIC, ...mod('micro', E.ver, 'final'), verifiedAt: '2026-11-04T00:00:00.000Z' }),
      res(R.gp, I.gp, ANM, 'approved', { testId: T_MIC, ...mod('micro', E.gp, 'preliminary') }),
      res(R.gf, I.gf, ANM, 'approved', { testId: T_MIC, ...mod('micro', E.gf, 'final') }),
      res(R.ga, I.ga, ANM, 'approved', { testId: T_ANA, ...mod('anatomic', E.ga, 'final') }),
      res(R.pend, I.pend, ANM, 'pending', { testId: T_MIC }),
    ],
  });

  it('AC-17.6: on a verified result: system R5 (verification kind returned, mode system, reason module_resubmitted) + R3 in one tx; verification cleared; no result_versions row; versionNo = current_version_no (1)', async () => {
    const h = await boot(fx());
    const out = await h.impl.submitModuleResult(sys(h), moduleInput(I.ver, 'micro', E.ver, 2));
    expect(out).toEqual({ resultId: R.ver, versionNo: 1, status: 'resulted', replayed: false });
    const r = await resultRow(R.ver);
    expect(r).toMatchObject({ status: 'resulted', current_version_no: 1, origin: 'module', module_payload_version_no: 2 });
    expect(r.verified_at).toBeNull();
    expect(r.verified_by_membership_id).toBeNull();
    const v = await q(`SELECT * FROM lab.verifications WHERE result_id = $1 AND kind = 'returned'`, [R.ver]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ mode: 'system', reason_code: 'module_resubmitted', membership_id: null });
    expect(await COUNT('SELECT count(*) AS c FROM lab.result_versions WHERE result_id = $1', [R.ver])).toBe(0);
    expect(await q('SELECT output_version_no, output_status FROM lab.module_submissions WHERE result_id = $1', [R.ver])).toEqual([{ output_version_no: 1, output_status: 'resulted' }]);
    expect(h.events.ofType('lab.result.amended.v1')).toHaveLength(0);
    expect(h.events.ofType('lab.result.approved.v1')).toHaveLength(0);
  });

  it('AC-17.5/AC-17.6: amendment of an approved result = result_versions v2 (reason + previous version), v1 superseded, approvals kind amendment, results.current_version_no 2 = output versionNo, locked row values unchanged', async () => {
    const h = await boot(fx());
    const before = await resultRow(R.gp);
    const out = await h.impl.submitModuleResult(h.ctxFor('A:user:amender'), moduleInput(I.gp, 'micro', E.gp, 2, { reportPhase: 'preliminary', amendment: { reasonCode: 'correction', reasonText: 'Synthetic reason' } }));
    expect(out).toMatchObject({ resultId: R.gp, versionNo: 2, status: 'approved', replayed: false });
    const r = await resultRow(R.gp);
    expect(r).toMatchObject({ status: 'approved', current_version_no: 2 });
    expect(r.value_numeric).toBe(before.value_numeric);
    const vs = await q('SELECT * FROM lab.result_versions WHERE result_id = $1 ORDER BY version_no', [R.gp]);
    expect(vs.map((x) => x.version_no)).toEqual([1, 2]);
    expect(vs[0].superseded_by_version_no).toBe(2);
    expect(vs[1]).toMatchObject({ previous_version_no: 1, amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic reason', origin: 'module', module_report_phase: 'preliminary', module_payload_version_no: 2 });
    expect((await q('SELECT kind FROM lab.approvals WHERE result_id = $1 AND version_no = 2', [R.gp])).map((x) => x.kind)).toEqual(['amendment']);
    expect(h.events.ofType('lab.result.amended.v1')[0]!.payload).toMatchObject({ result_id: R.gp, previous_version_no: 1, new_version_no: 2, amendment_reason_code: 'correction' });
  });

  // [item, module, phase, reasonCode, entity, expected]  (08 R1 + D-61 guard matrix; S-21)
  const MATRIX: [string, 'gp' | 'gf' | 'ga', 'micro' | 'anatomic', 'preliminary' | 'final', string, 'ok' | 'invalid'][] = [
    ['micro prelim -> final with module_phase_progression', 'gp', 'micro', 'final', 'module_phase_progression', 'ok'],
    ['micro prelim -> prelim with module_phase_progression', 'gp', 'micro', 'preliminary', 'module_phase_progression', 'invalid'],
    ['micro prelim -> prelim with module_preliminary_update', 'gp', 'micro', 'preliminary', 'module_preliminary_update', 'ok'],
    ['micro prelim -> final with module_preliminary_update', 'gp', 'micro', 'final', 'module_preliminary_update', 'invalid'],
    ['micro prelim -> final with correction (any phase)', 'gp', 'micro', 'final', 'correction', 'ok'],
    ['micro FINAL -> prelim with module_preliminary_update (replaced version was final)', 'gf', 'micro', 'preliminary', 'module_preliminary_update', 'invalid'],
    ['micro FINAL -> final with module_phase_progression (replaced version was final)', 'gf', 'micro', 'final', 'module_phase_progression', 'invalid'],
    ['micro with supplementary_report', 'gf', 'micro', 'final', 'supplementary_report', 'invalid'],
    ['anatomic with supplementary_report', 'ga', 'anatomic', 'final', 'supplementary_report', 'ok'],
    ['anatomic with module_preliminary_update', 'ga', 'anatomic', 'preliminary', 'module_preliminary_update', 'invalid'],
    ['anatomic with module_phase_progression', 'ga', 'anatomic', 'final', 'module_phase_progression', 'invalid'],
  ];
  for (const [title, key, module, phase, reason, expected] of MATRIX) {
    it(`guard: ${title} -> ${expected === 'ok' ? 'version 2 + amended event carrying the code' : 'lab.module_result_invalid, nothing written'}`, async () => {
      const h = await boot(fx());
      const itm = I[key], rid = R[key], ent = E[key];
      const input = moduleInput(itm, module, ent, 2, { reportPhase: phase, amendment: { reasonCode: reason } });
      const call = h.impl.submitModuleResult(h.ctxFor('A:user:amender'), input);
      if (expected === 'ok') {
        expect((await call).versionNo).toBe(2);
        expect(h.events.ofType('lab.result.amended.v1')[0]!.payload.amendment_reason_code).toBe(reason);
      } else {
        expect(await code(call)).toBe('lab.module_result_invalid');
        expect((await resultRow(rid)).current_version_no).toBe(1);
        expect(await COUNT('SELECT count(*) AS c FROM lab.result_versions WHERE result_id = $1 AND version_no = 2', [rid])).toBe(0);
        expect(await COUNT('SELECT count(*) AS c FROM lab.module_submissions WHERE result_id = $1', [rid])).toBe(0);
        expect(h.events.ofType('lab.result.amended.v1')).toHaveLength(0);
      }
    });
  }

  it('AC-17.5: lab.result.amend is still required for module_preliminary_update (plain user, reader -> lab.result_locked; nothing written)', async () => {
    const h = await boot(fx());
    const input = moduleInput(I.gp, 'micro', E.gp, 2, { reportPhase: 'preliminary', amendment: { reasonCode: 'module_preliminary_update' } });
    for (const k of ['A', 'A:user:reader']) expect(await code(h.impl.submitModuleResult(h.ctxFor(k), input)), k).toBe('lab.result_locked');
    expect((await resultRow(R.gp)).current_version_no).toBe(1);
    expect(h.events.ofType('lab.result.amended.v1')).toHaveLength(0);
  });

  it('an unknown amendment reason is rejected cleanly (LimsError, not a raw pg error) and writes nothing; on a NON-approved result `amendment` is ignored', async () => {
    const h = await boot(fx());
    const e = await fail(h.impl.submitModuleResult(h.ctxFor('A:user:amender'), moduleInput(I.gp, 'micro', E.gp, 2, { amendment: { reasonCode: 'no_such_code' } })));
    expect(e.code).toMatch(SAFE_REJECT);
    expect((await resultRow(R.gp)).current_version_no).toBe(1);
    const ok = await h.impl.submitModuleResult(sys(h), moduleInput(I.pend, 'micro', E.pend, 1, { amendment: { reasonCode: 'no_such_code' } }));
    expect(ok).toMatchObject({ status: 'resulted', versionNo: 1 });
    expect(h.events.ofType('lab.result.amended.v1')).toHaveLength(0);
  });

  it('validation: summary > 4000 chars, reason text > 500, bad phase / kind / module -> LimsError (validation_failed or module_result_invalid), nothing written', async () => {
    const h = await boot(fx());
    const bad: Record<string, unknown>[] = [{ summaryText: 'x'.repeat(4001) }, { reportPhase: 'bogus' }, { kind: 'bogus' }, { payloadRef: { module: 'bogus', entityId: E.pend, versionNo: 1 } }];
    for (const extra of bad) expect((await fail(h.impl.submitModuleResult(sys(h), moduleInput(I.pend, 'micro', E.pend, 1, extra)))).code, JSON.stringify(Object.keys(extra))).toMatch(SAFE_REJECT);
    const e = await fail(h.impl.submitModuleResult(h.ctxFor('A:user:amender'), moduleInput(I.gp, 'micro', E.gp, 2, { amendment: { reasonCode: 'correction', reasonText: 'y'.repeat(501) } })));
    expect(e.code).toMatch(SAFE_REJECT);
    expect(await COUNT('SELECT count(*) AS c FROM lab.module_submissions WHERE result_id IN ($1, $2)', [R.pend, R.gp])).toBe(0);
  });

  it('injection: a hostile summaryText is stored verbatim (parameterised), the table survives', async () => {
    const h = await boot(fx());
    const evil = "x'); DROP TABLE lab.results; --";
    await h.impl.submitModuleResult(sys(h), moduleInput(I.pend, 'micro', E.pend, 1, { summaryText: evil }));
    expect((await resultRow(R.pend)).module_summary_text).toBe(evil);
  });

  it('actors: patient / portal / partner -> auth.forbidden', async () => {
    const h = await boot(fx());
    for (const k of ['A:patient', 'A:portal', 'A:partner']) expect(await code(h.impl.submitModuleResult(h.ctxFor(k), moduleInput(I.pend, 'micro', E.pend, 1))), k).toBe('auth.forbidden');
  });

  it('many callers: the same idempotencyKey twice at once -> one replayed:false + one replayed:true, one module_submissions row, no raw unique-violation', async () => {
    const h = await boot(fx());
    const input = moduleInput(I.pend, 'micro', E.pend, 1);
    const [a, b] = await Promise.all([h.call('submitModuleResult', sys(h), input), h.call('submitModuleResult', sys(h), input)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.resultId).toBe(b.resultId);
    expect(await COUNT('SELECT count(*) AS c FROM lab.module_submissions WHERE result_id = $1', [R.pend])).toBe(1);
  });

  it('many callers: payload versions 2 and 3 at once -> each succeeds or is lab.module_result_stale (never a raw error); the stored payload version is the highest that succeeded', async () => {
    const h = await boot(fx());
    const out = await Promise.allSettled([2, 3].map((v) => h.call('submitModuleResult', sys(h), moduleInput(I.pend, 'micro', E.pend, v))));
    const ok = out.flatMap((x, i) => (x.status === 'fulfilled' ? [i + 2] : []));
    for (const x of out) if (x.status === 'rejected') expect((x.reason as any).code).toBe('lab.module_result_stale');
    expect(ok.length).toBeGreaterThan(0);
    expect((await resultRow(R.pend)).module_payload_version_no).toBe(Math.max(...ok));
  });
});

// ================================================================ holdResultsSince (AC-19.4)
describe.skipIf(!live)('holdResultsSince (AC-19.4; 02-TRD §6.1)', () => {
  const o = L(0xb8), ob = L(0xb9), sp = L(0xba);
  const IH = [1, 2, 3, 4, 5, 6, 7].map((k) => L(0xe0 + k)), RH = [1, 2, 3, 4, 5, 6, 7].map((k) => L(0xf0 + k));
  const RB = L(0xe9), IB = L(0xe8), IN = L(0xd8), RN = L(0xd9), SN = L(0xda);   // IN/RN/SN: a separate pending AN1 line on its own specimen (arrives held)
  const fx = (): Fx => ({
    orders: [ord(o), ord(ob, PB, B, CENB)],
    items: [...IH.map((i) => item(i, o)), item(IN, o), { ...item(IB, ob), tenantId: B }],
    specimens: [spec(sp, o, 'SYN-H0001', 'received', IH), spec(SN, o, 'SYN-H0002', 'received', [IN])],
    results: [
      res(RN, IN, AN1, 'pending'),
      res(RH[0]!, IH[0]!, AN1, 'resulted', { instrumentId: INS, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }),
      res(RH[1]!, IH[1]!, AN2, 'verified', { instrumentId: INS, resultedAt: '2026-11-04T02:00:00.000Z', valueNumeric: '7.0', verifiedAt: '2026-11-04T03:00:00.000Z' }),
      res(RH[2]!, IH[2]!, AN1, 'approved', { instrumentId: INS, resultedAt: '2026-11-04T03:00:00.000Z', approvedAt: '2026-11-04T04:00:00.000Z', valueNumeric: '13.0' }),
      res(RH[3]!, IH[3]!, AN1, 'pending'),
      res(RH[4]!, IH[4]!, AN1, 'resulted', { instrumentId: INS, resultedAt: '2026-10-01T01:00:00.000Z', valueNumeric: '12.0' }),
      res(RH[5]!, IH[5]!, AN1, 'resulted', { instrumentId: INS2, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }),
      res(RH[6]!, IH[6]!, AN3, 'resulted', { instrumentId: INS, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }),
      { ...res(RB, IB, AN1, 'resulted', { instrumentId: INS, resultedAt: '2026-11-04T01:00:00.000Z', valueNumeric: '12.0' }), tenantId: B },
    ],
  });
  const input = { instrumentId: INS, analyteIds: [AN1, AN2], since: '2026-11-01T00:00:00.000Z', qcRunId: L(0xe7), reasonCode: 'qc_failure' };

  it('holds resulted/verified, flags approved, ignores pending / before-since / other instrument / unlisted analyte / other tenant; one qc_holds row; replay = same lists, rows untouched', async () => {
    const h = await boot(fx());
    const a = await h.impl.holdResultsSince(sys(h), input);
    expect([[...a.heldResultIds].sort(), [...a.reviewFlaggedResultIds].sort()]).toEqual([[RH[0], RH[1]].sort(), [RH[2]]]);
    const versions = Object.fromEntries((await q('SELECT id, version FROM lab.results WHERE id = ANY($1)', [[...RH, RB]])).map((r) => [r.id, r.version]));
    const b = await h.impl.holdResultsSince(sys(h), input);
    expect([[...b.heldResultIds].sort(), [...b.reviewFlaggedResultIds].sort()]).toEqual([[...a.heldResultIds].sort(), [...a.reviewFlaggedResultIds].sort()]);
    const holds = await q('SELECT * FROM lab.qc_holds WHERE qc_run_id = $1', [input.qcRunId]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'active', instrument_id: INS, reason_code: 'qc_failure', tenant_id: A });
    expect([...holds[0].held_result_ids].sort()).toEqual([RH[0], RH[1]].sort());
    expect(holds[0].review_flagged_result_ids).toEqual([RH[2]]);
    const rows = Object.fromEntries((await q('SELECT id, version, on_hold, hold_id, qc_review_required FROM lab.results WHERE id = ANY($1)', [[...RH, RB]])).map((r) => [r.id, r]));
    for (const id of [RH[0]!, RH[1]!]) expect(rows[id]).toMatchObject({ on_hold: true, hold_id: holds[0].id, qc_review_required: false });
    expect(rows[RH[2]!]).toMatchObject({ on_hold: false, qc_review_required: true });
    for (const id of [RH[3]!, RH[4]!, RH[5]!, RH[6]!, RB]) expect(rows[id], id).toMatchObject({ on_hold: false, hold_id: null, qc_review_required: false });
    for (const id of RH.slice(0, 3)) expect(rows[id]!.version, `replay must not rewrite ${id}`).toBe(versions[id]);
  });

  it('a new result for a held (instrument, analyte) pair arrives held: outcome held, result resulted + on_hold', async () => {
    const h = await boot(fx());
    await h.impl.holdResultsSince(sys(h), input);
    const r = await h.impl.ingestInstrumentResult(h.ctxFor('A:device'), ingestInput('SYN-H0002', AN1, '12.50'));
    expect(r).toMatchObject({ outcome: 'held', resultId: RN });
    expect(await resultRow(RN)).toMatchObject({ status: 'resulted', on_hold: true });
  });

  it('tenants: the same qcRunId in tenant B holds only B results and returns no A ids; A rows unchanged', async () => {
    const h = await boot(fx());
    await h.impl.holdResultsSince(sys(h), input);
    const b = await h.impl.holdResultsSince(sys(h, 'B'), input);
    expect(b).toEqual({ heldResultIds: [RB], reviewFlaggedResultIds: [] });
    expect(await COUNT('SELECT count(*) AS c FROM lab.qc_holds WHERE qc_run_id = $1', [input.qcRunId])).toBe(2);
  });

  it('validation: empty / >100 analyteIds, bad qcRunId -> common.validation_failed; non-staff -> auth.forbidden', async () => {
    const h = await boot(fx());
    for (const bad of [{ ...input, analyteIds: [] }, { ...input, analyteIds: Array.from({ length: 101 }, (_, i) => L(0x30 + (i % 100))) }, { ...input, qcRunId: 'nope' }])
      expect(await code(h.impl.holdResultsSince(sys(h), bad))).toBe('common.validation_failed');
    for (const k of ['A:patient', 'A:portal', 'A:partner']) expect(await code(h.impl.holdResultsSince(h.ctxFor(k), input)), k).toBe('auth.forbidden');
  });

  it('many callers: the same qcRunId twice at once -> identical lists, one hold row, each held result written once', async () => {
    const h = await boot(fx());
    const v0 = (await resultRow(RH[0]!)).version;
    const [a, b] = await Promise.all([h.call('holdResultsSince', sys(h), input), h.call('holdResultsSince', sys(h), input)]);
    expect([...a.heldResultIds].sort()).toEqual([...b.heldResultIds].sort());
    expect(await COUNT('SELECT count(*) AS c FROM lab.qc_holds WHERE qc_run_id = $1 AND tenant_id = $2', [input.qcRunId, A])).toBe(1);
    expect((await resultRow(RH[0]!)).version).toBe(v0 + 1);
  });
});

// ================================================================ ingest + exceptions (AC-14.6, CR-C7-011)
describe.skipIf(!live)('ingestInstrumentResult exceptions (AC-14.6; CR-C7-011; CR-C5-008)', () => {
  const o1 = L(0x3c0), o2 = L(0x3c1), ob = L(0x3c2);
  const I1 = L(0x3c3), I2 = L(0x3c4), IB = L(0x3c5);
  const fx = (): Fx => ({
    orders: [ord(o1), ord(o2), ord(ob, PB, B, CENB)],
    items: [item(I1, o1), item(I2, o2), { ...item(IB, ob), tenantId: B }],
    specimens: [spec(L(0x3c6), o1, 'SYN-I0001', 'received', [I1]), spec(L(0x3c7), o2, 'SYN-I0002', 'received', [I2])],
    results: [res(L(0x3c8), I1, AN1, 'pending'), res(L(0x3c9), I2, AN1, 'approved', { valueNumeric: '13.40' })],
  });
  const R1 = L(0x3c8), R2 = L(0x3c9);
  const open = (barcode: string, tenant = A) => q(`SELECT * FROM lab.ingest_exceptions WHERE tenant_id = $1 AND sample_barcode = $2 AND status = 'open'`, [tenant, barcode.replace(/-/g, '')]);
  const logOf = (barcode: string, tenant = A) => q('SELECT * FROM lab.ingest_log WHERE tenant_id = $1 AND result_key LIKE $2', [tenant, `%${barcode.replace(/-/g, '')}%`]);

  it('unmapped code: unmatched + ONE open exception (unmapped_code); a second unmatched replay keeps one open exception (attempts 2); rematch applies, resolves it in the same tx, log applied; the original key is then duplicate, no new exception', async () => {
    const h = await boot(fx());
    const key = { instrumentAnalyteCode: 'X-FIXED' };
    const dev = h.ctxFor('A:device');
    expect((await h.impl.ingestInstrumentResult(dev, ingestInput('SYN-I0001', undefined, '12.10', key))).outcome).toBe('unmatched');
    let ex = await open('SYN-I0001');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ reason: 'unmapped_code', status: 'open' });
    expect((await resultRow(R1)).status).toBe('pending');
    expect((await h.impl.ingestInstrumentResult(dev, ingestInput('SYN-I0001', undefined, '12.10', key))).outcome).toBe('unmatched');
    ex = await open('SYN-I0001');
    expect(ex).toHaveLength(1);
    expect(ex[0].attempts).toBe(2);
    const r = await h.impl.ingestInstrumentResult(h.ctxFor('A:user:default'), ingestInput('SYN-I0001', AN1, '12.10', { ...key, processingKind: 'rematch' }));
    expect(r).toMatchObject({ outcome: 'applied', resultId: R1 });
    expect(await open('SYN-I0001')).toHaveLength(0);
    const closed = await q(`SELECT * FROM lab.ingest_exceptions WHERE tenant_id = $1 AND sample_barcode = 'SYNI0001'`, [A]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ status: 'resolved', resolution: 'applied', result_id: R1 });
    expect(closed[0].resolved_at).not.toBeNull();
    expect((await logOf('SYN-I0001')).map((x) => x.last_outcome)).toEqual(['applied']);
    expect(await resultRow(R1)).toMatchObject({ status: 'resulted', origin: 'instrument' });
    expect((await h.impl.ingestInstrumentResult(dev, ingestInput('SYN-I0001', undefined, '12.10', key))).outcome).toBe('duplicate');
    expect(await COUNT(`SELECT count(*) AS c FROM lab.ingest_exceptions WHERE tenant_id = $1 AND sample_barcode = 'SYNI0001'`, [A])).toBe(1);
  });

  it('unknown barcode: unmatched + exception unknown_barcode; after the specimen exists, a replay of the SAME input is applied and the exception is closed (CR-C7-011)', async () => {
    const h = await boot(fx());
    const inp = ingestInput('SYN-I0077', AN1, '12.10', {}, L(0x70));
    expect((await h.impl.ingestInstrumentResult(h.ctxFor('A:device'), inp)).outcome).toBe('unmatched');
    expect((await open('SYN-I0077'))[0]).toMatchObject({ reason: 'unknown_barcode' });
    const o = L(0x71), i = L(0x72), r = L(0x73);   // ids unique to this describe (ruling C5.T-24 #2 item 3): frontdesk parents persist across cleanup()
    await h.seed({ orders: [ord(o)], items: [item(i, o)], specimens: [spec(L(0x74), o, 'SYN-I0077', 'received', [i])], results: [res(r, i, AN1, 'pending')] });
    expect(await h.impl.ingestInstrumentResult(h.ctxFor('A:device'), inp)).toMatchObject({ outcome: 'applied', resultId: r });
    expect(await open('SYN-I0077')).toHaveLength(0);
  });

  it('approved target: rejected_state / result_locked (never throws), value unchanged, ONE open exception result_locked, a replay keeps one', async () => {
    const h = await boot(fx());
    const dev = h.ctxFor('A:device');
    for (let k = 0; k < 2; k++) {
      const r = await h.impl.ingestInstrumentResult(dev, ingestInput('SYN-I0002', AN1, '99.00'));
      expect(r).toMatchObject({ outcome: 'rejected_state', reasonCode: 'result_locked' });
    }
    const ex = await open('SYN-I0002');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ reason: 'result_locked' });
    expect(Number((await resultRow(R2)).value_numeric)).toBe(13.4);
  });

  it('tenant isolation: tenant-B ingest of an A barcode is unmatched in B (exception in B only); A result and A exceptions untouched', async () => {
    const h = await boot(fx());
    const r = await h.impl.ingestInstrumentResult(h.ctxFor('B:device'), { ...ingestInput('SYN-I0001', AN1, '1.00'), centreId: CENB });
    expect(r.outcome).toBe('unmatched');
    expect((await resultRow(R1)).status).toBe('pending');
    expect(await open('SYN-I0001', A)).toHaveLength(0);
    expect((await open('SYN-I0001', B))[0]).toMatchObject({ reason: 'unknown_barcode' });
  });

  it('actors: patient / portal / partner -> auth.forbidden, nothing logged', async () => {
    const h = await boot(fx());
    for (const k of ['A:patient', 'A:portal', 'A:partner']) expect(await code(h.impl.ingestInstrumentResult(h.ctxFor(k), ingestInput('SYN-I0001', AN1, '1.00'))), k).toBe('auth.forbidden');
    expect(await logOf('SYN-I0001')).toHaveLength(0);
  });

  it('many callers: the same key twice at once -> applied + duplicate, one observation row', async () => {
    const h = await boot(fx());
    const inp = ingestInput('SYN-I0001', AN1, '12.10');
    const out = await Promise.all([h.call('ingestInstrumentResult', h.ctxFor('A:device'), inp), h.call('ingestInstrumentResult', h.ctxFor('A:device'), inp)]);
    expect(out.map((x) => x.outcome).sort()).toEqual(['applied', 'duplicate']);
    expect(await COUNT('SELECT count(*) AS c FROM lab.result_observations WHERE result_id = $1', [R1])).toBe(1);
  });
});

// ================================================================ host query + pending list (02-TRD §6.1; P-09)
describe.skipIf(!live)('getPendingTestsForBarcode / listPendingForInstrument (AC-20.1; P-09; S-22)', () => {
  const o = L(0xa8), oz = L(0xa9), ob = L(0xaa), IQ1 = L(0xa4), IQ2 = L(0xa5), IQ3 = L(0xa6), IQ4 = L(0xa7);
  const SQ1 = L(0xab), SQ2 = L(0xac), SQ3 = L(0xad), SZ = L(0xae);
  const fx = (): Fx => ({
    orders: [ord(o), ord(oz, P, A, CEN2), ord(ob, PB, B, CENB)],
    items: [item(IQ1, o), item(IQ2, o), item(IQ3, o), item(IQ4, oz)],
    specimens: [spec(SQ1, o, 'SYN-Q0001', 'received', [IQ1, IQ2, IQ3]), spec(SQ2, o, 'SYN-Q0002', 'ordered', []), spec(SQ3, o, 'SYN-Q0003', 'collected', []), spec(SZ, oz, 'SYN-Q0009', 'received', [IQ4])],
    results: [
      res(L(0x80), IQ1, AN1, 'pending'), res(L(0x81), IQ1, AN2, 'pending'), res(L(0x82), IQ1, AN3, 'pending'),   // AN3 has no outbound map on INS
      res(L(0x83), IQ2, AN2, 'resulted', { valueNumeric: '7.0' }), res(L(0x84), IQ3, AN1, 'approved', { valueNumeric: '13.0' }), res(L(0x85), IQ4, AN1, 'pending'),
    ],
  });
  const norm = (r: any) => r.tests.map((t: any) => ({ ...t, analyteIds: [...t.analyteIds].sort() })).sort((a: any, b: any) => a.orderItemId.localeCompare(b.orderItemId));

  it('returns the received specimen\'s pending/resulted tests with an outbound map (unmapped analyte, approved item excluded); only sex/ageDays/priority/specimenId/tests are exposed', async () => {
    const h = await boot(fx());
    const r = await h.impl.getPendingTestsForBarcode(h.ctxFor('A:device'), { instrumentId: INS, barcode: 'SYN-Q0001' });
    expect(norm(r)).toEqual([{ orderItemId: IQ1, testId: T_STD, analyteIds: [AN1, AN2].sort() }, { orderItemId: IQ2, testId: T_STD, analyteIds: [AN2] }]);
    expect(Object.keys(r).sort()).toEqual(['patient', 'priority', 'specimenId', 'tests']);
    expect(r.specimenId).toBe(SQ1);
    expect(r.patient).toEqual({ sex: 'female', ageDays: 12000 });
  });

  it('S6 pick-up: received -> in_process once (one S6 transition, one status_changed event); a repeat call still answers and adds no transition', async () => {
    const h = await boot(fx());
    const dev = h.ctxFor('A:device');
    await h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS, barcode: 'SYN-Q0001' });
    expect((await q('SELECT status FROM lab.specimens WHERE id = $1', [SQ1]))[0].status).toBe('in_process');
    expect(await q(`SELECT transition_code FROM lab.specimen_transitions WHERE specimen_id = $1`, [SQ1])).toEqual([{ transition_code: 'S6' }]);
    expect(h.events.ofType('lab.specimen.status_changed.v1')).toHaveLength(1);
    expect(norm(await h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS, barcode: 'SYN-Q0001' }))).toHaveLength(2);
    expect(await COUNT('SELECT count(*) AS c FROM lab.specimen_transitions WHERE specimen_id = $1', [SQ1])).toBe(1);
  });

  it('not yet received -> lab.specimen_not_receivable; collected is allowed only when lab_settings.host_query_requires_received = false', async () => {
    const h = await boot(fx());
    const dev = h.ctxFor('A:device');
    for (const b of ['SYN-Q0002', 'SYN-Q0003']) expect(await code(h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS, barcode: b })), b).toBe('lab.specimen_not_receivable');
    await asAdmin(async (c) => { await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: L(1), actor_type: 'system' })]); await c.query('UPDATE lab.lab_settings SET host_query_requires_received = false WHERE tenant_id = $1', [A]); });
    try {
      expect(await code(h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS, barcode: 'SYN-Q0003' }))).toBeUndefined();
      expect(await code(h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS, barcode: 'SYN-Q0002' }))).toBe('lab.specimen_not_receivable');
    } finally {
      await asAdmin(async (c) => { await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: L(1), actor_type: 'system' })]); await c.query('UPDATE lab.lab_settings SET host_query_requires_received = true WHERE tenant_id = $1', [A]); });
    }
  });

  it('P-09: a device of centre A1 asking for a specimen received at A2 -> lab.specimen_not_found; the error text carries no barcode', async () => {
    const h = await boot(fx());
    const e = await fail(h.impl.getPendingTestsForBarcode(h.deviceAt(h.ctxFor('A:device'), CEN), { instrumentId: INS, barcode: 'SYN-Q0009' }));
    expect(e.code).toBe('lab.specimen_not_found');
    expect(JSON.stringify({ m: e.message, d: e.safeDetail })).not.toMatch(/Q0009/);
    expect((await h.impl.getPendingTestsForBarcode(h.deviceAt(h.ctxFor('A:device'), CEN2), { instrumentId: INS, barcode: 'SYN-Q0009' })).specimenId).toBe(SZ);
  });

  it('an instrument with no outbound maps gets tests: []; hostile / empty barcodes are rejected cleanly, nothing is read', async () => {
    const h = await boot(fx());
    const dev = h.ctxFor('A:device');
    expect((await h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS2, barcode: 'SYN-Q0001' })).tests).toEqual([]);
    for (const barcode of ["SYN-Q0001' OR '1'='1", '', 'x'.repeat(500)]) expect((await code(h.impl.getPendingTestsForBarcode(dev, { instrumentId: INS, barcode })))!, JSON.stringify(barcode)).toMatch(/^(lab\.specimen_not_found|common\.validation_failed)$/);
  });

  it('listPendingForInstrument: device of centre A1 sees only its centre\'s received specimens with a mapped pending result; paging by cursor covers every row once; limit > 200 / bad cursor -> common.validation_failed', async () => {
    const o2 = L(0xb6), items = [1, 2, 3, 4, 5].map((k) => L(0x40 + k)), r2 = [1, 2, 3, 4, 5].map((k) => L(0x48 + k)), s2 = [1, 2, 3, 4, 5].map((k) => L(0x50 + k));
    const h = await boot({
      ...fx(),
      orders: [...fx().orders!, ord(o2)], items: [...fx().items!, ...items.map((i) => item(i, o2))],
      specimens: [...fx().specimens!, ...s2.map((s, k) => spec(s, o2, `SYN-W000${k + 1}`, 'received', [items[k]!], { receivedAt: k < 3 ? '2026-11-05T01:00:00.000Z' : '2026-11-05T03:00:00.000Z' }))],
      results: [...fx().results!, ...r2.map((r, k) => res(r, items[k]!, AN1, 'pending'))],
    });
    const dev = h.deviceAt(h.ctxFor('A:device'), CEN);
    const all: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await h.impl.listPendingForInstrument(dev, { instrumentId: INS, limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.items.length).toBeLessThanOrEqual(2);
      all.push(...r.items.map((x: any) => x.specimenId));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([SQ1, ...s2].sort());                // SQ2/SQ3 not received, SZ other centre, SQ1 approved-only? no: SQ1 has pending AN1/AN2
    const since = await h.impl.listPendingForInstrument(dev, { instrumentId: INS, receivedSince: '2026-11-05T02:30:00.000Z' });
    expect(since.items.map((x: any) => x.specimenId).sort()).toEqual([s2[3], s2[4]].sort());
    expect(await code(h.impl.listPendingForInstrument(dev, { instrumentId: INS, limit: 201 }))).toBe('common.validation_failed');
    expect(await code(h.impl.listPendingForInstrument(dev, { instrumentId: INS, cursor: 'not-a-cursor' }))).toBe('common.validation_failed');
    const tenantWide = await h.impl.listPendingForInstrument(sys(h), { instrumentId: INS, limit: 200 });
    expect(tenantWide.items.map((x: any) => x.specimenId)).toEqual(expect.arrayContaining(s2));
    for (const k of ['A', 'A:user:reader', 'A:patient', 'A:portal', 'A:partner']) expect(await code(h.impl.listPendingForInstrument(h.ctxFor(k), { instrumentId: INS })), k).toBe('auth.forbidden');
  });
});

// ================================================================ lookupSpecimens
describe.skipIf(!live)('lookupSpecimens (S-20; 08 §4.14 CR-C10-003 + C17-002)', () => {
  const o = L(0x58 + 0x20), ob = L(0x59 + 0x20), I = L(0x5a + 0x20), IB = L(0x5b + 0x20);
  const S1 = L(0x60 + 0x20), S2 = L(0x61 + 0x20), SB = L(0x62 + 0x20);
  const fx = (): Fx => ({
    orders: [ord(o), ord(ob, PB, B, CENB)], items: [item(I, o), { ...item(IB, ob), tenantId: B }],
    specimens: [spec(S1, o, 'SYN-L0001', 'rejected', [I]), spec(S2, o, 'SYN-L0002', 'received', [I], { replacesSpecimenId: S1 }), { ...spec(SB, ob, 'SYN-L0003', 'received', [IB]), tenantId: B }],
    results: [],
  });
  it('shape, statuses filter, replacement link; no side effects (specimen rows unchanged, no transitions)', async () => {
    const h = await boot(fx());
    const before = await q('SELECT id, updated_at, version FROM lab.specimens WHERE order_id = $1 ORDER BY id', [o]);
    const all = await h.impl.lookupSpecimens(sys(h), { orderId: o });
    expect(all.map((x: any) => x.specimenId).sort()).toEqual([S1, S2].sort());
    const s2 = all.find((x: any) => x.specimenId === S2);
    expect(s2).toMatchObject({ barcode: 'SYN-L0002', orderId: o, patientId: P, centreId: CEN, specimenTypeCode: 'BLOOD', status: 'received', isActive: true, replacesSpecimenId: S1, version: 1 });
    expect((await h.impl.lookupSpecimens(sys(h), { orderId: o, statuses: ['rejected'] })).map((x: any) => x.specimenId)).toEqual([S1]);
    expect(await q('SELECT id, updated_at, version FROM lab.specimens WHERE order_id = $1 ORDER BY id', [o])).toEqual(before);
    expect(await COUNT('SELECT count(*) AS c FROM lab.specimen_transitions WHERE specimen_id = ANY($1)', [[S1, S2]])).toBe(0);
  });
  it('1..200 ids: 200 ok, 201 / 0 / no selector -> common.validation_failed; other tenant order -> omitted (not an error)', async () => {
    const h = await boot(fx());
    const ids = (k: number) => Array.from({ length: k }, (_, i) => L(0x1000 + (i % 200)));   // unknown ids, none of the fixture L() values (ruling C5.T-24 #1; 08-CR-REGISTER:1655 unknown -> omitted)
    expect(await h.impl.lookupSpecimens(sys(h), { specimenIds: ids(200) })).toEqual([]);
    for (const bad of [{ specimenIds: ids(201) }, { specimenIds: [] }, {}]) expect(await code(h.impl.lookupSpecimens(sys(h), bad as never)), JSON.stringify(Object.keys(bad))).toBe('common.validation_failed');
    expect(await h.impl.lookupSpecimens(sys(h), { orderId: ob })).toEqual([]);
  });
  it('actors: homecollection.visit.read opens only the {orderId} form; device / patient / portal / partner / reader-only -> auth.forbidden', async () => {
    const h = await boot(fx());
    const hc = h.ctxFor('A:user:hc');
    expect(await code(h.impl.lookupSpecimens(hc, { orderId: o }))).toBeUndefined();
    expect(await code(h.impl.lookupSpecimens(hc, { barcode: 'SYN-L0002' }))).toBe('auth.forbidden');
    expect(await code(h.impl.lookupSpecimens(hc, { specimenIds: [S1] }))).toBe('auth.forbidden');
    for (const k of ['A:device', 'A:patient', 'A:portal', 'A:partner', 'A:user:reader']) expect(await code(h.impl.lookupSpecimens(h.ctxFor(k), { orderId: o })), k).toBe('auth.forbidden');
  });
});

// ================================================================ getAnalyteHistory + getOrderResults
describe.skipIf(!live)('getAnalyteHistory (S-22; 08 §4.14 CR-C14-002)', () => {
  const ids = (k: number) => L(0x40 + k);
  const O = [1, 2, 3, 4, 5, 6].map((k) => ids(0x00 + k)), IT = [1, 2, 3, 4, 5, 6].map((k) => ids(0x10 + k)), RS = [1, 2, 3, 4, 5, 6, 7].map((k) => ids(0x20 + k));
  const day = (d: string) => `${d}T05:00:00.000Z`;
  const fx = (): Fx => ({
    orders: [ord(O[0]!), ord(O[1]!), ord(O[2]!), ord(O[3]!), ord(O[4]!, P2), ord(O[5]!, PB, B, CENB)],
    items: [...IT.slice(0, 5).map((i, k) => item(i, O[k]!)), { ...item(IT[5]!, O[5]!), tenantId: B }],
    results: [
      res(RS[0]!, IT[0]!, AN1, 'approved', { approvedAt: day('2026-10-01'), valueNumeric: '10.0' }),
      res(RS[1]!, IT[1]!, AN1, 'approved', { approvedAt: day('2026-10-15'), valueNumeric: '11.5', versionNo: 2 }),
      res(RS[2]!, IT[2]!, AN1, 'approved', { approvedAt: day('2026-11-01'), valueNumeric: '12.0' }),
      res(RS[3]!, IT[3]!, AN1, 'pending'),
      res(RS[4]!, IT[0]!, AN2, 'approved', { approvedAt: day('2026-10-01'), valueNumeric: '5.0' }),
      res(RS[5]!, IT[4]!, AN1, 'approved', { approvedAt: day('2026-10-20'), valueNumeric: '99.0' }),
      { ...res(RS[6]!, IT[5]!, AN1, 'approved', { approvedAt: day('2026-10-20'), valueNumeric: '77.0' }), tenantId: B },
    ],
  });
  const hist = (h: RealHarness, extra: Record<string, unknown> = {}, ctx = sys(h)) => h.impl.getAnalyteHistory(ctx, { patientId: P, analyteIds: [AN1], before: NOW, limitPerAnalyte: 10, ...extra });
  const pts = (r: any, i = 0) => r.series[i].points.map((p: any) => p.resultId);

  it('approved only, latest version, newest first, never another patient / tenant; point shape; analyte with no data -> empty series', async () => {
    const h = await boot(fx());
    const r = await hist(h, { analyteIds: [AN1, AN2, AN3] });
    expect(r.series.map((s: any) => s.analyteId)).toEqual([AN1, AN2, AN3]);
    expect(pts(r)).toEqual([RS[2], RS[1], RS[0]]);
    expect(pts(r, 1)).toEqual([RS[4]]);
    expect(pts(r, 2)).toEqual([]);
    expect(r.series[0].points[1]).toMatchObject({ source: 'lis', resultId: RS[1], orderId: O[1], versionNo: 2, valueNumeric: '11.5', approvedAt: day('2026-10-15') });
    expect(await hist(h, {}, h.ctxFor('B:system'))).toMatchObject({ series: [{ points: [] }] });
    expect(pts(await hist(h, { patientId: PB }))).toEqual([]);
  });
  it('window [since, before): before is exclusive, since inclusive; limitPerAnalyte; excludeOrderId; includeLegacy adds no legacy point', async () => {
    const h = await boot(fx());
    expect(pts(await hist(h, { before: day('2026-11-01') }))).toEqual([RS[1], RS[0]]);
    expect(pts(await hist(h, { since: day('2026-10-15') }))).toEqual([RS[2], RS[1]]);
    expect(pts(await hist(h, { limitPerAnalyte: 2 }))).toEqual([RS[2], RS[1]]);
    expect(pts(await hist(h, { excludeOrderId: O[2] }))).toEqual([RS[1], RS[0]]);
    expect((await hist(h, { includeLegacy: true })).series[0].points.every((p: any) => p.source === 'lis')).toBe(true);
  });
  it('validation: limit 0/11, 0/101 analytes, bad before -> common.validation_failed', async () => {
    const h = await boot(fx());
    for (const bad of [{ limitPerAnalyte: 0 }, { limitPerAnalyte: 11 }, { analyteIds: [] }, { analyteIds: Array.from({ length: 101 }, (_, i) => L(0x30 + (i % 100))) }, { before: 'yesterday' }])
      expect(await code(hist(h, bad)), JSON.stringify(Object.keys(bad))).toBe('common.validation_failed');
  });
});

describe.skipIf(!live)('getOrderResults extras (S-17; AC-17.4)', () => {
  const o = L(0x90 + 0x40), I = L(0x91 + 0x40), sp = L(0x92 + 0x40);
  const R = [1, 2, 3, 4].map((k) => L(0x93 + 0x40 + k));
  const fx = (): Fx => ({
    orders: [ord(o)], items: [item(I, o)], specimens: [spec(sp, o, 'SYN-G0001', 'received', [I])],
    results: [
      res(R[0]!, I, AN1, 'approved', { valueNumeric: '11.5', versionNo: 2 }), res(R[1]!, I, AN2, 'approved', { valueNumeric: '5.0', isReportable: false }),
      res(R[2]!, I, AN3, 'resulted', { valueNumeric: '3.0' }), res(R[3]!, I, ANM, 'cancelled'),
    ],
  });
  it('approved scope: latest version of reportable approved results (version 2 value, amendment info), barcode present; all_visible: non-cancelled only, no barcode; unknown / malformed order id', async () => {
    const h = await boot(fx());
    const a = await h.impl.getOrderResults(h.ctxFor('A'), { orderId: o, scope: 'approved' });
    expect(a.items[0].results.map((r: any) => r.resultId)).toEqual([R[0]]);
    expect(a.items[0].results[0]).toMatchObject({ versionNo: 2, valueNumeric: '11.5', status: 'approved', amendment: { previousVersionNo: 1, reasonCode: 'correction' } });
    expect(a.specimens[0].barcode).toBe('SYN-G0001');
    expect(a.approvedSetHash).toMatch(/^[0-9a-f]{64}$/);
    const v = await h.impl.getOrderResults(h.ctxFor('A:user:reader'), { orderId: o, scope: 'all_visible' });
    expect(v.items[0].results.map((r: any) => r.resultId).sort()).toEqual([R[0], R[1], R[2]].sort());
    expect(v.specimens[0]).not.toHaveProperty('barcode');
    expect(await code(h.impl.getOrderResults(sys(h), { orderId: L(0xee), scope: 'approved' }))).toBe('common.not_found');
    expect(await code(h.impl.getOrderResults(sys(h), { orderId: 'nope', scope: 'approved' }))).toBe('common.validation_failed');
  });
});
