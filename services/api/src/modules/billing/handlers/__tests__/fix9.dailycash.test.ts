// T0D-FIX-9 (LD-455, founder order 2026-11-22 22:06 NPT) getDailyCash: GET /v1/billing/daily-cash answered 400 common.validation_failed on the live tenant
// (request id 01a20343-8f4d-7ce8-b2bb-bf521bf87bda). The CONTRACT query is business_date, centre_id, collected_by_membership_id (billing.yaml getDailyCash). The web builder
// (apps/web billing/server/read.server.ts getDailyCash) sent `date` and `actor_membership_id`: the strict query validator refuses unknown names. The API side is right; the web side is
// tested in apps/web/src/__tests__/fix9.four-calls.test.tsx. These tests pin the contract request on the handler (guards: they pass now) and the empty tenant / forbidden / bad input cases.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const CENTRE = V7('000000020002'), M1 = V7('000000030001');
const A = makeCtxFor()('A').tenantId as string;
const B = makeCtxFor()('B').tenantId as string;

function emptyTx() {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  return { stmts, async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: [] as any[] }; } };
}
const identity = (denied = false) => ({
  getActor: async () => ({ displayName: 'Synthetic Cashier' }), getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu' }),
  assertRole: async (_c: unknown, r: { permission: string }) => { if (denied) throw Object.assign(new Error(r.permission), { code: 'auth.forbidden', statusCode: 403 }); },
});
const hctx = (tx: unknown, tenant: 'A' | 'B' = 'A', denied = false) => ({
  operationId: 'getDailyCash', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
  ...makeCtxFor()(tenant, { ports: { IdentityPort: identity(denied) } as never }), tx, now: () => '2026-11-22T06:00:00.000Z',
}) as never;
const get = (query: unknown, c: unknown) => (handlers['getDailyCash'] as any)({ params: {}, query, headers: {}, body: undefined }, c) as Promise<{ status: number; body: any }>;
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } return undefined; };

describe('getDailyCash: the contract request (business_date, centre_id, collected_by_membership_id)', () => {
  it('all three contract parameters -> 200 with business_date echoed, empty rows, zero totals, no sessions (empty tenant)', async () => {
    const tx = emptyTx();
    const r = await get({ business_date: '2026-11-20', centre_id: CENTRE, collected_by_membership_id: M1 }, hctx(tx));
    expect(r.status).toBe(200);
    expect(r.body.business_date).toBe('2026-11-20');
    expect(r.body.rows).toEqual([]);
    expect(r.body.sessions).toEqual([]);
    expect(r.body.totals.net.amount_paisa).toBe(0);
  });
  it('no parameters -> 200 for today (empty tenant)', async () => {
    const r = await get({}, hctx(emptyTx()));
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([]);
  });
  it('the centre and the collector reach the statements as filters', async () => {
    const tx = emptyTx();
    await get({ business_date: '2026-11-20', centre_id: CENTRE, collected_by_membership_id: M1 }, hctx(tx));
    const flat = JSON.stringify(tx.stmts.map((s) => s.values));
    expect(flat).toContain(CENTRE);
    expect(flat).toContain(M1);
  });
});

describe('getDailyCash: bad input, forbidden, tenant', () => {
  it.each([
    ['a date that does not exist', { business_date: '2026-02-30' }], ['a date in another format', { business_date: '20/11/2026' }], ['a non-string date', { business_date: 20261120 }],
    ['a centre that is not a uuid', { centre_id: 'KTM' }], ['a collector that is not a uuid', { collected_by_membership_id: 'me' }],
  ])('%s -> common.validation_failed 400, never 500', async (_n, q) => {
    const e = await caught(get(q, hctx(emptyTx())));
    expect(e?.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
  });
  it('without billing.cash_report.read -> auth.forbidden and no statement', async () => {
    const tx = emptyTx();
    const e = await caught(get({ business_date: '2026-11-20' }, hctx(tx, 'A', true)));
    expect(e?.code).toBe('auth.forbidden');
    expect(tx.stmts).toEqual([]);
  });
  it('other tenant: statements bind tenant B only', async () => {
    const tx = emptyTx();
    expect((await get({ business_date: '2026-11-20' }, hctx(tx, 'B'))).status).toBe(200);
    const flat = JSON.stringify(tx.stmts.map((s) => s.values));
    expect(flat).toContain(B);
    expect(flat).not.toContain(A);
  });
});
