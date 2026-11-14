// C12.T-15 contract tests for #69-#79 (consumption rules, preview, facts, manual log, resolve / dismiss / reverse): permission first on tenant-context ops, strict request schemas
// (400 common.validation_failed), rule shape per kind, If-Match (428 / 400), yaml idempotency declarations, no DB access on refusals. Seams: consumption.helpers.ts.
// Spec: 02-TRD §5.5 #69-#79, §8.3, 05-SCHEMA §2.23 / §2.24, contracts/openapi/inventory.yaml, 07-SECURITY P-B7 / PE-1. The tx is DEAD here: a refusal that touches the database fails the test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { A, PERMISSION, READ, call, calBody, deadTx, expectLims, ifm, makeConsCtx, previewBody, qcBody, reasonBody, rej, resolveBody, ruleBody, supersedeBody, uid, type LotOpts } from './consumption.helpers.js';

const TEST = uid(7001), AN = uid(16101), INST = uid(421), ITEM = uid(2001), PACK = uid(2202), RULE = uid(7001), FACT = uid(7201), STORE = uid(1001);
const NOW = '2026-11-02T04:30:00.000Z';
const fresh = (o: LotOpts = {}) => { const tx = deadTx(); return { tx, ...makeConsCtx(tx, A, { analytes: { [TEST]: [AN] }, ...o }) }; };
const yaml = readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/inventory.yaml', import.meta.url)), 'utf8');
const block = (op: string) => { const m = new RegExp(`operationId: ${op}\\r?\\n`).exec(yaml); if (!m) throw new Error(`no operation ${op} in inventory.yaml`); const j = yaml.indexOf('operationId:', m.index + 10); return yaml.slice(m.index, j < 0 ? undefined : j); };

const VALID: Record<string, any> = {
  listConsumptionRules: {},
  createConsumptionRule: { body: ruleBody('per_test', ITEM, '1', { test_id: TEST }) },
  getConsumptionRule: { params: { rule_id: RULE } },
  supersedeConsumptionRule: { params: { rule_id: RULE }, headers: ifm(1), body: supersedeBody('2') },
  deactivateConsumptionRule: { params: { rule_id: RULE }, headers: ifm(1) },
  previewConsumption: { body: previewBody('test', { test_id: TEST }) },
  listConsumptionFacts: {},
  logConsumptionEvent: { body: calBody(TEST, NOW) },
  resolveConsumptionFact: { params: { fact_id: FACT }, headers: ifm(1), body: resolveBody(STORE) },
  dismissConsumptionFact: { params: { fact_id: FACT }, headers: ifm(1), body: reasonBody('not_consumed') },
  reverseConsumptionFact: { params: { fact_id: FACT }, headers: ifm(1), body: reasonBody('logged_in_error') },
};
const TENANT_OPS = ['listConsumptionRules', 'createConsumptionRule', 'getConsumptionRule', 'supersedeConsumptionRule', 'deactivateConsumptionRule', 'previewConsumption', 'listConsumptionFacts', 'logConsumptionEvent', 'dismissConsumptionFact'];
const IF_MATCH_OPS = ['supersedeConsumptionRule', 'deactivateConsumptionRule', 'resolveConsumptionFact', 'dismissConsumptionFact', 'reverseConsumptionFact'];
const RULE_PATH = ['getConsumptionRule', 'supersedeConsumptionRule', 'deactivateConsumptionRule'];
const FACT_PATH = ['resolveConsumptionFact', 'dismissConsumptionFact', 'reverseConsumptionFact'];

describe('T-15 permission first on tenant-context operations (assertRole({permission}) without branchId; tx untouched; 403 beats 400)', () => {
  it.each(TENANT_OPS)('%s without its permission -> 403 auth.forbidden even with a broken request', async (op) => {
    const c = fresh({ permissions: [] });
    await expectLims(call(op, c.ctx, { ...VALID[op], body: VALID[op].body === undefined ? undefined : { junk: 1 }, params: { ...(VALID[op].params ?? {}) }, query: { limit: 0 } }), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION[op] });
    expect(c.tx.calls).toEqual([]);
  });
  it('permissions are not interchangeable: item.read cannot create a rule; bench.record cannot dismiss; master.manage cannot log', async () => {
    for (const [op, perm] of [['createConsumptionRule', READ], ['dismissConsumptionFact', 'inventory.bench.record'], ['logConsumptionEvent', 'inventory.master.manage']] as const) {
      const c = fresh({ permissions: [perm] });
      await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
      expect(c.tx.calls).toEqual([]);
    }
  });
});

