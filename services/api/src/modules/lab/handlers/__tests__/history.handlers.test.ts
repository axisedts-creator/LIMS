// C5 T-19 handlers: #25 getResultHistory, #26 getAnalyteTrend (02-TRD §5.4 rows 25/26, access-log table; PRD AC-11.1–11.3; 07-SECURITY P-01 (+ #26 exception), P-02, S-22, REQ-SEC-099 no stub; 05-SCHEMA results__tenant_id_history__p_idx).
// Fails now: handlers/index.ts maps both operations to the T-01 stub (common.internal).
// Handler contract as in resultEntry.handlers.test.ts: (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated; a ctx without store/ports.IdentityPort fails closed (common.internal).
//   Schema / auth / x-permission are enforced by the core pipeline (lab.yaml is read below to pin the contract); the handlers re-check `limit` (400 common.validation_failed at /limit) and never trust the store.
// SEAM (names not in the spec, ASSUMED): ctx.store.getResults(tx, tenantId, ids) (exists, T-14) loads the base result of #25; ctx.store.listResultHistory(tx, tenantId, { patientId, analyteId, limit }) -> lab.results rows
//   (status 'approved', approved_at DESC) = repository/results.repo.ts listResultHistory. Rows are lab.v_result_current-shaped like the ResultDto mapper input: approved rows read cur_<col> when present (LATEST version, TRD getAnalyteHistory).
//   ctx.audit.access({ action: 'lab_result_history.view', entityType: 'result' (#25, entityId = result id) | 'patient' (#26, entityId = patient id), centreId?, outcome: 'allowed' }) once per call (TRD access-log table); no values in the log.
// ASSUMPTIONS (the contract is silent): #26 points are chronological (oldest -> newest) for charting, #25 data is newest first (AC-11.1); #26 drops rows without value_numeric (DecimalString); reference_band = the newest point's
//   reference snapshot (ref_low/ref_high/ref_unit_code, cur_* preferred), unit_code falls back to that point's unit_code, band omitted when the snapshot has neither bound; points keep their OWN unit_code (unit separation: the UI lists other units
//   separately — nothing is converted, merged or dropped by the API); #25 value = value_numeric ?? value_text ?? ordinal_code; the handler caps output at `limit` and drops any row of another tenant / patient / analyte or not approved (store is not trusted, AC-11.3).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b002';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const DAY = 86_400_000;
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE = u(0xa201), PATIENT = u(6), OTHER_PATIENT = u(0x66), ANALYTE = u(8), OTHER_ANALYTE = u(0x88), CUR = u(0xa1);
const LEAK = /tenant_id|created_by|updated_by|patient_id|centre_id|department_id|hold_id|manual_abnormal|order_test_id|order_id|specimen_id|EVIL|status|origin/;

/** an approved lab.v_result_current-shaped row, `daysAgo` days before NOW. */
const hrow = (id: string, daysAgo: number, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, centre_id: CENTRE, patient_id: PATIENT, analyte_id: ANALYTE, analyte_code: 'HB', order_id: u(0xc1), order_item_id: u(0xb1), specimen_id: u(5), test_id: u(7), department_id: u(9),
  status: 'approved', origin: 'manual', approved_at: new Date(NOW.getTime() - daysAgo * DAY), value_numeric: '13.4', unit_code: 'g/dL', flag: 'N', current_version_no: 1, version: 7,
  ref_range_id: u(0x10), ref_range_version: 1, ref_low: '12.0', ref_high: '16.0', ref_unit_code: 'g/dL', created_by: ACTOR, updated_by: ACTOR, ...over,
});
const base = (over: Record<string, unknown> = {}) => hrow(CUR, 0, { status: 'resulted', approved_at: null, value_numeric: '13.9', ...over });

