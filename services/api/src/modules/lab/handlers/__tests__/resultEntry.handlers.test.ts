// C5 T-14 handlers: bulkEnterResults (#24), getResult (#23), listOrderResults (#16) (02-TRD §5.2/§5.4; REQ-SEC-099 no stub; 07-SECURITY P-01/P-02/S-12/S-19).
// Fails now: handlers/index.ts maps all three to the T-01 stub (common.internal).
// Handler contract (same as billing/credit.handlers.test.ts): (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated.
//   Schema / auth / x-permission / Idempotency-Key are enforced by the core pipeline, NOT here. Body is snake_case (contract), the service takes camelCase (see service/__tests__/result.service.enter.test.ts).
// SEAM: the handler uses the production store/ports unless the ctx supplies them: `ctx.store` (ResultStore of result.service.ts, see that test's header), `ctx.ports.{CatalogPort,IdentityPort}`, `ctx.events`, `ctx.audit`
//   (ASSUMED test-injection point, same as the service ctx; production wiring supplies the real ones). Reads: store.getResults(tx, tenantId, ids) and
//   store.getOrderResults(tx, tenantId, { orderId, departmentId? }) -> { order: LabOrderDto (already mapped), items: { orderItemId, testId, testCode, results: ResultRow[] }[] } | undefined.
// LD-25 (2026-11-07, A33-2 downtime mode) limits are tested HERE (the core schema in lab.yaml has no entry_mode/occurred_at/downtime_ref yet -> notes "LD-25 gaps"): entry_mode live|downtime_backentry, occurred_at in
//   [now - 72 h, now] (tenant setting downtime_backentry_max_hours has no column: default only), downtime_ref 1..32 chars, back-entry-only fields rejected on live (no back-dating of anything else).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const DTO_KEYS: string[] = Object.keys(spec.components.schemas.ResultDto.properties);
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const H = 3_600_000;
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const R1 = u(0xa1), R2 = u(0xa2), ORDER = u(0xc1), ITEM = u(0xb1), CENTRE = u(0xa201);

const dbRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, centre_id: CENTRE, patient_id: u(6), order_id: ORDER, order_item_id: ITEM, specimen_id: u(5), test_id: u(7), analyte_id: u(8), analyte_code: 'HB', status: 'resulted', origin: 'manual',
  value_numeric: '13.4', unit_code: 'g/dL', flag: 'N', range_unavailable_age_unknown: false, is_critical: false, on_hold: false, qc_review_required: false, unit_mismatch: false, current_version_no: 1, version: 4, created_by: u(0xc1), ...over,
});
const eRow = (id: string) => ({ resultId: id, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: u(5), patientId: u(6), testId: u(7), analyteId: u(8), centreId: CENTRE, currentVersionNo: 1, sex: 'female',
  patientAgeDays: 10950, specimenTypeCode: 'WB', unitCode: 'g/dL', analyte: { id: u(8), code: 'HB', resultType: 'numeric', decimals: 1 } });

