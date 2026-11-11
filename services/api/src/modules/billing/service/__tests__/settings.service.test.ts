// BL-T05 settings service: B32 get/updateBillingSettings (lazy defaults, If-Match version, series-scope rules) and B34 listBillingCodes.
// PRD US-BL-01.5; 02-TRD §6 B32/B34, §11.2, §12 step 0; 08 A13 D-23; contracts/openapi/billing.yaml BillingSettings / CodedSetList.
// Fails now: ../settings.service.js does not exist.
// ASSUMED API (spec fixes the endpoints, not the service; writer: object via a dispute if wrong):
//   settings.service.ts : createSettingsService(deps?: { repo?: SettingsRepo }) -> { getSettings(ctx), updateSettings(ctx, { expectedVersion, patch }), listCodes(ctx, { setName }) }
//   (same shape as services/reporting settings.service: tenant + actor come from ctx only, bodies are the snake_case OpenAPI shapes).
//   SettingsRepo (default = ../repository/settings.repo.js, which today only has getBillingSettings; BL-T05 adds the rest):
//     getBillingSettings(tx,{tenantId})                                   -> row | undefined          (raw DB row: snake_case, bigint column as string)
//     insertDefaultBillingSettings(tx,{tenantId,userId})                  -> row | undefined          (ON CONFLICT DO NOTHING: undefined = a concurrent request created it)
//     updateBillingSettings(tx,{tenantId,userId,expectedVersion,values})  -> row | undefined          (undefined = version mismatch; version = version + 1)
//     hasInvoiceInFiscalYear(tx,{tenantId,fiscalYearBs})                  -> boolean
//     listCodes(tx,{tenantId,setName})                                    -> rows {code,display,sort_order,is_active,...} (global + tenant rows merged by the repo)
//   Tenant numbering pattern: ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: [... 'numbering' ...] }) -> { numbering: { invoiceNoPattern } } (no local copy, TRD §11.2).
//   Fiscal year of "now": fiscalYearOf(ctx.now()) (tenant timezone is Asia/Kathmandu in v1, 08 A13 P-15).
//   Errors: missing expectedVersion -> common.precondition_required; non-int32 / < 1 -> common.validation_failed (path /If-Match); repo undefined on update -> common.version_conflict;
//           bad body -> common.validation_failed with errors[].path = '/<field>'; B32 scope rules -> common.validation_failed with errors[0].path '/invoice_series_scope'.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { createSettingsService } from '../settings.service.js';

const TENANT_ROW = {
  tenant_id: '01a1a98a-ac40-7000-8000-00000000a001', invoice_series_scope: 'tenant', prices_include_tax: false, abbreviated_invoice_enabled: false, pay_by_qr_enabled: false,
  receipt_no_enabled: true, credit_days_auto_lock: true, cash_variance_alert_paisa: '0', refund_alert_per_day: 5, version: 3, is_active: true,
  created_at: '2026-11-01T00:00:00Z', created_by: '01a1b34e-1000-7eee-9d29-d7ca59a102b5', updated_at: '2026-11-02T00:00:00Z', updated_by: '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
};
const BODY_KEYS = ['abbreviated_invoice_enabled', 'cash_variance_alert_paisa', 'credit_days_auto_lock', 'invoice_series_scope', 'pay_by_qr_enabled', 'prices_include_tax',
  'receipt_no_enabled', 'refund_alert_per_day', 'version'];
const FULL = { invoice_series_scope: 'tenant', prices_include_tax: false, abbreviated_invoice_enabled: false, pay_by_qr_enabled: false, receipt_no_enabled: true,
  credit_days_auto_lock: true, cash_variance_alert_paisa: 0, refund_alert_per_day: 5 };

