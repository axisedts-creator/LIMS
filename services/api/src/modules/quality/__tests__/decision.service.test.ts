// C9 T-16 — canAutoVerify + decision audit, service level (02-TRD §8.4, §8.5 A1-A16, §14 metrics; PRD AC-11.1, AC-13.1-13.5; 07-SECURITY QualityPort row, REQ-SEC-024/081/098, S-17).
// SEAMS: see decision.helpers.ts header (createDecisionService({ autoverifyRepo, decisionRepo, status, ruleCacheMax }), DecisionRepo.insertDecision(tx, tenantId, row)).
// Fails now: "Cannot find module ../service/decision.service.js".
import { describe, expect, it } from 'vitest';
import { createDecisionService } from '../service/decision.service.js';
import {
  DECISIONS_TOTAL, DEF_V4, I1, I2, K, NOW, OTHER_ANALYTE, PLANTED, QC, REASONS, RESULT, RESULTED_AT, RUN, SEC, SHORT_CIRCUIT, TENANT_A, TENANT_B, USER, V3, V4,
  code, kAny, makeCtx, makeDecisionRepo, makeStatus, rc, rejection, scenario, setRow, verRow, def, without, DEF_V3, TEST, VER, rule,
} from './decision.helpers.js';

const svc = (o: { repo?: ReturnType<typeof scenario>; status?: ReturnType<typeof makeStatus>; dec?: ReturnType<typeof makeDecisionRepo>; ruleCacheMax?: number } = {}) => {
  const repo = o.repo ?? scenario(), status = o.status ?? makeStatus(), dec = o.dec ?? makeDecisionRepo();
  const service = createDecisionService({ autoverifyRepo: repo.repo as any, decisionRepo: dec.repo as any, status: status as any, ...(o.ruleCacheMax ? { ruleCacheMax: o.ruleCacheMax } : {}) });
  return { service, repo, status, dec };
};
const ids = (rs: Array<Record<string, any>>) => rs.map((r) => r['id']);

describe('§8.5 vectors through the service (live decision; fixture V3 active, tenant enabled)', () => {
  const QCS = { in_control: QC.in_control, ooc: QC.out_of_control, none: QC.no_qc_data, warn: QC.warning };
  it.each([
    ['A1', rc(), QCS.in_control, true, 'allow', []],
    ['A3', without(rc(), 'instrumentId'), QCS.in_control, true, 'deny', ['manual_origin']],
    ['A4', rc({ valueNumeric: '7.0', rangeFlag: 'HH', isCritical: true }), QCS.in_control, true, 'deny', ['critical', 'outside_autoverify_limits']],
    ['A5', rc({ deltaCheckFailed: true }), QCS.in_control, true, 'deny', ['delta_failure']],
    ['A6', rc({ instrumentFlags: ['SYN_FLAG'] }), QCS.in_control, true, 'deny', ['instrument_flag']],
    ['A7', rc({ valueNumeric: '5.2', rangeFlag: 'H' }), QCS.in_control, true, 'deny', ['outside_autoverify_limits']],
    ['A8', rc({ valueNumeric: '5.1', rangeFlag: 'N' }), QCS.in_control, true, 'allow', []],
    ['A9', without(rc(), 'valueNumeric'), QCS.in_control, true, 'deny', ['outside_autoverify_limits']],
    ['A10', rc(), QCS.ooc, true, 'deny', ['qc_out_of_control']],
    ['A11', rc(), QCS.none, true, 'deny', ['qc_no_data']],
    ['A12', rc(), QCS.warn, true, 'deny', ['qc_warning']],
    ['A13', rc({ instrumentId: I2 }), QCS.in_control, true, 'deny', ['rule_missing']],
    ['A14', rc({ analyteId: OTHER_ANALYTE }), QCS.in_control, true, 'deny', ['rule_missing']],
    ['A15', rc({ deltaCheckFailed: true, instrumentFlags: ['SYN_FLAG'] }), QCS.ooc, true, 'deny', ['delta_failure', 'instrument_flag', 'qc_out_of_control']],
  ])('%s -> %s %j (AC-13.1; ruleSetVersion = the active version id because it was used, AC-13.4)', async (_id, ctxIn, qc, enabled, decision, reasons) => {
    const { service } = svc({ status: makeStatus(qc as any) });
    const r = await service.canAutoVerify(makeCtx({ enabled }).ctx, ctxIn);
    expect(r).toEqual({ decision, reasons, ruleSetVersion: V3 });
  });
  it('A2 tenant disabled -> deny [feature_disabled] regardless of the rules, no ruleSetVersion, no QC lookup, no live row (AC-13.2)', async () => {
    for (const ctxIn of [rc(), rc({ valueNumeric: '4.2' }), without(rc(), 'instrumentId')]) {
      const { service, status, dec } = svc();
      expect(await service.canAutoVerify(makeCtx({ enabled: false }).ctx, ctxIn)).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
      expect(status.calls).toEqual([]); expect(dec.rows()).toEqual([]);
    }
  });
  it('A16 tenant disabled + V4 simulating (K_ANY 3.0-6.0): live deny [feature_disabled]; exactly one SHADOW row, allow [] on V4; no live row (AC-11.1)', async () => {
    const { service, dec } = svc({ repo: scenario({ simulating: DEF_V4 }) });
    const c = makeCtx({ enabled: false });
    expect(await service.canAutoVerify(c.ctx, rc({ valueNumeric: '5.8' }))).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
    expect(dec.rows('live')).toEqual([]);
    const shadow = dec.rows('shadow'); expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({ tenant_id: TENANT_A, mode: 'shadow', version_id: V4, result_id: RESULT, decision: 'allow', reasons: [], matched_rule_key: 'K_ANY', qc_status: 'in_control' });   // 5.8 is inside 3.0-6.0, outside V3
  });
});