function ctxOf(over: { rows?: any[]; stored?: any[]; order?: any; assertRole?: (r: any) => Promise<void> } = {}) {
  const calls: { fn: string; tenantId: unknown; arg: any }[] = [];
  const access: any[] = [];
  const asked: any[] = [];
  const rec = (fn: string, tenantId: unknown, arg: any) => calls.push({ fn, tenantId, arg });
  const entryRows = new Map((over.rows ?? [eRow(R1), eRow(R2)]).map((r) => [r.resultId, r]));
  const stored = new Map((over.stored ?? [dbRow(R1), dbRow(R2)]).map((r) => [r.id, r]));
  const store = {
    async lockResults(_t: unknown, tn: unknown, ids: string[]) { rec('lockResults', tn, ids); return ids.map((i) => entryRows.get(i)).filter(Boolean); },
    async deltaInputs() { return { candidates: [] }; },
    async saveEntry(_t: unknown, tn: unknown, a: any) { rec('saveEntry', tn, a); return dbRow(a.resultId, { status: 'resulted', value_numeric: a.value?.numeric, version: a.expectedRowVersion + 1 }); },
    async rollupSpecimen(_t: unknown, tn: unknown, s: string) { rec('rollupSpecimen', tn, s); },
    async getResults(_t: unknown, tn: unknown, ids: string[]) { rec('getResults', tn, ids); return ids.map((i) => stored.get(i)).filter(Boolean); },
    async getOrderResults(_t: unknown, tn: unknown, a: any) { rec('getOrderResults', tn, a); return a.orderId === ORDER ? (over.order ?? { order: { order_id: ORDER, registration_no: 'R2606150001', specimens: [], order_tests: [] }, items: [{ orderItemId: ITEM, testId: u(7), testCode: 'CBC', results: [dbRow(R1), dbRow(R2)] }] }) : undefined; },
    async listCriticalLog() { return []; }, async insertCriticalLog() { return { criticalEventId: u(0xe1) }; }, async markCriticalValueChanged() {},
    async listCalculatedTargets() { return []; }, async listInputs() { return []; }, async inputUnitByCode() { return {}; }, async applyComputed() {}, async amendCalculated() {},
  };
  const ctx = {
    operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { id: 'tx' }, now: () => NOW, store,
    events: { async publish() { return { eventId: 'e', duplicate: false }; } },
    audit: { async access(e: unknown) { access.push(e); } },
    ports: {
      CatalogPort: { async referenceRangeFor() { return { referenceRangeId: u(0x10), version: 1, low: '12.0', high: '16.0', unitCode: 'g/dL' }; }, async criticalLimitsFor() { return undefined; },
        // T-18 (CR-C5-001): codes are re-resolved server-side; this fake knows every code.
        async resolveCommentCodes(_c: unknown, q: { codes: string[] }) { const up = [...new Set(q.codes.map((c) => c.toUpperCase()))]; return { resolved: up.map((c) => ({ code: c, commentCodeId: `cc-${c}`, version: 1, text: `Library text ${c}` })), unknown: [] }; } },
      IdentityPort: { async assertRole(_c: unknown, r: any) { asked.push(r); await over.assertRole?.(r); } },
    },
  };
  return { ctx: ctx as never, calls, access, asked, saves: () => calls.filter((c) => c.fn === 'saveEntry').map((c) => c.arg) };
}
const run = (op: string, req: unknown, c: unknown): Promise<any> => (handlers as any)[op](req, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const bulkReq = (body: unknown) => ({ params: {}, query: {}, headers: { 'idempotency-key': 't14-1' }, body }) as never;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('T-14 are real handlers, not the T-01 stub (REQ-SEC-099)', () => {
  const REQS: Record<string, unknown> = {
    bulkEnterResults: bulkReq({ entries: [{ result_id: R1, version: 3, value_numeric: '13.4' }] }),
    getResult: { params: { result_id: R1 }, query: {}, headers: {}, body: undefined },
    listOrderResults: { params: { order_id: ORDER }, query: {}, headers: {}, body: undefined },
  };
  for (const op of Object.keys(REQS))
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, REQS[op], bare))).code).toBe('auth.unauthenticated');
    });
  it('mapped to functions distinct from the shared stub', () => {
    const stub = (handlers as any).getResultHistory;
    for (const op of Object.keys(REQS)) expect((handlers as any)[op], op).not.toBe(stub);
  });
});

describe('T-14 bulkEnterResults (#24) request -> service -> response', () => {
  it('200 with { results, recomputed }; ok row carries the mapped ResultDto, snake_case keys inside the allowlist, no internals', async () => {
    const c = ctxOf();
    const r = await run('bulkEnterResults', bulkReq({ entries: [{ result_id: R1, version: 3, value_numeric: '13.4', comment_text: 'ok' }] }), c.ctx);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['recomputed', 'results']);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ result_id: R1, outcome: 'ok' });
    const dto = r.body.results[0].result;
    expect(dto).toMatchObject({ id: R1, status: 'resulted', origin: 'manual' });
    for (const k of Object.keys(dto)) expect(DTO_KEYS, k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|patient_id|centre_id/);
    expect(c.saves()[0]).toMatchObject({ resultId: R1, expectedRowVersion: 3, value: { numeric: '13.4' }, commentText: 'ok' });
  });
  it('per-row outcome: bad value + stale version + good row -> 200, errors inline with code and without result', async () => {
    const c = ctxOf();
    const r = await run('bulkEnterResults', bulkReq({ entries: [{ result_id: R1, version: 3, value_numeric: '13.45' }, { result_id: R2, version: 1, value_numeric: '13.4' }] }), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => [x.outcome, x.code])).toEqual([['error', 'lab.result_value_invalid'], ['error', 'common.version_conflict']]);
    for (const x of r.body.results) expect(x).not.toHaveProperty('result');
    expect(JSON.stringify(r.body)).not.toContain('13.45');           // S-19
  });
  it('ordinal_code / value_text / manual_abnormal / comment_codes are mapped to camelCase service input', async () => {
    const c = ctxOf({ rows: [{ ...eRow(R1), analyte: { id: u(8), code: 'U', resultType: 'text' } }] });
    await run('bulkEnterResults', bulkReq({ entries: [{ result_id: R1, version: 3, value_text: 'clear', manual_abnormal: true, comment_codes: ['HEMOLYSED'] }] }), c.ctx);
    expect(c.saves()[0]).toMatchObject({ value: { text: 'clear' }, manualAbnormal: true, commentCodes: ['HEMOLYSED'] });
  });
  it('1..200 entries: [] and 201 -> 400 common.validation_failed at /entries, nothing saved', async () => {
    const c = ctxOf();
    for (const entries of [[], Array.from({ length: 201 }, () => ({ result_id: R1, version: 3, value_numeric: '1' }))]) {
      const e = await fail(run('bulkEnterResults', bulkReq({ entries }), c.ctx));
      expect(e.code).toBe('common.validation_failed');
      expect(e.statusCode).toBe(400);
      expect((e.errors ?? []).map((x: any) => x.path)).toContain('/entries');
    }
    expect(c.saves()).toHaveLength(0);
  });
  it('tenant comes from ctx only: a tenant_id in the body is ignored', async () => {
    const c = ctxOf();
    await run('bulkEnterResults', bulkReq({ tenant_id: 'EVIL', entries: [{ result_id: R1, version: 3, value_numeric: '13.4', tenant_id: 'EVIL' }] }), c.ctx);
    for (const x of c.calls) expect(x.tenantId, x.fn).toBe(TENANT);
    expect(JSON.stringify(c.calls.map((x) => x.arg))).not.toContain('EVIL');
  });
});