function ctxOf(opt: { base?: any[]; hist?: any[]; leaky?: boolean; ignoreLimit?: boolean; assertRole?: (r: any) => Promise<void> } = {}) {
  const calls: { fn: string; tenantId: unknown; arg: any }[] = [], access: any[] = [], asked: any[] = [];
  const rec = (fn: string, tenantId: unknown, arg: any) => calls.push({ fn, tenantId, arg });
  const bases = new Map((opt.base ?? [base()]).map((r) => [r.id, r]));
  const hist = opt.hist ?? [];
  const store = {
    async getResults(_t: unknown, tn: unknown, ids: string[]) { rec('getResults', tn, ids); return ids.map((i) => bases.get(i)).filter(Boolean); },
    async listResultHistory(_t: unknown, tn: unknown, a: any) {
      rec('listResultHistory', tn, a);
      const rows = (opt.leaky ? hist : hist.filter((r) => r.patient_id === a.patientId && r.analyte_id === a.analyteId && r.tenant_id === tn))
        .slice().sort((x, y) => y.approved_at.getTime() - x.approved_at.getTime());
      return opt.ignoreLimit ? rows : rows.slice(0, a.limit);
    },
  };
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { id: 'tx' }, now: () => NOW, store,
    events: { async publish() { return { eventId: 'e', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: { IdentityPort: { async assertRole(_c: unknown, r: any) { asked.push(r); await opt.assertRole?.(r); } } },
  };
  return { ctx: ctx as never, calls, access, asked, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const histReq = (id: string, query: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({ params: { result_id: id, ...params }, query, headers: {}, body: undefined }) as never;
const trendReq = (patientId = PATIENT, analyteId = ANALYTE, query: Record<string, unknown> = {}) => ({ params: { patient_id: patientId, analyte_id: analyteId }, query, headers: {}, body: undefined }) as never;
const keysOf = (schema: any) => Object.keys(schema.properties);

describe('T-19 contract of lab.yaml #25 / #26 (the handlers must fit it)', () => {
  const hist = spec.paths['/v1/lab/results/{result_id}/history'].get, trend = spec.paths['/v1/lab/patients/{patient_id}/analytes/{analyte_id}/trend'].get;
  it('permission, no idempotency, limit bounds and defaults (5 / 50)', () => {
    expect(hist).toMatchObject({ operationId: 'getResultHistory', 'x-permission': 'lab.result.read', 'x-idempotency': 'none' });
    expect(trend).toMatchObject({ operationId: 'getAnalyteTrend', 'x-permission': 'lab.result.read', 'x-idempotency': 'none' });
    expect(hist.parameters.find((p: any) => p.name === 'limit').schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 20, default: 5 });
    expect(trend.parameters.find((p: any) => p.name === 'limit').schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 50, default: 50 });
  });
  it('response shapes are closed allowlists: ResultHistory {data<=20} and AnalyteTrend {points<=50, reference_band}', () => {
    const item = S.ResultHistory.properties.data.items;
    expect(S.ResultHistory.properties.data.maxItems).toBe(20);
    expect(item.additionalProperties).toBe(false);
    expect(keysOf(item).sort()).toEqual(['approved_at', 'flag', 'result_id', 'unit_code', 'value', 'version_no']);
    expect(S.AnalyteTrend.properties.points.maxItems).toBe(50);
    expect(keysOf(S.AnalyteTrend.properties.points.items).sort()).toEqual(['at', 'flag', 'result_id', 'unit_code', 'value']);
    expect(S.AnalyteTrend.properties.reference_band).toMatchObject({ additionalProperties: false, required: ['unit_code'] });
  });
});

describe('T-19 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = { getResultHistory: histReq(CUR), getAnalyteTrend: trendReq() };
  for (const op of Object.keys(REQS)) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, REQS[op], bare))).code).toBe('auth.unauthenticated');
    });
    it(`${op}: authenticated ctx without store -> common.internal (fail closed, never a 200)`, async () => {
      const c: any = ctxOf({ hist: [hrow(u(1), 1)] }).ctx; delete c.store;
      expect((await fail(run(op, REQS[op], c))).code).toBe('common.internal');
    });
  }
});