describe('decision rows (AC-13.3, AC-11.1; 02-TRD §8.4 "Decision row", 05-SCHEMA autoverify_decisions)', () => {
  it('a live evaluation writes exactly ONE live row with every column of the TRD row, on the caller ctx.tx, tenant from ctx', async () => {
    const { service, dec } = svc(); const c = makeCtx();
    await service.canAutoVerify(c.ctx, rc({ instrumentFlags: ['SYN_FLAG'] }));
    expect(dec.calls).toHaveLength(1); const call = dec.calls[0]!;
    expect(call.tx).toBe(c.tx); expect(call.tenantId).toBe(TENANT_A);
    expect(call.row).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), decided_at: NOW, mode: 'live', version_id: V3, result_id: RESULT, analyte_id: K, instrument_id: I1,
      decision: 'deny', reasons: ['instrument_flag'], matched_rule_key: 'K_ANY', qc_status: 'in_control', qc_run_id: RUN(1),
      inputs: { value_numeric: '4.2', range_flag: 'N', delta_check_failed: false, is_critical: false, instrument_flags: ['SYN_FLAG'], resulted_at: RESULTED_AT },
      created_by: USER,
    });
  });
  it('an allow row carries reasons [] (DB check allow => no reasons) and the matched rule key', async () => {
    const { service, dec } = svc(); await service.canAutoVerify(makeCtx().ctx, rc());
    expect(dec.rows('live')[0]).toMatchObject({ decision: 'allow', reasons: [], matched_rule_key: 'K_ANY' });
  });
  it('absent optional inputs leave their keys out (no undefined / null in `inputs`); an absent instrument gives instrument_id null, qc_status not_evaluated, qc_run_id null and NO QC lookup', async () => {
    const { service, dec, status } = svc();
    await service.canAutoVerify(makeCtx().ctx, without(rc(), 'instrumentId', 'valueNumeric', 'rangeFlag'));
    expect(status.calls).toEqual([]);
    const row = dec.rows('live')[0]!;
    expect(row['inputs']).toEqual({ delta_check_failed: false, is_critical: false, instrument_flags: [], resulted_at: RESULTED_AT });
    expect(row).toMatchObject({ decision: 'deny', reasons: ['manual_origin'], instrument_id: null, qc_status: 'not_evaluated', qc_run_id: null });
    expect(row['matched_rule_key'] ?? null).toBeNull();
  });
  it('QC status and run id of the lookup are stored (out_of_control -> its run id; no_qc_data -> qc_run_id null)', async () => {
    for (const [q, status, run] of [[QC.out_of_control, 'out_of_control', RUN(3)], [QC.no_qc_data, 'no_qc_data', null], [QC.warning, 'warning', RUN(2)]] as const) {
      const { service, dec } = svc({ status: makeStatus(q) }); await service.canAutoVerify(makeCtx().ctx, rc());
      expect(dec.rows('live')[0], status).toMatchObject({ qc_status: status, qc_run_id: run });
    }
  });
  it('qcStatusFor is asked with exactly { instrumentId, analyteId, at: resultedAt } on the caller ctx, once per call even with a shadow version', async () => {
    const { service, status } = svc({ repo: scenario({ simulating: DEF_V4 }) }); const c = makeCtx();
    await service.canAutoVerify(c.ctx, rc());
    expect(status.calls).toHaveLength(1); expect(status.calls[0]!.input).toEqual({ instrumentId: I1, analyteId: K, at: RESULTED_AT }); expect(status.calls[0]!.ctx).toBe(c.ctx);
  });
  it('with a simulating version: one live row (V3) AND one shadow row (V4) per call, same result id, distinct row ids (AC-11.1)', async () => {
    const { service, dec } = svc({ repo: scenario({ simulating: DEF_V4 }) });
    await service.canAutoVerify(makeCtx().ctx, rc());
    expect(dec.rows('live')).toHaveLength(1); expect(dec.rows('shadow')).toHaveLength(1);
    expect(dec.rows('live')[0]).toMatchObject({ version_id: V3, result_id: RESULT }); expect(dec.rows('shadow')[0]).toMatchObject({ version_id: V4, result_id: RESULT });
    expect(new Set(ids(dec.rows())).size).toBe(2);
  });
  it('the shadow version NEVER changes the returned value (contract case 10): result identical with and without a simulating version, even when the shadow rules disagree', async () => {
    const wild = def(kAny({ limits: { low: '9.0', high: '9.5' } }));
    for (const ctxIn of [rc(), rc({ valueNumeric: '5.8' }), rc({ isCritical: true }), without(rc(), 'instrumentId')]) {
      const base = await svc().service.canAutoVerify(makeCtx().ctx, ctxIn);
      expect(await svc({ repo: scenario({ simulating: wild }) }).service.canAutoVerify(makeCtx().ctx, ctxIn)).toEqual(base);
      expect(await svc({ repo: scenario({ simulating: DEF_V4 }) }).service.canAutoVerify(makeCtx().ctx, ctxIn)).toEqual(base);
    }
  });
  it('the shadow row is evaluated ignoring `enabled` and with its own matched rule; it records deny reasons of the shadow rules', async () => {
    const { service, dec } = svc({ repo: scenario({ simulating: def(kAny({ limits: { low: '9.0', high: '9.5' } })) }) });
    await service.canAutoVerify(makeCtx().ctx, rc());
    expect(dec.rows('live')[0]).toMatchObject({ decision: 'allow' }); expect(dec.rows('shadow')[0]).toMatchObject({ decision: 'deny', reasons: ['outside_autoverify_limits'], version_id: V4 });
  });
  it('enabled + simulating but NO active version: live deny [rule_missing], no live row, one shadow row', async () => {
    const { service, dec } = svc({ repo: scenario({ active: null, simulating: DEF_V4 }) });
    expect(await service.canAutoVerify(makeCtx().ctx, rc())).toEqual({ decision: 'deny', reasons: ['rule_missing'] });
    expect(dec.rows('live')).toEqual([]); expect(dec.rows('shadow')).toHaveLength(1);
  });
  it('a stopped / retired / discarded version is never evaluated (only the active and the simulating pointers count)', async () => {
    const repo = scenario({ extra: [verRow(5, 'stopped', { definition: def(kAny({ limits: { low: '0', high: '99' } })) }), verRow(6, 'retired'), verRow(7, 'discarded')] });
    const { service, dec } = svc({ repo });
    expect(await service.canAutoVerify(makeCtx().ctx, rc({ valueNumeric: '50' }))).toMatchObject({ decision: 'deny', reasons: ['outside_autoverify_limits'] });
    expect(dec.rows('shadow')).toEqual([]);
  });
});