describe('T-14 LD-25 downtime back-entry limits (handler level)', () => {
  const back = (o: Record<string, unknown> = {}) => ({ entry_mode: 'downtime_backentry', occurred_at: iso(-2 * H), downtime_ref: 'PB-000123', ...o });
  const body = (extra: Record<string, unknown>) => ({ ...extra, entries: [{ result_id: R1, version: 3, value_numeric: '13.4' }] });
  async function failsAt(extra: Record<string, unknown>, path: string) {
    const c = ctxOf();
    const e = await fail(run('bulkEnterResults', bulkReq(body(extra)), c.ctx));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect((e.errors ?? []).map((x: any) => x.path)).toContain(path);
    expect(c.saves()).toHaveLength(0);
    expect(c.access).toHaveLength(0);
  }
  it('accepted: 2 h old paper form -> 200, store gets occurredAt + downtimeRef, audit names entry_mode + serial + original time', async () => {
    const c = ctxOf();
    const b = back();
    const r = await run('bulkEnterResults', bulkReq(body(b)), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body.results[0].outcome).toBe('ok');
    expect(c.saves()[0].downtime).toEqual({ occurredAt: b.occurred_at, downtimeRef: 'PB-000123' });
    const audit = JSON.stringify(c.access);
    expect(audit).toContain('downtime_backentry');
    expect(audit).toContain('PB-000123');
    expect(audit).toContain(b.occurred_at);
  });
  it('response never echoes the back-dated time or paper serial (the server keeps its own created_at)', async () => {
    const c = ctxOf();
    const r = await run('bulkEnterResults', bulkReq(body(back())), c.ctx);
    expect(JSON.stringify(r.body)).not.toContain('PB-000123');
  });
  it('entry_mode live (default) is unchanged: no downtime, no audit', async () => {
    const c = ctxOf();
    for (const extra of [{}, { entry_mode: 'live' }]) {
      expect((await run('bulkEnterResults', bulkReq(body(extra)), c.ctx)).status).toBe(200);
    }
    for (const s of c.saves()) expect(s.downtime).toBeUndefined();
    expect(c.access).toHaveLength(0);
  });
  it('boundaries inclusive: occurred_at = now, = now - 72 h; downtime_ref of exactly 32 chars', async () => {
    for (const b of [back({ occurred_at: iso(0) }), back({ occurred_at: iso(-72 * H) }), back({ downtime_ref: 'x'.repeat(32) })]) {
      const c = ctxOf();
      expect((await run('bulkEnterResults', bulkReq(body(b)), c.ctx)).status).toBe(200);
    }
  });
  it('occurred_at missing for back-entry', () => failsAt({ entry_mode: 'downtime_backentry', downtime_ref: 'PB-1' }, '/occurred_at'));
  it('downtime_ref missing for back-entry', () => failsAt({ entry_mode: 'downtime_backentry', occurred_at: iso(-H) }, '/downtime_ref'));
  it('occurred_at in the future (now + 1 s)', () => failsAt(back({ occurred_at: iso(1000) }), '/occurred_at'));
  it('occurred_at older than the 72 h window (now - 72 h - 1 s)', () => failsAt(back({ occurred_at: iso(-72 * H - 1000) }), '/occurred_at'));
  it('occurred_at not an ISO instant', () => failsAt(back({ occurred_at: 'yesterday' }), '/occurred_at'));
  it('downtime_ref 33 chars', () => failsAt(back({ downtime_ref: 'x'.repeat(33) }), '/downtime_ref'));
  it('downtime_ref empty', () => failsAt(back({ downtime_ref: '' }), '/downtime_ref'));
  it('unknown entry_mode', () => failsAt({ entry_mode: 'backdated' }, '/entry_mode'));
  it('live entry carrying occurred_at or downtime_ref is rejected (no back-dating of anything else)', async () => {
    await failsAt({ occurred_at: iso(-H) }, '/occurred_at');
    await failsAt({ entry_mode: 'live', downtime_ref: 'PB-1' }, '/downtime_ref');
  });
});