interface Calls { name: string; args: any }
function makeRepo(o: { row?: any; insertRow?: any; invoiceInFy?: boolean; codes?: any[]; updateRow?: any } = {}) {
  const calls: Calls[] = [];
  let row = 'row' in o ? o.row : { ...TENANT_ROW };
  const repo = {
    async getBillingSettings(_tx: unknown, a: any) { calls.push({ name: 'get', args: a }); return row; },
    async insertDefaultBillingSettings(_tx: unknown, a: any) {
      calls.push({ name: 'insert', args: a });
      if ('insertRow' in o) { if (o.insertRow) row = o.insertRow; return o.insertRow; }
      row = { ...TENANT_ROW, version: 1, created_by: a.userId, updated_by: a.userId }; return row;
    },
    async updateBillingSettings(_tx: unknown, a: any) {
      calls.push({ name: 'update', args: a });
      if ('updateRow' in o) return o.updateRow;
      if (!row || row.version !== a.expectedVersion) return undefined;
      row = { ...row, ...a.values, version: row.version + 1 }; return row;
    },
    async hasInvoiceInFiscalYear(_tx: unknown, a: any) { calls.push({ name: 'hasInvoice', args: a }); return o.invoiceInFy ?? false; },
    async listCodes(_tx: unknown, a: any) { calls.push({ name: 'codes', args: a }); return o.codes ?? []; },
  };
  return { repo, calls, names: () => calls.map((c) => c.name) };
}
function makeCtx(pattern = '{fy}-{seq:6}', now?: string) {
  const idCalls: any[] = [];
  const IdentityPort = { async getTenantSettings(_c: unknown, input: unknown) { idCalls.push(input); return { numbering: { invoiceNoPattern: pattern } }; } };
  const ctx = makeCtxFor()('A', { ports: { IdentityPort } as never, ...(now ? { now: () => now as never } : {}) });
  return { ctx, idCalls };
}
const svcWith = (r: ReturnType<typeof makeRepo>) => createSettingsService({ repo: r.repo as never });
const fieldPaths = (e: any) => (e.errors ?? []).map((x: any) => x.path);

describe('getSettings (B32 GET)', () => {
  it('returns exactly the BillingSettings fields (no tenant_id / audit columns), bigint column as a JS number', async () => {
    const r = makeRepo({ row: { ...TENANT_ROW, cash_variance_alert_paisa: '250000' } });
    const b: any = await svcWith(r).getSettings(makeCtx().ctx as never);
    expect(Object.keys(b).sort()).toEqual(BODY_KEYS);
    expect(b).toMatchObject({ invoice_series_scope: 'tenant', cash_variance_alert_paisa: 250000, refund_alert_per_day: 5, version: 3 });
    expect(typeof b.cash_variance_alert_paisa).toBe('number');
  });
  it('lazy defaults (TRD §11.2): no row -> inserted for ctx.tenantId by ctx.actor, then returned with the documented defaults', async () => {
    const r = makeRepo({ row: undefined });
    const { ctx } = makeCtx();
    const b: any = await svcWith(r).getSettings(ctx as never);
    expect(r.names()).toEqual(['get', 'insert']);
    expect(r.calls[1]!.args).toMatchObject({ tenantId: ctx.tenantId, userId: ctx.actor.id });
    expect(b).toEqual({ ...FULL, version: 1 });
  });
  it('lost insert race (ON CONFLICT DO NOTHING returned nothing) -> re-reads and returns the winner row, no error', async () => {
    const winner = { ...TENANT_ROW, prices_include_tax: true, version: 2 };
    const calls: string[] = [];
    let reads = 0;
    const repo = { ...makeRepo().repo, async getBillingSettings() { calls.push('get'); return reads++ === 0 ? undefined : winner; }, async insertDefaultBillingSettings() { calls.push('insert'); return undefined; } };
    const b: any = await createSettingsService({ repo: repo as never }).getSettings(makeCtx().ctx as never);
    expect(calls).toEqual(['get', 'insert', 'get']);
    expect(b).toMatchObject({ prices_include_tax: true, version: 2 });
  });
  it('tenant comes from ctx only: every repo call carries ctx.tenantId', async () => {
    const r = makeRepo({ row: undefined });
    const { ctx } = makeCtx();
    await svcWith(r).getSettings(ctx as never);
    for (const c of r.calls) expect(c.args.tenantId).toBe(ctx.tenantId);
  });
});