describe('short-circuit (AC-13.5, DECISION D-AV-4): no simulating version and (disabled or no active version) -> deny, NO row, counted', () => {
  it('tenant disabled: deny [feature_disabled], no row, no QC lookup, lims_quality_autoverify_short_circuit_total{reason="feature_disabled"} +1', async () => {
    const { service, dec, status } = svc(); const c = makeCtx({ enabled: false });
    expect(await service.canAutoVerify(c.ctx, rc())).toEqual({ decision: 'deny', reasons: ['feature_disabled'] });
    expect(dec.calls).toEqual([]); expect(status.calls).toEqual([]);
    expect(c.metric(SHORT_CIRCUIT).map((m) => [m.labels, m.by])).toEqual([[{ reason: 'feature_disabled' }, 1]]);
  });
  it('enabled but no active version: deny [rule_missing], no row, reason="rule_missing" +1', async () => {
    const { service, dec } = svc({ repo: scenario({ active: null }) }); const c = makeCtx();
    expect(await service.canAutoVerify(c.ctx, rc())).toEqual({ decision: 'deny', reasons: ['rule_missing'] });
    expect(dec.calls).toEqual([]); expect(c.metric(SHORT_CIRCUIT).map((m) => m.labels)).toEqual([{ reason: 'rule_missing' }]);
  });
  it('a tenant with no rule set row at all behaves like no active version', async () => {
    const { service, dec } = svc({ repo: scenario({ tenant: TENANT_B }) }); const c = makeCtx();
    expect(await service.canAutoVerify(c.ctx, rc())).toEqual({ decision: 'deny', reasons: ['rule_missing'] }); expect(dec.calls).toEqual([]);
  });
  it('evaluated decisions are not short-circuits: an allow / a normal deny leaves the short-circuit counter alone', async () => {
    const c = makeCtx(); await svc().service.canAutoVerify(c.ctx, rc()); await svc().service.canAutoVerify(c.ctx, rc({ isCritical: true }));
    expect(c.metric(SHORT_CIRCUIT)).toEqual([]);
  });
  it('a missing ctx.metrics never breaks the call', async () => {
    expect(await svc().service.canAutoVerify(makeCtx({ metrics: false }).ctx, rc())).toMatchObject({ decision: 'allow' });
    expect(await svc().service.canAutoVerify(makeCtx({ metrics: false, enabled: false }).ctx, rc())).toMatchObject({ decision: 'deny' });
  });
});