describe('T-14 getResult (#23)', () => {
  const req = (id: string) => ({ params: { result_id: id }, query: {}, headers: {}, body: undefined }) as never;
  it('200 ResultDto within the allowlist; tenant from ctx; authz asked for lab.result.read on the row centre AFTER the object load', async () => {
    const c = ctxOf();
    const r = await run('getResult', req(R1), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: R1, analyte_code: 'HB', status: 'resulted' });
    for (const k of Object.keys(r.body)) expect(DTO_KEYS, k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|patient_id/);
    expect(c.calls.find((x) => x.fn === 'getResults')).toMatchObject({ tenantId: TENANT, arg: [R1] });
    expect(c.asked).toEqual([expect.objectContaining({ permission: 'lab.result.read', centreId: CENTRE })]);
  });
  it('P-01: id not visible (other tenant / unknown) -> 404 common.not_found, body without data', async () => {
    const e = await fail(run('getResult', req(u(0xff)), ctxOf().ctx));
    expect(e.code).toBe('common.not_found');
    expect(e.statusCode).toBe(404);
  });
  it('P-02: row of a centre the user lacks (assertRole auth.forbidden) -> 404 common.not_found, never 403, no row data', async () => {
    const e = await fail(run('getResult', req(R1), ctxOf({ assertRole: async () => { throw new LimsError('auth.forbidden'); } }).ctx));
    expect(e.code).toBe('common.not_found');
    expect(JSON.stringify(e.errors ?? [])).not.toContain('13.4');
  });
});

describe('T-14 listOrderResults (#16)', () => {
  const req = (orderId: string, query: Record<string, unknown> = {}) => ({ params: { order_id: orderId }, query, headers: {}, body: undefined }) as never;
  it('200 { order, items:[{ order_item_id, test:{test_id,test_code}, results: ResultDto[] }] }; results mapped through the allowlist', async () => {
    const c = ctxOf();
    const r = await run('listOrderResults', req(ORDER), c.ctx);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ order_id: ORDER, registration_no: 'R2606150001' });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ order_item_id: ITEM, test: { test_id: u(7), test_code: 'CBC' } });
    expect(r.body.items[0].results.map((x: any) => x.id)).toEqual([R1, R2]);
    for (const x of r.body.items[0].results) for (const k of Object.keys(x)) expect(DTO_KEYS, k).toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|created_by|patient_id/);
  });
  it('department_id filter forwarded; tenant from ctx', async () => {
    const c = ctxOf();
    await run('listOrderResults', req(ORDER, { department_id: u(0x99) }), c.ctx);
    expect(c.calls.find((x) => x.fn === 'getOrderResults')).toMatchObject({ tenantId: TENANT, arg: { orderId: ORDER, departmentId: u(0x99) } });
  });
  it('P-01: unknown / other-tenant order -> 404 common.not_found', async () => {
    const e = await fail(run('listOrderResults', req(u(0xdead)), ctxOf().ctx));
    expect(e.code).toBe('common.not_found');
  });
  it('P-02: order with no result rows (not accessioned / filter matches nothing) is authorised on the ORDER centre (store returns centreId) -> user lacking it gets 404, no order block', async () => {
    const order = { centreId: CENTRE, order: { order_id: ORDER, registration_no: 'R2606150001', specimens: [], order_tests: [] }, items: [] };
    const c = ctxOf({ order, assertRole: async (r) => { if (r.centreId === CENTRE) throw new LimsError('auth.forbidden'); } });
    const e = await fail(run('listOrderResults', req(ORDER), c.ctx));
    expect(e.code).toBe('common.not_found');
    expect(e.statusCode).toBe(404);
    expect(c.asked[0]).toMatchObject({ permission: 'lab.result.read', centreId: CENTRE });
    expect(JSON.stringify(e.errors ?? [])).not.toContain('R2606150001');
  });
  it('lab.result.read is asserted (front_desk has none): assertRole rejection surfaces as 404, no results', async () => {
    const c = ctxOf({ assertRole: async () => { throw new LimsError('auth.forbidden'); } });
    const e = await fail(run('listOrderResults', req(ORDER), c.ctx));
    expect(e.code).toBe('common.not_found');
    expect(c.asked[0]).toMatchObject({ permission: 'lab.result.read' });
  });
});
