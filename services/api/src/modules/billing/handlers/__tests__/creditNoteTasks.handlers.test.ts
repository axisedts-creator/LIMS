// BL-T10 handlers: B4 cancelInvoice, B5 issuePartialCreditNote, B35 listCreditNoteTasks (02-TRD §5; contracts/openapi/billing.yaml CreditNoteTask / CreditNoteTaskPage; REQ-SEC-099; 07-SECURITY A11).
// Fails now: handlers/index.ts maps all three operationIds to the BL-T01 stub (common.service_unavailable, 503).
// Handler contract (same as invoice.handlers.test.ts): (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated;
// schema / auth / x-permission / privileged-aal2 / Idempotency-Key are enforced by the core pipeline (see t10.contract.test.ts), not here.
// B4/B5 end-to-end mapping is covered at service level (invoice.cancel/credit tests); no SQL-level fake of the whole cancel flow here (see notes: not verified).
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INV = V7('000000a00001'), ORDER = V7('000000050001'), LINE = V7('000000e00001'), T1 = V7('000000900001'), T2 = V7('000000900002'), TB = V7('000000900009');
const A = makeCtxFor()('A').tenantId as string;
const B = makeCtxFor()('B').tenantId as string;
const taskRow = (tenant: string, id: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, centre_id: V7('000000020002'), order_id: ORDER, invoice_id: INV, invoice_line_ids: [LINE], cause: 'item_removed', reason_code: 'patient_request', status: 'open',
  resolved_by_credit_note_id: null, resolved_at: null, resolved_by: null, version: 1, is_active: true, created_at: new Date('2026-11-08T06:00:00.000Z'), created_by: V7('000000030001'),
  updated_at: new Date('2026-11-08T06:00:00.000Z'), updated_by: V7('000000030001'), ...over,
});
function fakeTx(rows: Array<Record<string, any>>) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  return {
    stmts,
    tx: {
      async query(text: string, values: unknown[] = []) {
        stmts.push({ text, values });
        if (!/\bbilling\.credit_note_tasks\b/i.test(text)) return { rows: [] };
        const status = values.find((v) => v === 'open' || v === 'resolved');
        return { rows: rows.filter((r) => values.includes(r.tenant_id) && (!/\bstatus\s*=\s*\$\d/i.test(text) || r.status === status) && (!/\bstatus\s*=\s*'open'/i.test(text) || r.status === 'open')) };
      },
    },
  };
}
const hctx = (tx: unknown, tenant: 'A' | 'B' = 'A') => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()(tenant, { tx } as never) }) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: 'cancelInvoice' | 'issuePartialCreditNote' | 'listCreditNoteTasks', r: unknown, c: unknown) => (handlers[op] as any)(r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const ALLOWED = new Set(['id', 'order_id', 'invoice_id', 'invoice_line_ids', 'cause', 'status', 'created_at']);

describe('fail closed without an authenticated request context (REQ-SEC-099)', () => {
  for (const op of ['cancelInvoice', 'issuePartialCreditNote', 'listCreditNoteTasks'] as const)
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (not the BL-T01 503 stub)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      const body = op === 'cancelInvoice' ? { reason_code: 'billing_error' } : { lines: [{ invoice_line_id: LINE }], reason_code: 'billing_error' };
      expect((await fail(run(op, req({ params: { invoice_id: INV }, body }), bare))).code).toBe('auth.unauthenticated');
    });
});

describe('B35 listCreditNoteTasks', () => {
  it('default status open: 200 {data, page}; each item has exactly the CreditNoteTask fields (created_at ISO string), no tenant/centre/reason/audit columns leak', async () => {
    const { tx } = fakeTx([taskRow(A, T1), taskRow(A, T2, { status: 'resolved' })]);
    const res = await run('listCreditNoteTasks', req({ query: {} }), hctx(tx));
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: any) => t.id)).toEqual([T1]);
    expect(res.body.page).toBeDefined();
    const t = res.body.data[0];
    expect(Object.keys(t).sort()).toEqual([...ALLOWED].sort());
    expect(t).toMatchObject({ order_id: ORDER, invoice_id: INV, invoice_line_ids: [LINE], cause: 'item_removed', status: 'open', created_at: '2026-11-08T06:00:00.000Z' });
    expect(JSON.stringify(res.body)).not.toMatch(/tenant_id|created_by|reason_code|centre_id/);
  });
  it('status=resolved lists resolved tasks only', async () => {
    const { tx } = fakeTx([taskRow(A, T1), taskRow(A, T2, { status: 'resolved' })]);
    const res = await run('listCreditNoteTasks', req({ query: { status: 'resolved' } }), hctx(tx));
    expect(res.body.data.map((t: any) => t.id)).toEqual([T2]);
  });
  it("tenant isolation: tenant A never sees tenant B's tasks and every statement on the table binds the caller's tenant", async () => {
    const { tx, stmts } = fakeTx([taskRow(A, T1), taskRow(B, TB)]);
    const res = await run('listCreditNoteTasks', req({ query: {} }), hctx(tx));
    expect(res.body.data.map((t: any) => t.id)).toEqual([T1]);
    const mine = stmts.filter((s) => /\bbilling\.credit_note_tasks\b/i.test(s.text));
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) { expect(s.values).toContain(A); expect(s.values).not.toContain(B); }
    const other = fakeTx([taskRow(A, T1), taskRow(B, TB)]);
    expect((await run('listCreditNoteTasks', req({ query: {} }), hctx(other.tx, 'B'))).body.data.map((t: any) => t.id)).toEqual([TB]);
  });
  it('unknown status value -> 400 common.validation_failed (path /status); hostile status stays a bound value', async () => {
    const { tx, stmts } = fakeTx([taskRow(A, T1)]);
    const e = await fail(run('listCreditNoteTasks', req({ query: { status: "open'; DROP TABLE billing.credit_note_tasks;--" } }), hctx(tx)));
    expect([e.code, e.errors?.map((x: any) => x.path)]).toEqual(['common.validation_failed', ['/status']]);
    expect(stmts.every((s) => !s.text.includes('DROP TABLE'))).toBe(true);
  });
});