describe('decisions metric (02-TRD §14): lims_quality_autoverify_decisions_total{mode,decision,reason}', () => {
  it('one increment per reason of a written row; reason="none" once for an allow (alert QualityAutoverifyAllowWithReasons must stay silent)', async () => {
    const a = makeCtx(); await svc().service.canAutoVerify(a.ctx, rc());
    expect(a.metric(DECISIONS_TOTAL).map((m) => m.labels)).toEqual([{ mode: 'live', decision: 'allow', reason: 'none' }]);
    const b = makeCtx(); await svc({ status: makeStatus(QC.out_of_control) }).service.canAutoVerify(b.ctx, rc({ deltaCheckFailed: true, instrumentFlags: ['SYN_FLAG'] }));
    expect(b.metric(DECISIONS_TOTAL).map((m) => m.labels).sort((x, y) => x.reason!.localeCompare(y.reason!))).toEqual(
      ['delta_failure', 'instrument_flag', 'qc_out_of_control'].map((reason) => ({ mode: 'live', decision: 'deny', reason })));
  });
  it('the shadow row is counted with mode="shadow"', async () => {
    const c = makeCtx({ enabled: false }); await svc({ repo: scenario({ simulating: DEF_V4 }) }).service.canAutoVerify(c.ctx, rc());
    expect(c.metric(DECISIONS_TOTAL).map((m) => m.labels)).toEqual([{ mode: 'shadow', decision: 'allow', reason: 'none' }]);
  });
  it('never an allow with a reason label other than none (invariant breach counter stays at 0 across random contexts)', async () => {
    const c = makeCtx(); const { service } = svc({ status: makeStatus((i) => (i.analyteId === K ? QC.in_control : QC.warning)) });
    for (const v of ['4.2', '9', '3.5', '5.1']) for (const f of [[], ['E']]) await service.canAutoVerify(c.ctx, rc({ valueNumeric: v, instrumentFlags: f }));
    expect(c.metric(DECISIONS_TOTAL).filter((m) => m.labels['decision'] === 'allow' && m.labels['reason'] !== 'none')).toEqual([]);
  });
});

