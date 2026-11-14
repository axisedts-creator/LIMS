// C12.T-19 contract tests for #92 getInventoryReport and #93 exportInventoryReport: permission gates, centreScope.all rule, strict query schema (400 common.validation_failed), the 366-day cap
// (422 inventory.range_too_large, CR-C12-003), x-permission / x-idempotency declarations, no DB access and no access-log entry on refusals. Spec: 02-TRD §5.5 / §5.10, PRD AC-21.7 / AC-21.8,
// 07-SECURITY P-B6 / PE-1 / PE-3 / abuse controls, contracts/openapi/inventory.yaml. Seams: reports.helpers.ts (header).
// The tx is DEAD here: a refusal that touches the database fails the test. Row-dependent behaviour (golden datasets, 404 by branch, CSV, caps) lives in reports.integration.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { A, BR1_ONLY, COST, EXPORT, NO_COST, OPS, PERMISSION, READ, READ_ONLY, REPORTS, call, deadTx, expectLims, makeRepCtx, rej, rep, uid, win, type RepOpts } from './reports.helpers.js';

const fresh = (o: RepOpts = {}) => { const tx = deadTx(); return { tx, ...makeRepCtx(tx, A, o) }; };
const W = win('2026-03-02', '2026-03-05');
const WINDOWED = ['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'consumption_reconciliation'] as const;
const yaml = readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/inventory.yaml', import.meta.url)), 'utf8');
const block = (op: string) => { const m = new RegExp(`operationId: ${op}\\r?\\n`).exec(yaml); if (!m) throw new Error(`no operation ${op} in inventory.yaml`); const j = yaml.indexOf('operationId:', m.index + 10); return yaml.slice(m.index, j < 0 ? undefined : j); };
const bad = (op: string, code: string, query: Record<string, unknown>, o: RepOpts = {}) => async () => {
  const c = fresh(o);
  await expectLims(call(op, c.ctx, rep(code, query)), 'common.validation_failed', 400);
  expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
};

describe('T-19 contract declarations', () => {
  it.each(Object.entries(PERMISSION))('%s x-permission is %s', (op, p) => { expect(block(op)).toContain(`x-permission: ${p}`); });
  it('no idempotency key on either operation (read-only)', () => { for (const op of Object.values(OPS)) expect(block(op)).toMatch(/x-idempotency: none/); });
  it('the error codes the algorithm can return are declared per operation', () => {
    expect(block(OPS.get)).toContain('inventory.range_too_large');
    for (const c of ['inventory.export_too_large', 'inventory.range_too_large']) expect(block(OPS.csv)).toContain(c);
  });
  it('the report_code enum has exactly the seven reports of the TRD (path parameter of both operations)', () => {
    for (const op of Object.values(OPS)) for (const r of REPORTS) expect(block(op)).toContain(`- ${r}`);
  });
});

describe('T-19 #92 getInventoryReport: permission first, cost_per_test is money-only, reconciliation needs all centres (AC-21.7 / AC-21.9, P-B6, PE-3)', () => {
  it('without inventory.item.read -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call(OPS.get, c.ctx, rep('daily_consumption', W)), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: READ });
    expect(c.tx.calls).toEqual([]);
  });
  it('permission before validation (403, not 400) and before the report_code lookup', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call(OPS.get, c.ctx, rep('daily_consumption', { tenant_id: A, within_days: 0 })), 'auth.forbidden', 403);
    await expectLims(call(OPS.get, c.ctx, rep('no_such_report', {})), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  it('cost_per_test without inventory.cost.read -> 403 auth.forbidden (the report is money-only), no tx statement', async () => {
    const c = fresh(READ_ONLY);
    await expectLims(call(OPS.get, c.ctx, rep('cost_per_test', W)), 'auth.forbidden', 403);
    expect(c.roleCalls.map((r) => r.permission)).toContain(COST);
    expect(c.roleCalls.every((r) => r.branchId === undefined)).toBe(true);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(['daily_consumption', 'analyser_consumption', 'wastage', 'expiry', 'stock_valuation'])('%s does NOT require inventory.cost.read (cost columns are stripped instead): the gate lets READ_ONLY through to the database', async (code) => {
    const c = fresh(READ_ONLY);
    const e = await rej(call(OPS.get, c.ctx, rep(code, W)));
    expect((e as { message?: string }).message).toMatch(/tx touched/); // passed every gate and reached the first statement
    expect(c.roleCalls.map((r) => r.permission)).not.toContain(COST);
  });
  it('consumption_reconciliation with centreScope.all = false -> 403 auth.forbidden (lab.v_pub_result_daily is centre-scoped for the caller), no tx statement', async () => {
    const c = fresh({ all: false, branchIds: [uid(19990)] });
    await expectLims(call(OPS.get, c.ctx, rep('consumption_reconciliation', W)), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  it('the all-centres rule is specific to the reconciliation: another report with all = false reaches the database', async () => {
    const c = fresh(BR1_ONLY);
    const e = await rej(call(OPS.get, c.ctx, rep('daily_consumption', W)));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
  });
});

describe('T-19 #92 strict query (400) and the date range cap (422 inventory.range_too_large)', () => {
  const op = OPS.get;
  it('unknown report_code -> 400 or 404, tx untouched', async () => {
    const c = fresh();
    const e: any = await rej(call(op, c.ctx, rep('no_such_report', W)));
    expect([400, 404]).toContain(e.statusCode); expect(c.tx.calls).toEqual([]);
  });
  it('unknown query keys (tenant_id smuggle, limit, status, centre_id)', async () => {
    for (const k of ['tenant_id', 'limit', 'status', 'centre_id', 'created_by']) await bad(op, 'daily_consumption', { ...W, [k]: A })();
  });
  it.each(['store_id', 'branch_id', 'instrument_id', 'test_id', 'item_id'])('%s must be a uuid (also an injection string)', async (k) => {
    await bad(op, 'daily_consumption', { ...W, [k]: 'MAIN' })();
    await bad(op, 'daily_consumption', { ...W, [k]: `${uid(1)}' OR '1'='1` })();
  });
  it('dates must be real ISO dates (business_date_from / _to / as_of)', async () => {
    for (const k of ['business_date_from', 'business_date_to', 'as_of']) { await bad(op, 'daily_consumption', { ...W, [k]: '2026-02-30' })(); await bad(op, 'daily_consumption', { ...W, [k]: 'yesterday' })(); await bad(op, 'daily_consumption', { ...W, [k]: '2026-3-1' })(); }
  });
  it('within_days is an integer 1..365', async () => { for (const v of [0, 366, -1, 1.5, 'x']) await bad(op, 'expiry', { within_days: v })(); });
  it('group_by: pattern ^[a-z][a-z0-9_]{0,31}$ (no SQL text) and a value the report does not know is refused', async () => {
    for (const g of ['Store', 'store;drop table inventory.items', "store' --", 'a'.repeat(33), '1store', 'store name']) await bad(op, 'daily_consumption', { ...W, group_by: g })();
    for (const r of REPORTS) await bad(op, r, { ...W, group_by: 'no_such_grouping' }, { all: true })();
  });
  it.each(WINDOWED)('%s: a window of 367 days -> 422 inventory.range_too_large, tx untouched, nothing logged', async (code) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, rep(code, win('2026-01-01', '2027-01-03'))), 'inventory.range_too_large', 422);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('the cap is read from LIMS_INVENTORY_REPORT_MAX_DAYS at call time (10 days allowed, 11 refused)', async () => {
    const was = process.env['LIMS_INVENTORY_REPORT_MAX_DAYS'];
    process.env['LIMS_INVENTORY_REPORT_MAX_DAYS'] = '10';
    try {
      const c = fresh();
      await expectLims(call(op, c.ctx, rep('daily_consumption', win('2026-03-01', '2026-03-12'))), 'inventory.range_too_large', 422);
      expect(c.tx.calls).toEqual([]);
      const d = fresh();
      const e = await rej(call(op, d.ctx, rep('daily_consumption', win('2026-03-01', '2026-03-11'))));
      expect((e as { message?: string }).message).toMatch(/tx touched/); // 10 days passes the cap and reaches the database
    } finally { if (was === undefined) delete process.env['LIMS_INVENTORY_REPORT_MAX_DAYS']; else process.env['LIMS_INVENTORY_REPORT_MAX_DAYS'] = was; }
  });
});

describe('T-19 #93 exportInventoryReport: privileged export permission first, same gates as #92, nothing logged on a refusal (AC-21.8, PE-1)', () => {
  const op = OPS.csv;
  it('without inventory.report.export -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched; no access log', async () => {
    const c = fresh(READER);
    await expectLims(call(op, c.ctx, rep('daily_consumption', W)), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: EXPORT });
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('aal1 -> 403 auth.mfa_required (privileged permission, PE-1); permission before validation', async () => {
    const c = fresh({ aal: 'aal1' });
    await expectLims(call(op, c.ctx, rep('daily_consumption', W)), 'auth.mfa_required', 403);
    await expectLims(call(op, c.ctx, rep('daily_consumption', { tenant_id: A })), 'auth.mfa_required', 403);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('inventory.item.read is NOT needed for the export (only report.export)', async () => {
    const c = fresh({ permissions: [EXPORT] });
    const e = await rej(call(op, c.ctx, rep('daily_consumption', W)));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls.map((r) => r.permission)).toEqual([EXPORT]);
  });
  it('cost_per_test needs inventory.cost.read as well -> 403 auth.forbidden (PE-3)', async () => {
    const c = fresh(NO_COST);
    await expectLims(call(op, c.ctx, rep('cost_per_test', W)), 'auth.forbidden', 403);
    expect(c.roleCalls.map((r) => r.permission)).toEqual([EXPORT, COST]);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('consumption_reconciliation with centreScope.all = false -> 403 auth.forbidden (same rule as #92)', async () => {
    const c = fresh({ all: false, branchIds: [uid(19990)] });
    await expectLims(call(op, c.ctx, rep('consumption_reconciliation', W)), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('strict query as #92: unknown key, bad uuid, bad date, bad within_days, group_by injection', async () => {
    await bad(op, 'daily_consumption', { ...W, tenant_id: A })();
    await bad(op, 'daily_consumption', { ...W, store_id: 'MAIN' })();
    await bad(op, 'daily_consumption', { ...W, business_date_to: '2026-02-30' })();
    await bad(op, 'expiry', { within_days: 366 })();
    await bad(op, 'daily_consumption', { ...W, group_by: 'store;drop table x' })();
  });
  it.each(WINDOWED)('%s: 367 days -> 422 inventory.range_too_large (no rows read, nothing logged)', async (code) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, rep(code, win('2026-01-01', '2027-01-03'))), 'inventory.range_too_large', 422);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
});