describe('updateSettings (B32 PUT): concurrency and body validation', () => {
  it('no If-Match version -> 428 common.precondition_required, repo untouched', async () => {
    const r = makeRepo();
    await expect(svcWith(r).updateSettings(makeCtx().ctx as never, { expectedVersion: undefined, patch: FULL })).rejects.toMatchObject({ code: 'common.precondition_required' });
    expect(r.calls).toEqual([]);
  });
  it('malformed versions (0, -1, 1.5, 2^31, NaN, string) -> common.validation_failed, repo untouched', async () => {
    const r = makeRepo();
    for (const v of [0, -1, 1.5, 2 ** 31, Number.NaN, '3']) await expect(svcWith(r).updateSettings(makeCtx().ctx as never, { expectedVersion: v as never, patch: FULL }), String(v)).rejects.toMatchObject({ code: 'common.validation_failed' });
    expect(r.calls).toEqual([]);
  });
  it('stale version -> 409 common.version_conflict', async () => {
    const r = makeRepo({ row: { ...TENANT_ROW, version: 5 } });
    await expect(svcWith(r).updateSettings(makeCtx().ctx as never, { expectedVersion: 3, patch: FULL })).rejects.toMatchObject({ code: 'common.version_conflict', statusCode: 409 });
  });
  it('good update: values mapped to repo, tenant + actor from ctx, response is the new body with version + 1', async () => {
    const r = makeRepo();
    const { ctx } = makeCtx();
    const b: any = await svcWith(r).updateSettings(ctx as never, { expectedVersion: 3, patch: { ...FULL, prices_include_tax: true, cash_variance_alert_paisa: 5000, refund_alert_per_day: 9 } });
    const u = r.calls.find((c) => c.name === 'update')!.args;
    expect(u).toMatchObject({ tenantId: ctx.tenantId, userId: ctx.actor.id, expectedVersion: 3 });
    expect(u.values).toMatchObject({ prices_include_tax: true, cash_variance_alert_paisa: 5000, refund_alert_per_day: 9 });
    expect(Object.keys(b).sort()).toEqual(BODY_KEYS);
    expect(b).toMatchObject({ prices_include_tax: true, cash_variance_alert_paisa: 5000, refund_alert_per_day: 9, version: 4 });
  });
  it('body "version" is server-set and ignored (never reaches the repo values)', async () => {
    const r = makeRepo();
    await svcWith(r).updateSettings(makeCtx().ctx as never, { expectedVersion: 3, patch: { ...FULL, version: 99 } });
    expect(r.calls.find((c) => c.name === 'update')!.args.values).not.toHaveProperty('version');
  });
  it('mass assignment: tenant_id / created_by / is_active / unknown keys -> common.validation_failed, nothing written', async () => {
    for (const k of ['tenant_id', 'created_by', 'is_active', 'updated_by', 'receipt_no_pattern', '__proto__x']) {
      const r = makeRepo();
      const e: any = await svcWith(r).updateSettings(makeCtx().ctx as never, { expectedVersion: 3, patch: { ...FULL, [k]: k === 'is_active' ? false : 'x' } }).catch((x) => x);
      expect(e.code, k).toBe('common.validation_failed');
      expect(r.names().includes('update'), k).toBe(false);
    }
  });
  it('field rules: scope enum, booleans, cash_variance 0..2^53-1 integer, refund_alert 0..10000 integer -> validation_failed with that path', async () => {
    const bad: [string, unknown][] = [['invoice_series_scope', 'region'], ['invoice_series_scope', 1], ['prices_include_tax', 'yes'], ['pay_by_qr_enabled', 1], ['receipt_no_enabled', null],
      ['cash_variance_alert_paisa', -1], ['cash_variance_alert_paisa', 1.5], ['cash_variance_alert_paisa', '10'], ['cash_variance_alert_paisa', 2 ** 53],
      ['refund_alert_per_day', 10001], ['refund_alert_per_day', -1], ['refund_alert_per_day', 2.5]];
    for (const [k, v] of bad) {
      const r = makeRepo();
      const e: any = await svcWith(r).updateSettings(makeCtx().ctx as never, { expectedVersion: 3, patch: { ...FULL, [k]: v } }).catch((x) => x);
      expect(e.code, `${k}=${String(v)}`).toBe('common.validation_failed');
      expect(fieldPaths(e), `${k}=${String(v)}`).toContain(`/${k}`);
      expect(r.names().includes('update')).toBe(false);
    }
  });
  it('non-object bodies are rejected', async () => {
    for (const patch of [null, 'x', 5, [FULL]]) await expect(svcWith(makeRepo()).updateSettings(makeCtx().ctx as never, { expectedVersion: 3, patch: patch as never })).rejects.toMatchObject({ code: 'common.validation_failed' });
  });
});

