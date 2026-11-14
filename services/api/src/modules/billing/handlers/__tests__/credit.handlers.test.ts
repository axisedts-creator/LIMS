// BL-T13 handlers: B19 listCreditAccounts / getCreditAccount / updateCreditAccount, B20 listCreditCharges, B21 issuePeriodicInvoice, B22 recordCreditPartyPayment,
// B23 getCreditPartyStatement (02-TRD §5; REQ-SEC-099 no 2xx stub; 07-SECURITY A11 tenant ids in credit party ids).
// Fails now: handlers/index.ts maps all seven operationIds to the BL-T01 stub (common.service_unavailable, 503).
// Handler contract (same as creditNoteTasks.handlers.test.ts): (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated.
// Schema / auth / x-permission / privileged-aal2 / Idempotency-Key are enforced by the core pipeline (see service/__tests__/t13.contract.test.ts), not here.
// Service-level behaviour (periodic bill, payments, statement) is covered by credit.periodic.test.ts / credit.account.test.ts; HTTP body -> DTO mapping is NOT covered (see notes).
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const PARTY = V7('000000b00001'), BRANCH = V7('000000010002'), INV = V7('000000a00101');
const OPS = ['listCreditAccounts', 'getCreditAccount', 'updateCreditAccount', 'listCreditCharges', 'issuePeriodicInvoice', 'recordCreditPartyPayment', 'getCreditPartyStatement'] as const;
const BODY: Record<(typeof OPS)[number], unknown> = {
  listCreditAccounts: undefined, getCreditAccount: undefined, updateCreditAccount: { is_locked: false, credit_days: 30 }, listCreditCharges: undefined,
  issuePeriodicInvoice: { period_month: '2026-10', branch_id: BRANCH }, recordCreditPartyPayment: { invoice_id: INV, method_code: 'cash', amount_received_paisa: 1000 }, getCreditPartyStatement: undefined,
};
const req = (op: (typeof OPS)[number]) => ({ params: op === 'listCreditAccounts' ? {} : { credit_party_id: PARTY }, query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'bl13-h-1' }, body: BODY[op] }) as never;
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const run = (op: (typeof OPS)[number], r: unknown, c: unknown) => (handlers[op] as any)(r, c);

describe('B19–B23 are real handlers, not the BL-T01 stub (REQ-SEC-099)', () => {
  for (const op of OPS)
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.service_unavailable)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, req(op), bare))).code).toBe('auth.unauthenticated');
    });
  it('every one of the seven operationIds is mapped to a function distinct from the shared stub', () => {
    const stub = (handlers as any).getBillingExportContent; // still the BL-T01 stub in this task
    for (const op of OPS) {
      expect(typeof handlers[op], op).toBe('function');
      expect(handlers[op], op).not.toBe(stub);
    }
  });
});

describe('B20 / B23 / B19 read handlers never leak internals (07-SECURITY P-rules)', () => {
  it('with an empty fake DB the read handlers answer 200/404 shapes, never a stack, tenant_id or created_by', async () => {
    const tx = { async query() { return { rows: [] }; } };
    const ctx = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()('A', { tx } as never) } as never;
    for (const op of ['listCreditAccounts', 'listCreditCharges', 'getCreditPartyStatement', 'getCreditAccount'] as const) {
      let out: any;
      try { out = await run(op, req(op), ctx); } catch (e: any) { out = { status: e?.statusCode ?? e?.status, body: { code: e?.code } }; }
      expect(typeof out.status, op).toBe('number');
      expect([200, 404].includes(out.status), `${op} -> ${out.status}`).toBe(true);
      expect(JSON.stringify(out.body ?? {}), op).not.toMatch(/tenant_id|created_by|updated_by|stack/);
    }
  });
});