describe('T-19 getResultHistory (#25) (AC-11.1, AC-11.3, P-01, P-02)', () => {
  const three = () => [hrow(u(0x11), 10, { value_numeric: '12.9', flag: 'L', current_version_no: 1 }), hrow(u(0x12), 30, { value_numeric: '13.1' }), hrow(u(0x13), 60, { value_numeric: '14.0', flag: 'H', current_version_no: 2 })];

  it('AC-11.1: 3 earlier approved results, default limit -> 200 { data } newest first with result_id, approved_at (ISO), value, unit_code, flag, version_no; allowlist keys only, no internals', async () => {
    const c = ctxOf({ hist: three() });
    const r = await run('getResultHistory', histReq(CUR), c.ctx);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['data']);
    expect(r.body.data).toEqual([
      { result_id: u(0x11), approved_at: new Date(NOW.getTime() - 10 * DAY).toISOString(), value: '12.9', unit_code: 'g/dL', flag: 'L', version_no: 1 },
      { result_id: u(0x12), approved_at: new Date(NOW.getTime() - 30 * DAY).toISOString(), value: '13.1', unit_code: 'g/dL', flag: 'N', version_no: 1 },
      { result_id: u(0x13), approved_at: new Date(NOW.getTime() - 60 * DAY).toISOString(), value: '14.0', unit_code: 'g/dL', flag: 'H', version_no: 2 },
    ]);
    for (const d of r.body.data) for (const k of Object.keys(d)) expect(keysOf(S.ResultHistory.properties.data.items), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });

  it('the history query uses the patient and analyte of the STORED result, the tenant of ctx and limit 5 by default (AC-11.3)', async () => {
    const c = ctxOf({ hist: three() });
    await run('getResultHistory', histReq(CUR), c.ctx);
    expect(c.of('getResults')[0]).toMatchObject({ tenantId: TENANT, arg: [CUR] });
    expect(c.of('listResultHistory')).toHaveLength(1);
    expect(c.of('listResultHistory')[0]).toMatchObject({ tenantId: TENANT, arg: { patientId: PATIENT, analyteId: ANALYTE, limit: 5 } });
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
  });

  it('AC-11.3: patient_id / analyte_id / tenant_id in query or params are never read — another patient\'s history cannot be requested through a result id', async () => {
    const c = ctxOf({ hist: [...three(), hrow(u(0x21), 5, { patient_id: OTHER_PATIENT, value_numeric: '99.9' })] });
    const r = await run('getResultHistory', histReq(CUR, { patient_id: OTHER_PATIENT, analyte_id: OTHER_ANALYTE, tenant_id: 'EVIL' }, { patient_id: OTHER_PATIENT }), c.ctx);
    expect(c.of('listResultHistory')[0]!.arg).toMatchObject({ patientId: PATIENT, analyteId: ANALYTE });
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(r.body.data.map((d: any) => d.result_id)).toEqual([u(0x11), u(0x12), u(0x13)]);
  });

  it('AC-11.3 defence in depth: a store that leaks rows of another tenant / patient / analyte or of a non-approved result is not trusted — those rows are dropped', async () => {
    const c = ctxOf({
      leaky: true,
      hist: [hrow(u(0x11), 10), hrow(u(0x31), 11, { tenant_id: OTHER_TENANT, value_numeric: '77.7' }), hrow(u(0x32), 12, { patient_id: OTHER_PATIENT, value_numeric: '88.8' }),
        hrow(u(0x33), 13, { analyte_id: OTHER_ANALYTE, value_numeric: '66.6' }), hrow(u(0x34), 14, { status: 'resulted', value_numeric: '55.5' }), hrow(u(0x12), 9)],
    });
    const r = await run('getResultHistory', histReq(CUR), c.ctx);
    expect(r.body.data.map((d: any) => d.result_id)).toEqual([u(0x12), u(0x11)]);
    expect(JSON.stringify(r.body)).not.toMatch(/77\.7|88\.8|66\.6|55\.5/);
  });

  it('limit: passed to the store; output never exceeds it even when the store returns more', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => hrow(u(0x40 + i), i + 1));
    const c = ctxOf({ hist: rows, ignoreLimit: true });
    const r = await run('getResultHistory', histReq(CUR, { limit: 3 }), c.ctx);
    expect(c.of('listResultHistory')[0]!.arg.limit).toBe(3);
    expect(r.body.data.map((d: any) => d.result_id)).toEqual([u(0x40), u(0x41), u(0x42)]);
    const r20 = await run('getResultHistory', histReq(CUR, { limit: 20 }), ctxOf({ hist: Array.from({ length: 30 }, (_, i) => hrow(u(0x80 + i), i + 1)), ignoreLimit: true }).ctx);
    expect(r20.body.data).toHaveLength(20);
  });

  it('limit outside 1..20 or not an integer -> 400 common.validation_failed at /limit; nothing is read', async () => {
    const c = ctxOf({ hist: three() });
    for (const bad of [0, -1, 21, 1.5, 'x', null]) {
      const e = await fail(run('getResultHistory', histReq(CUR, { limit: bad }), c.ctx));
      expect([e.code, e.errors?.[0]?.path], String(bad)).toEqual(['common.validation_failed', '/limit']);
    }
    expect(c.calls).toHaveLength(0);
  });

  it('P-01: unknown / other-tenant result id -> 404 common.not_found, no body data, the history is never read', async () => {
    const c = ctxOf({ hist: three() });
    const e = await fail(run('getResultHistory', histReq(u(0x999)), c.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    expect(c.of('listResultHistory')).toHaveLength(0);
    expect(c.access).toHaveLength(0);
  });

  it('P-02: a centre the caller lacks is 404 common.not_found (never 403); the role asked for is lab.result.read at the result centre; the history is never read', async () => {
    const c = ctxOf({ hist: three(), assertRole: async () => { throw new LimsError('auth.forbidden'); } });
    const e = await fail(run('getResultHistory', histReq(CUR), c.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    expect(c.asked).toEqual([{ permission: 'lab.result.read', centreId: CENTRE }]);
    expect(c.of('listResultHistory')).toHaveLength(0);
    expect(c.access).toHaveLength(0);
  });

  it('unit separation: every row keeps its OWN unit_code and value (no conversion, no merging, none dropped)', async () => {
    const c = ctxOf({ hist: [hrow(u(0x11), 10, { value_numeric: '13.4', unit_code: 'g/dL' }), hrow(u(0x12), 20, { value_numeric: '134', unit_code: 'g/L' })] });
    const r = await run('getResultHistory', histReq(CUR), c.ctx);
    expect(r.body.data.map((d: any) => [d.value, d.unit_code])).toEqual([['13.4', 'g/dL'], ['134', 'g/L']]);
  });

  it('approved rows show the LATEST version (cur_* of the view); value falls back to value_text, then ordinal_code; flag/unit omitted when null', async () => {
    const c = ctxOf({
      hist: [hrow(u(0x11), 5, { value_numeric: '10.0', cur_value_numeric: '10.5', flag: 'N', cur_flag: 'H', current_version_no: 2 }),
        hrow(u(0x12), 6, { value_numeric: null, value_text: 'clear', unit_code: null, flag: null }),
        hrow(u(0x13), 7, { value_numeric: null, value_text: null, ordinal_code: 'POS', unit_code: null, flag: 'A' })],
    });
    const r = await run('getResultHistory', histReq(CUR), c.ctx);
    expect(r.body.data).toEqual([
      expect.objectContaining({ result_id: u(0x11), value: '10.5', flag: 'H', version_no: 2 }),
      { result_id: u(0x12), approved_at: expect.any(String), value: 'clear', version_no: 1 },
      { result_id: u(0x13), approved_at: expect.any(String), value: 'POS', flag: 'A', version_no: 1 },
    ]);
  });

  it('no earlier approved result -> 200 { data: [] }', async () => {
    const r = await run('getResultHistory', histReq(CUR), ctxOf().ctx);
    expect([r.status, r.body]).toEqual([200, { data: [] }]);
  });

  it('access log: exactly one lab_result_history.view row (entity result / result id), outcome allowed, no values or patient data in it', async () => {
    const c = ctxOf({ hist: three() });
    await run('getResultHistory', histReq(CUR), c.ctx);
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ action: 'lab_result_history.view', entityType: 'result', entityId: CUR, outcome: 'allowed' });
    expect(JSON.stringify(c.access)).not.toMatch(/12\.9|13\.1|14\.0|g\/dL|"patient/);
  });

  it('read only: the handler calls no write on the store and publishes no event', async () => {
    const c = ctxOf({ hist: three() });
    await run('getResultHistory', histReq(CUR), c.ctx);
    expect(c.calls.map((x) => x.fn).sort()).toEqual(['getResults', 'listResultHistory']);
  });
});

describe('T-19 getAnalyteTrend (#26) (AC-11.2, AC-11.3, P-01 exception)', () => {
  const six = () => [10, 20, 30, 40, 50, 60].map((d, i) => hrow(u(0x50 + i), d, { value_numeric: `${13 + i}.0` }));

  it('AC-11.2: 200 { points, reference_band } — points {result_id, at, value, unit_code, flag} oldest -> newest, band from the newest point\'s snapshot; allowlist keys only', async () => {
    const c = ctxOf({ hist: six() });
    const r = await run('getAnalyteTrend', trendReq(), c.ctx);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['points', 'reference_band']);
    expect(r.body.points).toHaveLength(6);
    expect(r.body.points.map((p: any) => p.at)).toEqual([...r.body.points.map((p: any) => p.at)].sort());
    expect(r.body.points[0]).toEqual({ result_id: u(0x55), at: new Date(NOW.getTime() - 60 * DAY).toISOString(), value: '18.0', unit_code: 'g/dL', flag: 'N' });
    expect(r.body.points[5]).toMatchObject({ result_id: u(0x50), value: '13.0' });
    expect(r.body.reference_band).toEqual({ low: '12.0', high: '16.0', unit_code: 'g/dL' });
    for (const p of r.body.points) for (const k of Object.keys(p)) expect(keysOf(S.AnalyteTrend.properties.points.items), k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
  });

  it('the query uses the path patient/analyte, the tenant of ctx and limit 50 by default; no other-tenant read', async () => {
    const c = ctxOf({ hist: six() });
    await run('getAnalyteTrend', trendReq(), c.ctx);
    expect(c.of('listResultHistory')).toHaveLength(1);
    expect(c.of('listResultHistory')[0]).toMatchObject({ tenantId: TENANT, arg: { patientId: PATIENT, analyteId: ANALYTE, limit: 50 } });
    expect(c.calls.every((x) => x.tenantId === TENANT)).toBe(true);
  });

  it('limit: passed through, output capped at it (store ignoring the limit), then the newest `limit` points are kept; outside 1..50 / not an integer -> 400 at /limit, nothing read', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => hrow(u(0x100 + i), i + 1));
    const c = ctxOf({ hist: rows, ignoreLimit: true });
    const r = await run('getAnalyteTrend', trendReq(PATIENT, ANALYTE, { limit: 4 }), c.ctx);
    expect(c.of('listResultHistory')[0]!.arg.limit).toBe(4);
    expect(r.body.points.map((p: any) => p.result_id)).toEqual([u(0x103), u(0x102), u(0x101), u(0x100)]);
    expect((await run('getAnalyteTrend', trendReq(), ctxOf({ hist: rows, ignoreLimit: true }).ctx)).body.points).toHaveLength(50);
    const c2 = ctxOf({ hist: rows });
    for (const bad of [0, 51, -3, 2.5, 'x', null]) {
      const e = await fail(run('getAnalyteTrend', trendReq(PATIENT, ANALYTE, { limit: bad }), c2.ctx));
      expect([e.code, e.errors?.[0]?.path], String(bad)).toEqual(['common.validation_failed', '/limit']);
    }
    expect(c2.calls).toHaveLength(0);
  });

  it('unit separation: points of a different unit keep their own unit_code and value (not converted, not dropped); the band is in the unit of the newest point\'s snapshot', async () => {
    const c = ctxOf({ hist: [hrow(u(0x11), 10, { value_numeric: '13.4' }), hrow(u(0x12), 20, { value_numeric: '134', unit_code: 'g/L', ref_low: '120', ref_high: '160', ref_unit_code: 'g/L' }), hrow(u(0x13), 30, { value_numeric: '13.0' })] });
    const r = await run('getAnalyteTrend', trendReq(), c.ctx);
    expect(r.body.points.map((p: any) => [p.value, p.unit_code])).toEqual([['13.0', 'g/dL'], ['134', 'g/L'], ['13.4', 'g/dL']]);
    expect(r.body.reference_band).toEqual({ low: '12.0', high: '16.0', unit_code: 'g/dL' });
  });

  it('only numeric points are plotted: rows without value_numeric are left out; approved rows use the latest version (cur_value_numeric)', async () => {
    const c = ctxOf({ hist: [hrow(u(0x11), 5, { value_numeric: '10.0', cur_value_numeric: '10.5' }), hrow(u(0x12), 6, { value_numeric: null, value_text: 'clear' }), hrow(u(0x13), 7, { value_numeric: null, ordinal_code: 'POS' })] });
    const r = await run('getAnalyteTrend', trendReq(), c.ctx);
    expect(r.body.points.map((p: any) => [p.result_id, p.value])).toEqual([[u(0x11), '10.5']]);
  });

  it('reference_band: one-sided band keeps only the bound that exists; unit_code falls back to the point unit; no snapshot -> no reference_band key', async () => {
    const one = await run('getAnalyteTrend', trendReq(), ctxOf({ hist: [hrow(u(0x11), 5, { ref_low: null, ref_high: '5.0', ref_unit_code: null, unit_code: 'mmol/L', value_numeric: '4.2' })] }).ctx);
    expect(one.body.reference_band).toEqual({ high: '5.0', unit_code: 'mmol/L' });
    const none = await run('getAnalyteTrend', trendReq(), ctxOf({ hist: [hrow(u(0x11), 5, { ref_range_id: null, ref_low: null, ref_high: null, ref_unit_code: null })] }).ctx);
    expect(none.status).toBe(200);
    expect(none.body.points).toHaveLength(1);
    expect(none.body).not.toHaveProperty('reference_band');
  });

  it('AC-11.3 / P-01 exception: an unknown, other-tenant or invisible patient -> 200 { points: [] } (no 404/403, no existence oracle: identical to a patient without history)', async () => {
    const c = ctxOf({ hist: [hrow(u(0x11), 5, { tenant_id: OTHER_TENANT, patient_id: u(0x777) })] });
    const foreign = await run('getAnalyteTrend', trendReq(u(0x777)), c.ctx);
    const unknown = await run('getAnalyteTrend', trendReq(u(0x778)), c.ctx);
    expect([foreign.status, foreign.body]).toEqual([200, { points: [] }]);
    expect([unknown.status, unknown.body]).toEqual([200, { points: [] }]);
    expect(JSON.stringify(c.access)).not.toMatch(/EVIL/);
  });

  it('AC-11.3 defence in depth: a store that leaks rows of another tenant / patient / analyte or of a non-approved result is not trusted — those rows are dropped', async () => {
    const c = ctxOf({
      leaky: true,
      hist: [hrow(u(0x11), 10), hrow(u(0x31), 11, { tenant_id: OTHER_TENANT, value_numeric: '77.7' }), hrow(u(0x32), 12, { patient_id: OTHER_PATIENT, value_numeric: '88.8' }),
        hrow(u(0x33), 13, { analyte_id: OTHER_ANALYTE, value_numeric: '66.6' }), hrow(u(0x34), 14, { status: 'resulted', value_numeric: '55.5' }), hrow(u(0x12), 30)],
    });
    const r = await run('getAnalyteTrend', trendReq(), c.ctx);
    expect(r.body.points.map((p: any) => p.result_id)).toEqual([u(0x12), u(0x11)]);
    expect(JSON.stringify(r.body)).not.toMatch(/77\.7|88\.8|66\.6|55\.5/);
  });

  it('body / query smuggling: tenant_id, patient_id, analyte_id in the query never replace the path ids or ctx tenant', async () => {
    const c = ctxOf({ hist: six() });
    await run('getAnalyteTrend', trendReq(PATIENT, ANALYTE, { tenant_id: 'EVIL', patient_id: OTHER_PATIENT, analyte_id: OTHER_ANALYTE }), c.ctx);
    expect(JSON.stringify(c.calls)).not.toContain('EVIL');
    expect(c.of('listResultHistory')[0]!.arg).toMatchObject({ patientId: PATIENT, analyteId: ANALYTE });
  });

  it('access log: exactly one lab_result_history.view row (entity patient / patient id), outcome allowed, no values in it; read only', async () => {
    const c = ctxOf({ hist: six() });
    await run('getAnalyteTrend', trendReq(), c.ctx);
    expect(c.access).toHaveLength(1);
    expect(c.access[0]).toMatchObject({ action: 'lab_result_history.view', entityType: 'patient', entityId: PATIENT, outcome: 'allowed' });
    expect(JSON.stringify(c.access)).not.toMatch(/13\.0|14\.0|g\/dL/);
    expect(c.calls.map((x) => x.fn)).toEqual(['listResultHistory']);
  });
});