describe('US-BL-01.5 / B32: invoice_series_scope = branch needs {branch}, and no switch after the first invoice of the fiscal year', () => {
  const BRANCH = { ...FULL, invoice_series_scope: 'branch' };
  const expectScopeRefused = async (p: Promise<unknown>, r: ReturnType<typeof makeRepo>) => {
    const e: any = await p.then(() => undefined, (x) => x);
    expect(e, 'must be refused').toBeDefined();
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(fieldPaths(e)).toEqual(['/invoice_series_scope']);
    expect(r.names().includes('update')).toBe(false); // nothing stored
  };
  it('branch scope while invoiceNoPattern lacks {branch} -> 400 common.validation_failed, path /invoice_series_scope', async () => {
    for (const pattern of ['{fy}-{seq:6}', 'INV-{fy}-{seq:6}', '{Branch}-{seq:6}', '{branches}-{seq:6}', 'branch-{seq:6}', '']) {
      const r = makeRepo();
      await expectScopeRefused(svcWith(r).updateSettings(makeCtx(pattern).ctx as never, { expectedVersion: 3, patch: BRANCH }), r);
    }
  });
  it('the pattern comes from IdentityPort.getTenantSettings (numbering), not from a local copy', async () => {
    const r = makeRepo();
    const { ctx, idCalls } = makeCtx('{branch}/{fy}-{seq:6}');
    await svcWith(r).updateSettings(ctx as never, { expectedVersion: 3, patch: BRANCH });
    expect(idCalls).toHaveLength(1);
    expect(JSON.stringify(idCalls[0])).toContain('numbering');
    expect(idCalls[0]?.keys).toBeDefined(); // asks for the keys it needs, not the whole settings object
  });
  it('branch scope with {branch} in the pattern and no invoice yet this fiscal year -> accepted', async () => {
    const r = makeRepo({ invoiceInFy: false });
    const b: any = await svcWith(r).updateSettings(makeCtx('{branch}/{fy}-{seq:6}').ctx as never, { expectedVersion: 3, patch: BRANCH });
    expect(b.invoice_series_scope).toBe('branch');
    expect(b.version).toBe(4);
  });
  it('switching either way after an invoice exists in the current fiscal year -> 400 /invoice_series_scope, nothing stored', async () => {
    const r1 = makeRepo({ invoiceInFy: true });
    await expectScopeRefused(svcWith(r1).updateSettings(makeCtx('{branch}-{seq:6}').ctx as never, { expectedVersion: 3, patch: BRANCH }), r1);
    const r2 = makeRepo({ row: { ...TENANT_ROW, invoice_series_scope: 'branch' }, invoiceInFy: true });
    await expectScopeRefused(svcWith(r2).updateSettings(makeCtx('{branch}-{seq:6}').ctx as never, { expectedVersion: 3, patch: FULL }), r2);
  });
  it('branch -> tenant before the first invoice of the FY is allowed (no {branch} needed for tenant scope)', async () => {
    const r = makeRepo({ row: { ...TENANT_ROW, invoice_series_scope: 'branch' }, invoiceInFy: false });
    const b: any = await svcWith(r).updateSettings(makeCtx('{fy}-{seq:6}').ctx as never, { expectedVersion: 3, patch: FULL });
    expect(b.invoice_series_scope).toBe('tenant');
  });
  it('an update that does not change the scope is allowed mid-fiscal-year (only a switch is blocked)', async () => {
    for (const scope of ['tenant', 'branch']) {
      const r = makeRepo({ row: { ...TENANT_ROW, invoice_series_scope: scope }, invoiceInFy: true });
      const b: any = await svcWith(r).updateSettings(makeCtx('{branch}-{seq:6}').ctx as never, { expectedVersion: 3, patch: { ...FULL, invoice_series_scope: scope, prices_include_tax: true } });
      expect(b.prices_include_tax, scope).toBe(true);
    }
  });
  it('"first invoice of a fiscal year" is judged in the B.S. fiscal year of ctx.now(): Ashad 2082 -> 2082/83, Shrawan 2083 -> 2083/84', async () => {
    for (const [now, fy] of [['2026-07-10T06:00:00.000Z', '2082/83'], ['2026-08-01T06:00:00.000Z', '2083/84']] as const) {
      const r = makeRepo({ invoiceInFy: false });
      await svcWith(r).updateSettings(makeCtx('{branch}-{seq:6}', now).ctx as never, { expectedVersion: 3, patch: BRANCH });
      expect(r.calls.find((c) => c.name === 'hasInvoice')!.args, now).toMatchObject({ fiscalYearBs: fy, tenantId: makeCtxFor()('A').tenantId });
    }
  });
  it('IdentityPort failure aborts the switch (fail closed): error propagates, nothing stored', async () => {
    const r = makeRepo();
    const boom = Object.assign(new Error('x'), { code: 'common.service_unavailable' });
    const ctx = makeCtxFor()('A', { ports: { IdentityPort: { getTenantSettings: async () => { throw boom; } } } as never });
    await expect(svcWith(r).updateSettings(ctx as never, { expectedVersion: 3, patch: BRANCH })).rejects.toBe(boom);
    expect(r.names().includes('update')).toBe(false);
  });
});

