// BL-T05 handler (contract) tests for getBillingSettings, updateBillingSettings, listBillingCodes (contracts/openapi/billing.yaml; 02-TRD §6 B32/B34; REQ-SEC-099).
// Fails now: handlers/index.ts still maps all three to the BL-T01 stub (common.service_unavailable).
// Handler contract (same as services/reporting settings.handlers): needs ctx.tenantId + ctx.actor.id + ctx.tx, else auth.unauthenticated (fail closed);
//   If-Match: "<version>" on PUT -> ETag "<version>" on GET/PUT 200 (headers.etag); schema/auth/x-permission are enforced by the core pipeline, not here.
// The DB is a fake tx.query that answers by statement type, so the test does not depend on the repo's exact SQL: any SELECT on billing.settings -> the stored row,
// any UPDATE billing.settings -> the row with version + 1, any other SELECT -> the coded-set rows.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../../handlers/index.js';

const ROW = {
  tenant_id: '01a1a98a-ac40-7000-8000-00000000a001', invoice_series_scope: 'tenant', prices_include_tax: false, abbreviated_invoice_enabled: false, pay_by_qr_enabled: false,
  receipt_no_enabled: true, credit_days_auto_lock: true, cash_variance_alert_paisa: '0', refund_alert_per_day: 5, version: 3, is_active: true,
};
const CODE_ROWS = [{ code: 'billing_error', display: 'Billing error', sort_order: 1, is_active: true, tenant_id: 'x', id: 'i' }];
const PUT_BODY = { invoice_series_scope: 'tenant', prices_include_tax: true, abbreviated_invoice_enabled: false, pay_by_qr_enabled: false, receipt_no_enabled: true,
  credit_days_auto_lock: true, cash_variance_alert_paisa: 0, refund_alert_per_day: 5 };

function fakeTx() {
  const calls: string[] = [];
  return {
    calls,
    tx: {
      async query(text: string) {
        calls.push(text);
        if (/\bUPDATE\b[\s\S]*billing\.settings/i.test(text)) return { rows: [{ ...ROW, prices_include_tax: true, version: 4 }] };
        if (/\bINSERT\b/i.test(text)) return { rows: [{ ...ROW, version: 1 }] };
        if (/billing\.settings/i.test(text)) return { rows: [ROW] };
        return { rows: CODE_ROWS };
      },
    },
  };
}
const hctx = (extra: Record<string, unknown> = {}) => ({
  operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
  ...makeCtxFor()('A', { ports: { IdentityPort: { getTenantSettings: async () => ({ numbering: { invoiceNoPattern: '{fy}-{seq:6}' } }) } } as never }), ...extra,
}) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: 'getBillingSettings' | 'updateBillingSettings' | 'listBillingCodes', r: unknown, c: unknown) => (handlers[op] as any)(r, c);

describe('fail closed without an authenticated request context (REQ-SEC-099)', () => {
  for (const op of ['getBillingSettings', 'updateBillingSettings', 'listBillingCodes'] as const)
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      await expect(run(op, req({ params: { set_name: 'refund_reasons' }, body: PUT_BODY, headers: { 'if-match': '"3"' } }), bare)).rejects.toMatchObject({ code: 'auth.unauthenticated' });
    });
});

describe('getBillingSettings', () => {
  it('200 with the BillingSettings body and ETag "<version>"', async () => {
    const { tx } = fakeTx();
    const out = await run('getBillingSettings', req(), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ invoice_series_scope: 'tenant', refund_alert_per_day: 5, cash_variance_alert_paisa: 0, version: 3 });
    expect(Object.keys(out.body)).not.toContain('tenant_id');
    expect(out.headers?.etag).toBe('"3"');
  });
});

describe('updateBillingSettings', () => {
  it('If-Match "3" -> 200, new body, ETag "4"', async () => {
    const { tx } = fakeTx();
    const out = await run('updateBillingSettings', req({ body: PUT_BODY, headers: { 'if-match': '"3"' } }), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ prices_include_tax: true, version: 4 });
    expect(out.headers?.etag).toBe('"4"');
  });
  it('no If-Match -> 428 common.precondition_required and no DB access', async () => {
    const { tx, calls } = fakeTx();
    await expect(run('updateBillingSettings', req({ body: PUT_BODY }), hctx({ tx }))).rejects.toMatchObject({ code: 'common.precondition_required' });
    expect(calls).toEqual([]);
  });
  it('malformed If-Match (unquoted, weak, zero, text, oversized) -> common.validation_failed and no DB access', async () => {
    for (const h of ['3', 'W/"3"', '"0"', '"abc"', '"99999999999"', '"3", "4"', '*']) {
      const { tx, calls } = fakeTx();
      await expect(run('updateBillingSettings', req({ body: PUT_BODY, headers: { 'if-match': h } }), hctx({ tx })), h).rejects.toMatchObject({ code: 'common.validation_failed' });
      expect(calls, h).toEqual([]);
    }
  });
  it('B32: branch scope while the tenant pattern lacks {branch} -> 400 common.validation_failed, path /invoice_series_scope, no UPDATE issued', async () => {
    const { tx, calls } = fakeTx();
    const e: any = await run('updateBillingSettings', req({ body: { ...PUT_BODY, invoice_series_scope: 'branch' }, headers: { 'if-match': '"3"' } }), hctx({ tx })).catch((x: unknown) => x);
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect((e.errors ?? []).map((x: any) => x.path)).toEqual(['/invoice_series_scope']);
    expect(calls.some((t) => /\bUPDATE\b/i.test(t))).toBe(false);
  });
});

describe('listBillingCodes', () => {
  it('200 {data:[{code,display,sort_order}]} for a documented set; tenant_id / id / is_active never leave the service', async () => {
    const { tx } = fakeTx();
    const out = await run('listBillingCodes', req({ params: { set_name: 'refund_reasons' } }), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ data: [{ code: 'billing_error', display: 'Billing error', sort_order: 1 }] });
  });
  it('a set outside the B34 enum is refused (400/404) before any query, even if the core pipeline let it through', async () => {
    for (const set_name of ['print_reasons', 'charge_void_reasons', 'nope', undefined]) {
      const { tx, calls } = fakeTx();
      const e: any = await run('listBillingCodes', req({ params: { set_name } }), hctx({ tx })).catch((x: unknown) => x);
      expect(['common.validation_failed', 'common.not_found'], String(set_name)).toContain(e.code);
      expect(calls, String(set_name)).toEqual([]);
    }
  });
});