describe('T-15 path ids and If-Match', () => {
  it.each(RULE_PATH)('%s: rule_id must be a uuid -> 400', async (op) => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], params: { rule_id: 'GLU-1' } }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); });
  it.each(FACT_PATH)('%s: fact_id must be a uuid -> 400', async (op) => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], params: { fact_id: '7201' } }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); });
  it.each(IF_MATCH_OPS)('%s without If-Match -> 428 common.precondition_required', async (op) => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], headers: {} }), 'common.precondition_required', 428); expect(c.tx.calls).toEqual([]); });
  it.each(IF_MATCH_OPS)('%s with a malformed If-Match (banana, W/"1", "0", 1, "") -> 400', async (op) => {
    for (const v of ['banana', 'W/"1"', '"0"', '1', '""']) { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], headers: { 'if-match': v } }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); }
  });
});

describe('T-15 yaml declarations: idempotency + permissions (contract the pipeline enforces)', () => {
  it.each(['createConsumptionRule', 'supersedeConsumptionRule', 'logConsumptionEvent', 'resolveConsumptionFact', 'reverseConsumptionFact'])('%s declares x-idempotency: required', (op) => { expect(block(op)).toMatch(/x-idempotency: required/); });
  it.each(Object.keys(PERMISSION))('%s declares x-permission: <spec permission>', (op) => { expect(block(op)).toContain(`x-permission: ${PERMISSION[op]}`); });
});

describe('T-15 #69 listConsumptionRules / #75 listConsumptionFacts query (strict)', () => {
  const bad = (op: string, query: Record<string, unknown>) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('#69 rule_kind outside the six kinds; ids not uuids; current_only not boolean; limit 0 / 201; unknown key', async () => {
    await bad('listConsumptionRules', { rule_kind: 'per_batch' })(); await bad('listConsumptionRules', { test_id: 'GLU' })(); await bad('listConsumptionRules', { instrument_id: 1 })(); await bad('listConsumptionRules', { item_id: 'x' })();
    await bad('listConsumptionRules', { current_only: 'maybe' })(); await bad('listConsumptionRules', { limit: 0 })(); await bad('listConsumptionRules', { limit: 201 })(); await bad('listConsumptionRules', { tenant_id: A })();
  });
  it('#75 status outside the five; fact_kind outside the six; dates not YYYY-MM-DD; ids; limit; unknown key (store_id is NOT a filter)', async () => {
    await bad('listConsumptionFacts', { status: 'open' })(); await bad('listConsumptionFacts', { fact_kind: 'per_test' })(); await bad('listConsumptionFacts', { business_date_from: '02-11-2026' })(); await bad('listConsumptionFacts', { business_date_to: '2026-11-02T00:00:00Z' })();
    await bad('listConsumptionFacts', { instrument_id: 'x' })(); await bad('listConsumptionFacts', { test_id: 5 })(); await bad('listConsumptionFacts', { limit: 201 })(); await bad('listConsumptionFacts', { store_id: uid(1001) })(); await bad('listConsumptionFacts', { tenant_id: A })();
  });
});