describe('inside the caller transaction (06-PLAN T-16 "rows inside caller tx (rollback test)"; 02-CV §8.1)', () => {
  it('every row is written on the caller ctx.tx; the service opens no transaction (no BEGIN/COMMIT/SAVEPOINT, no ctx.db)', async () => {
    const { service, dec } = svc({ repo: scenario({ simulating: DEF_V4 }) }); const c = makeCtx();
    await service.canAutoVerify(c.ctx, rc());
    expect(dec.calls).toHaveLength(2); for (const call of dec.calls) expect(call.tx).toBe(c.tx);
    expect(c.queries.filter((q) => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(q.text))).toEqual([]);
  });
  it('rollback of the caller transaction removes the rows of that transaction only', async () => {
    const { service, dec } = svc({ repo: scenario({ simulating: DEF_V4 }) }); const a = makeCtx(), b = makeCtx();
    await service.canAutoVerify(a.ctx, rc()); await service.canAutoVerify(b.ctx, rc({ resultId: '01a1a98a-ac40-7000-8000-000000009202' }));
    expect(dec.rows()).toHaveLength(4);
    dec.rollback(a.tx);
    expect(dec.rows().map((r) => r['result_id'])).toEqual(['01a1a98a-ac40-7000-8000-000000009202', '01a1a98a-ac40-7000-8000-000000009202']);
  });
  it('a failing row insert FAILS the call (an allow is never returned without its audit row): common.internal, no driver text', async () => {
    const { service, dec } = svc(); dec.failNext(new Error(`relation "quality.autoverify_decisions" does not exist ${PLANTED}`));
    const e = await rejection(service.canAutoVerify(makeCtx().ctx, rc()));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(/relation|PLANTED|autoverify_decisions/);
  });
});

describe('inputs and failure modes (fail closed: C5 must never read a failure as allow)', () => {
  it.each([
    ['null', null], ['string', 'x'], ['array', []], ['resultId not a uuid', rc({ resultId: 'nope' })], ['resultId missing', without(rc(), 'resultId')], ['analyteId not a uuid', rc({ analyteId: "1' OR '1'='1" })],
    ['analyteId missing', without(rc(), 'analyteId')], ['instrumentId not a uuid', rc({ instrumentId: 'I1' })], ['valueNumeric garbage', rc({ valueNumeric: 'abc' })], ['valueNumeric exponent', rc({ valueNumeric: '4.2e0' })],
    ['valueNumeric injection', rc({ valueNumeric: "4.2'; DROP TABLE quality.autoverify_decisions;--" })], ['valueNumeric too long', rc({ valueNumeric: '1'.repeat(41) })],
    ['valueNumeric number', rc({ valueNumeric: 4.2 })], ['rangeFlag unknown', rc({ rangeFlag: 'X' })], ['instrumentFlags not an array', rc({ instrumentFlags: 'E' })], ['instrumentFlags item not a string', rc({ instrumentFlags: [1] })],
    ['instrumentFlags missing', without(rc(), 'instrumentFlags')], ['deltaCheckFailed string', rc({ deltaCheckFailed: 'false' })], ['isCritical missing', without(rc(), 'isCritical')], ['isCritical string', rc({ isCritical: 'false' })],
    ['resultedAt garbage', rc({ resultedAt: 'yesterday' })], ['resultedAt with offset', rc({ resultedAt: '2026-11-05T09:55:00+05:45' })], ['resultedAt missing', without(rc(), 'resultedAt')],
  ])('bad ResultContext (%s) -> common.validation_failed BEFORE any settings / repo / QC call and no row', async (_n, bad) => {
    const { service, dec, status, repo } = svc(); const c = makeCtx();
    expect(code(await rejection(service.canAutoVerify(c.ctx, bad as any)))).toBe('common.validation_failed');
    expect(c.settingsCalls).toEqual([]); expect(repo.calls).toEqual([]); expect(status.calls).toEqual([]); expect(dec.calls).toEqual([]);
  });
  it('settings failure -> common.internal (never allow, never a silent deny row); no row, no driver text', async () => {
    const { service, dec } = svc(); const c = makeCtx({ settingsFail: new Error(`db down ${PLANTED}`) });
    const e = await rejection(service.canAutoVerify(c.ctx, rc()));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(PLANTED); expect(dec.calls).toEqual([]);
  });
  it('rule-set read failure -> common.internal without SQL text', async () => {
    const { service, repo } = svc(); (repo.repo as any).findRuleSet = async () => { throw new Error(`relation "quality.autoverify_rule_sets" does not exist ${PLANTED}`); };
    const e = await rejection(service.canAutoVerify(makeCtx().ctx, rc()));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(/relation|PLANTED/);
  });
  it('QC lookup failure -> common.internal (a QC outage must not become qc_no_data-and-allow); no row for that call', async () => {
    const { service, dec } = svc({ status: { calls: [], qcStatusFor: async () => { throw new Error(`boom ${PLANTED}`); } } as any });
    const e = await rejection(service.canAutoVerify(makeCtx().ctx, rc()));
    expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message })).not.toContain(PLANTED); expect(dec.calls).toEqual([]);
  });
  it('a stored definition that is corrupt (not the DSL shape) never allows: common.internal or deny, never allow', async () => {
    const repo = scenario({ active: { schema_version: 1, rules: 'garbage' } as any });
    const r = await svc({ repo }).service.canAutoVerify(makeCtx().ctx, rc()).then((v) => v, (e) => e);
    expect(r?.decision === 'allow').toBe(false);
  });
  it('never asks IdentityPort.assertRole (03-IC §4.11: the calling path authorised itself) and reads only the autoVerificationEnabled setting', async () => {
    const c = makeCtx(); await svc().service.canAutoVerify(c.ctx, rc());
    expect(c.assertCalls).toEqual([]); expect(c.settingsCalls).toEqual([{ keys: ['autoVerificationEnabled'] }]);
  });
  it('a LimsError of a dependency (common.validation_failed from qcStatusFor) passes through; the call writes nothing', async () => {
    const { service, dec } = svc({ status: { calls: [], qcStatusFor: async () => { throw Object.assign(new Error('x'), { code: 'common.validation_failed' }); } } as any });
    expect(code(await rejection(service.canAutoVerify(makeCtx().ctx, rc())))).toBe('common.validation_failed'); expect(dec.calls).toEqual([]);
  });
});