describe('listCodes (B34 listBillingCodes)', () => {
  const SETS = ['payment_methods', 'invoice_cancel_reasons', 'reversal_reasons', 'refund_reasons', 'override_reasons', 'cash_variance_reasons', 'lock_reasons'];
  const ROWS = [
    { tenant_id: 'x', id: 'i3', code: 'z_last', display: 'Last', sort_order: 20, is_active: true, requires_text: true },
    { tenant_id: 'x', id: 'i1', code: 'b_first', display: 'First', sort_order: 10, is_active: true },
    { tenant_id: 'x', id: 'i2', code: 'a_first', display: 'Also first', sort_order: 10, is_active: true },
    { tenant_id: 'x', id: 'i4', code: 'gone', display: 'Retired', sort_order: 1, is_active: false },
  ];
  it('returns {data:[{code,display,sort_order}]} sorted by sort_order then code, inactive rows dropped, nothing else leaked', async () => {
    const r = makeRepo({ codes: ROWS });
    const { ctx } = makeCtx();
    const out: any = await svcWith(r).listCodes(ctx as never, { setName: 'refund_reasons' });
    expect(out).toEqual({ data: [{ code: 'a_first', display: 'Also first', sort_order: 10 }, { code: 'b_first', display: 'First', sort_order: 10 }, { code: 'z_last', display: 'Last', sort_order: 20 }] });
    expect(r.calls[0]).toMatchObject({ name: 'codes', args: { tenantId: ctx.tenantId, setName: 'refund_reasons' } });
  });
  it('accepts the 7 documented sets', async () => {
    for (const setName of SETS) await expect(svcWith(makeRepo()).listCodes(makeCtx().ctx as never, { setName }), setName).resolves.toEqual({ data: [] });
  });
  it('sets not in the B34 enum (stored but not exposed: charge_void_reasons, print_reasons), unknown, hostile or non-string names are refused before any query', async () => {
    for (const setName of ['charge_void_reasons', 'print_reasons', 'nope', '', 'REFUND_REASONS', 'refund_reasons; DROP TABLE billing.cs_reasons', '__proto__', 'constructor', undefined, 5, null, ['refund_reasons']]) {
      const r = makeRepo({ codes: ROWS });
      const e: any = await svcWith(r).listCodes(makeCtx().ctx as never, { setName: setName as never }).catch((x) => x);
      expect(['common.validation_failed', 'common.not_found'], String(setName)).toContain(e.code);
      expect(r.calls, String(setName)).toEqual([]);
    }
  });
});