describe('T-15 #70 createConsumptionRule body (strict; shape rules per kind; tx untouched)', () => {
  const bad = (body: unknown) => async () => { const c = fresh(); await expectLims(call('createConsumptionRule', c.ctx, { body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('rule_kind / item_id / qty required; rule_kind in the enum; ids uuids', async () => {
    await bad({})(); await bad({ rule_kind: 'per_test', item_id: ITEM, test_id: TEST })(); await bad({ rule_kind: 'per_test', qty: '1', test_id: TEST })(); await bad({ item_id: ITEM, qty: '1', test_id: TEST })();
    await bad(ruleBody('per_batch', ITEM, '1', { test_id: TEST }))(); await bad(ruleBody('per_test', 'GLU-R1', '1', { test_id: TEST }))(); await bad(ruleBody('per_test', ITEM, '1', { test_id: 'GLU' }))();
    await bad(ruleBody('per_test', ITEM, '1', { test_id: TEST, instrument_id: 'IN-1' }))(); await bad(ruleBody('per_test', ITEM, '1', { test_id: TEST, pack_id: 'BOX' }))();
  });
  it('qty: zero, negative, signed, 13 digits, 7 decimals, a JSON number, empty, null', async () => { for (const q of ['0', '0.000000', '-1', '+1', '1234567890123', '1.1234567', 1, '', null]) await bad(ruleBody('per_test', ITEM, q as any, { test_id: TEST }))(); });
  it('notes longer than 500 chars; unknown keys (tenant_id, status, effective_from, qty_base, is_active, supersedes_rule_id)', async () => {
    await bad(ruleBody('per_test', ITEM, '1', { test_id: TEST, notes: 'x'.repeat(501) }))();
    for (const k of ['tenant_id', 'status', 'effective_from', 'qty_base', 'is_active', 'supersedes_rule_id', 'created_by']) await bad(ruleBody('per_test', ITEM, '1', { test_id: TEST, [k]: 'x' }))();
  });
  it('SHAPE: per_test / per_rerun / per_calibration without test_id or WITH analyte_id', async () => {
    for (const k of ['per_test', 'per_rerun', 'per_calibration']) { await bad(ruleBody(k, ITEM, '1'))(); await bad(ruleBody(k, ITEM, '1', { test_id: TEST, analyte_id: AN }))(); }
  });
  it('SHAPE: per_analyte needs test_id AND analyte_id', async () => { await bad(ruleBody('per_analyte', ITEM, '1', { test_id: TEST }))(); await bad(ruleBody('per_analyte', ITEM, '1', { analyte_id: AN }))(); await bad(ruleBody('per_analyte', ITEM, '1'))(); });
  it('SHAPE: per_qc needs the attribution test_id', async () => { await bad(ruleBody('per_qc', ITEM, '1', { analyte_id: AN }))(); await bad(ruleBody('per_qc', ITEM, '1'))(); });
  it('SHAPE: per_day needs instrument_id and forbids test_id / analyte_id', async () => {
    await bad(ruleBody('per_day', ITEM, '1'))(); await bad(ruleBody('per_day', ITEM, '1', { instrument_id: INST, test_id: TEST }))(); await bad(ruleBody('per_day', ITEM, '1', { instrument_id: INST, analyte_id: AN }))(); await bad(ruleBody('per_day', ITEM, '1', { test_id: TEST }))();
  });
  it('valid shapes are never a 400 (they reach the tx): per_test, per_analyte, per_rerun, per_qc with / without analyte, per_calibration, per_day, qty boundaries, 500-char notes', async () => {
    const ok: Record<string, unknown>[] = [ruleBody('per_test', ITEM, '1', { test_id: TEST }), ruleBody('per_analyte', ITEM, '0.000001', { test_id: TEST, analyte_id: AN }), ruleBody('per_rerun', ITEM, '999999999999.999999', { test_id: TEST, instrument_id: INST }),
      ruleBody('per_qc', ITEM, '1', { test_id: TEST }), ruleBody('per_qc', ITEM, '1', { test_id: TEST, analyte_id: AN }), ruleBody('per_calibration', ITEM, '2', { test_id: TEST, pack_id: PACK }), ruleBody('per_day', ITEM, '1', { instrument_id: INST, notes: 'x'.repeat(500) })];
    for (const body of ok) { const c = fresh(); const e = await rej(call('createConsumptionRule', c.ctx, { body })); expect((e as { code?: string }).code).not.toBe('common.validation_failed'); }
  });
});

describe('T-15 #72 supersede / #73 deactivate bodies', () => {
  const bad = (op: string, body: unknown) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('#72 qty required and positive; pack_id uuid; notes <= 500; unknown keys (rule_kind, item_id, test_id, instrument_id, effective_from)', async () => {
    await bad('supersedeConsumptionRule', {})(); for (const q of ['0', '-1', 'two', 2, null]) await bad('supersedeConsumptionRule', supersedeBody(q as any))();
    await bad('supersedeConsumptionRule', supersedeBody('1', { pack_id: 'KIT' }))(); await bad('supersedeConsumptionRule', supersedeBody('1', { notes: 'x'.repeat(501) }))();
    for (const k of ['rule_kind', 'item_id', 'test_id', 'instrument_id', 'effective_from', 'analyte_id']) await bad('supersedeConsumptionRule', supersedeBody('1', { [k]: 'x' }))();
  });
  it('#73 takes no body (strict: nothing to smuggle)', async () => { await bad('deactivateConsumptionRule', { is_active: true })(); await bad('deactivateConsumptionRule', { effective_to: NOW })(); });
});

describe('T-15 #74 previewConsumption body (strict; dry run)', () => {
  const bad = (body: unknown) => async () => { const c = fresh(); await expectLims(call('previewConsumption', c.ctx, { body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('fact_kind required and in the six kinds; ids uuid; at an ISO UTC instant; unknown keys', async () => {
    await bad({})(); await bad(previewBody('per_test'))(); await bad(previewBody('test', { test_id: 'GLU' }))(); await bad(previewBody('test', { analyte_id: 5 }))(); await bad(previewBody('test', { instrument_id: 'x' }))();
    for (const v of ['2026-11-02', '2026-11-02T10:00:00+05:45', 'now', 5]) await bad(previewBody('test', { at: v }))();
    for (const k of ['tenant_id', 'store_id', 'multiplier', 'observations']) await bad(previewBody('test', { [k]: 'x' }))();
  });
  it('every fact_kind and a full body are valid for the schema', async () => {
    for (const k of ['test', 'analyte', 'rerun', 'qc', 'calibration', 'fixed']) { const c = fresh(); const e = await rej(call('previewConsumption', c.ctx, { body: previewBody(k, { test_id: TEST, analyte_id: AN, instrument_id: INST, at: NOW }) })); expect((e as { code?: string }).code).not.toBe('common.validation_failed'); }
  });
});

describe('T-15 #76 logConsumptionEvent body (strict; AC-15.1 / AC-15.2 / AC-15.3 shape part)', () => {
  const bad = (body: unknown) => async () => { const c = fresh(); await expectLims(call('logConsumptionEvent', c.ctx, { body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('fact_kind (calibration | qc only), test_id, occurred_at required', async () => {
    await bad({})(); await bad({ fact_kind: 'calibration', occurred_at: NOW, reason_code: 'scheduled' })(); await bad({ fact_kind: 'calibration', test_id: TEST, reason_code: 'scheduled' })(); await bad({ test_id: TEST, occurred_at: NOW })();
    for (const k of ['test', 'rerun', 'fixed', 'analyte', 'Calibration']) await bad(calBody(TEST, NOW, { fact_kind: k }))();
  });
  it('calibration needs a reason_code and forbids observations', async () => { await bad({ fact_kind: 'calibration', test_id: TEST, occurred_at: NOW })(); await bad(calBody(TEST, NOW, { observations: 2 }))(); });
  it('observations: 0, 51, 1.5, "3", null', async () => { for (const n of [0, 51, 1.5, '3', null]) await bad(qcBody(TEST, NOW, { observations: n as any }))(); });
  it('occurred_at must be an ISO UTC instant (date only / local offset / garbage / number)', async () => { for (const v of ['2026-11-02', '2026-11-02T10:00:00+05:45', 'yesterday', 5, null]) await bad(calBody(TEST, v as any))(); });
  it('reason_code pattern; note <= 500; ids uuid; unknown keys (store_id, status, basis_key, multiplier, source)', async () => {
    for (const r of ['Scheduled', 'a b', 'a'.repeat(33), 5]) await bad(calBody(TEST, NOW, { reason_code: r }))();
    await bad(calBody(TEST, NOW, { note: 'x'.repeat(501) }))(); await bad(calBody('GLU', NOW))(); await bad(calBody(TEST, NOW, { instrument_id: 'IN-1' }))(); await bad(calBody(TEST, NOW, { analyte_id: 'x' }))();
    for (const k of ['store_id', 'status', 'basis_key', 'multiplier', 'source', 'tenant_id', 'rule_id']) await bad(calBody(TEST, NOW, { [k]: 'x' }))();
  });
  it('valid bodies are never a 400: calibration, qc (1 and 50 observations), 500-char note', async () => {
    for (const body of [calBody(TEST, NOW), qcBody(TEST, NOW), qcBody(TEST, NOW, { observations: 1, analyte_id: AN }), qcBody(TEST, NOW, { observations: 50, instrument_id: INST, note: 'x'.repeat(500) })]) {
      const c = fresh(); const e = await rej(call('logConsumptionEvent', c.ctx, { body })); expect((e as { code?: string }).code).not.toBe('common.validation_failed');
    }
  });
});

describe('T-15 #77 / #78 / #79 bodies (strict)', () => {
  const bad = (op: string, body: unknown) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('#77 store_id required uuid; unknown keys (status, fact_id)', async () => { await bad('resolveConsumptionFact', {})(); await bad('resolveConsumptionFact', { store_id: 'MAIN-A' })(); await bad('resolveConsumptionFact', { store_id: null })(); await bad('resolveConsumptionFact', { store_id: STORE, status: 'posted' })(); await bad('resolveConsumptionFact', undefined)(); });
  it.each(['dismissConsumptionFact', 'reverseConsumptionFact'])('%s reason_code required, pattern-valid, no unknown keys', async (op) => {
    await bad(op, {})(); for (const r of ['Other', 'not consumed', 'a'.repeat(33), 5, null]) await bad(op, reasonBody(r as any))(); await bad(op, { ...reasonBody('other'), status: 'x' })(); await bad(op, { ...reasonBody('other'), note: 'x' })(); await bad(op, undefined)();
  });
});

describe('T-15 #77 / #79: the row is read BEFORE any permission decision (404 beats 403, P-B8); #76 / #78 ask tenant-wide first', () => {
  it.each(['resolveConsumptionFact', 'reverseConsumptionFact'])('%s with a valid request touches the tx first; no assertRole before the row read', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
});