describe('tenancy and PHI (REQ-SEC-024, REQ-SEC-098, S-17)', () => {
  it('tenant comes from ctx only: a tenantId smuggled into the ResultContext is ignored; every repo call and row carries the ctx tenant', async () => {
    const { service, dec, repo } = svc({ repo: scenario({ simulating: DEF_V4 }) });
    await service.canAutoVerify(makeCtx().ctx, rc({ tenantId: TENANT_B, tenant_id: TENANT_B }));
    for (const c of repo.calls) expect(c.tenantId).toBe(TENANT_A); for (const c of dec.calls) expect(c.tenantId).toBe(TENANT_A);
    expect(JSON.stringify(dec.calls)).not.toContain(TENANT_B);
  });
  it('tenant B (no rule set) is never served tenant A\'s cached rules, even through the same service instance', async () => {
    const { service, dec } = svc(); await service.canAutoVerify(makeCtx().ctx, rc());
    expect(await service.canAutoVerify(makeCtx({ tenantId: TENANT_B }).ctx, rc())).toEqual({ decision: 'deny', reasons: ['rule_missing'] });
    expect(dec.rows().map((r) => r['tenant_id'])).toEqual([TENANT_A]);
  });
  it('unknown ResultContext fields are not copied into the row or logged (inputs = the six allowlisted keys); nothing of the inputs reaches a log line', async () => {
    const { service, dec } = svc(); const c = makeCtx();
    await service.canAutoVerify(c.ctx, rc({ patientName: SEC, sampleBarcode: SEC, valueNumeric: '4.2' }));
    expect(JSON.stringify(dec.calls)).not.toContain(SEC); expect(JSON.stringify(c.logs)).not.toMatch(new RegExp(`${SEC}|4\\.2`));
    expect(Object.keys(dec.calls[0]!.row['inputs']).sort()).toEqual(['delta_check_failed', 'instrument_flags', 'is_critical', 'range_flag', 'resulted_at', 'value_numeric']);
  });
  it('a failing call logs and throws no result value and no ids beyond codes (S-17)', async () => {
    const c = makeCtx({ settingsFail: new Error('db down') }); const e = await rejection(svc().service.canAutoVerify(c.ctx, rc({ valueNumeric: '987.654' })));
    expect(JSON.stringify({ m: e?.message, d: e?.detail, logs: c.logs })).not.toContain('987.654');
  });
  it('every row id is a fresh uuidv7 (no collisions across many calls)', async () => {
    const { service, dec } = svc({ repo: scenario({ simulating: DEF_V4 }) }); const c = makeCtx();
    for (let i = 0; i < 50; i++) await service.canAutoVerify(c.ctx, rc());
    expect(new Set(ids(dec.rows())).size).toBe(100);
  });
});

describe('rule cache and pointers (02-TRD §8.2 "cached per process keyed (tenant_id, version_id)", LIMS_QUALITY_RULE_CACHE_MAX)', () => {
  it('versions are loaded once and reused: the rule-set pointer row is read at most once per call, a version definition once across calls', async () => {
    const { service, repo } = svc({ repo: scenario({ simulating: DEF_V4 }) });
    for (let i = 0; i < 6; i++) await service.canAutoVerify(makeCtx().ctx, rc());
    expect(repo.callsOf('findRuleSet').length).toBeLessThanOrEqual(6); expect(repo.callsOf('findVersion').length).toBeLessThanOrEqual(2);
    expect(repo.calls.filter((c) => c.op === 'listVersions' || /^(insert|update)/.test(c.op))).toEqual([]);   // read-only on the rule tables
  });
  it('a new active pointer takes effect on the very next call (pointer row is not cached): the returned ruleSetVersion follows it', async () => {
    const repo = scenario({ extra: [verRow(8, 'active', { definition: def(kAny({ limits: { low: '1', high: '9' } })) })] });
    const { service } = svc({ repo });
    expect(await service.canAutoVerify(makeCtx().ctx, rc({ valueNumeric: '8' }))).toMatchObject({ decision: 'deny', ruleSetVersion: V3 });
    repo.set()['active_version_id'] = VER(8); repo.ver(3)['status'] = 'retired'; repo.ver(8)['status'] = 'active';
    expect(await service.canAutoVerify(makeCtx().ctx, rc({ valueNumeric: '8' }))).toMatchObject({ decision: 'allow', ruleSetVersion: VER(8) });
  });
  it('the compiled-rule cache is bounded (ruleCacheMax): with room for 1 version, alternating two versions re-loads; with room for 2 it does not', async () => {
    const mk = () => scenario({ simulating: DEF_V4 });
    const small = svc({ repo: mk(), ruleCacheMax: 1 }); for (let i = 0; i < 4; i++) await small.service.canAutoVerify(makeCtx().ctx, rc());
    const big = svc({ repo: mk(), ruleCacheMax: 2 }); for (let i = 0; i < 4; i++) await big.service.canAutoVerify(makeCtx().ctx, rc());
    expect(big.repo.callsOf('findVersion')).toHaveLength(2); expect(small.repo.callsOf('findVersion').length).toBeGreaterThan(2);
  });
  it('a definition the DSL cannot compile (2,000-rule cap respected) still evaluates: 2,000 rules compile and evaluate within budget', async () => {
    const rules = Array.from({ length: 2000 }, (_, i) => rule(1, { key: `R_${i}`, test_id: TEST(1), analyte_id: `01a1a98a-ac40-7000-8000-${(0x500000 + i).toString(16).padStart(12, '0')}` }));
    const { service } = svc({ repo: scenario({ active: { schema_version: 1, rules } as any }) });
    const t0 = performance.now(); const r = await service.canAutoVerify(makeCtx().ctx, rc({ analyteId: `01a1a98a-ac40-7000-8000-${(0x500000 + 1999).toString(16).padStart(12, '0')}` }));
    expect(r.decision).toBe('allow'); expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('reasons vocabulary', () => {
  it('every reason ever returned or stored is a 03-IC §4.11 AutoVerifyReason (+ qc_warning); the canonical order holds in rows', async () => {
    const { service, dec } = svc({ status: makeStatus(QC.out_of_control) });
    await service.canAutoVerify(makeCtx().ctx, rc({ isCritical: true, deltaCheckFailed: true, instrumentFlags: ['E'], valueNumeric: '99', rangeFlag: 'HH' }));
    const reasons = dec.rows('live')[0]!['reasons'] as string[];
    expect(reasons).toEqual(['critical', 'delta_failure', 'instrument_flag', 'outside_autoverify_limits', 'qc_out_of_control']);
    for (const r of reasons) expect([...REASONS, 'feature_disabled']).toContain(r);
  });
});

void [setRow, DEF_V3];
