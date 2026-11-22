// T0D-FIX-9 (LD-455, founder order 2026-11-22 22:06 NPT) listStockMovements: GET /v1/inventory/movements answered 400 on the live tenant
// (request id 01a20348-6709-7a87-a756-fec227fb3ead). The web sends `movement_kind=opening_balance&limit=1` (read.server.ts listOpeningMovements, the S1 set-up checklist).
// The contract declares movement_kind as array, style form, explode false; the request validator hands the handler the ARRAY ['opening_balance'] and the number 1,
// and lots.schemas.ts csvOf() accepts strings only (same fault as T0D-FIX-7 csv(), see .orchestra/notes/T0D-FIX-7-left.md).
// Contract is the truth: the handler must accept the array AND the comma string. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { A, B, call, expectLims, makeLotCtx, rej, uid } from './lots.helpers.js';

const STORE = uid(1001), ITEM = uid(2001);
/** An empty tenant: every statement answers no rows. */
function emptyTx() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return { calls, async query(text: string, values: unknown[] = []) { calls.push({ text, values }); return { rows: [] as any[] }; } };
}
const run = (query: Record<string, unknown>, o: Parameters<typeof makeLotCtx>[2] = {}, tenant = A) => {
  const tx = emptyTx();
  const { ctx, roleCalls } = makeLotCtx(tx, tenant, o);
  return { tx, roleCalls, res: () => call('listStockMovements', ctx, { query }) };
};

describe('listStockMovements: the request the web sends (movement_kind array form + numeric limit)', () => {
  it('movement_kind as the array the validator builds + limit 1 -> 200, empty tenant gives data [] and a page', async () => {
    const r = await run({ movement_kind: ['opening_balance'], limit: 1 }).res();
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(r.body.page.limit).toBe(1);
  });
  it('several kinds as an array -> 200', async () => {
    expect((await run({ movement_kind: ['receive', 'issue', 'consume_test'] }).res()).status).toBe(200);
  });
  it('the comma string form still works (guard)', async () => {
    expect((await run({ movement_kind: 'opening_balance,receive', limit: 1 }).res()).status).toBe(200);
  });
  it('the kinds reach the statement as a list, in both forms', async () => {
    for (const mk of [['opening_balance', 'receive'], 'opening_balance,receive']) {
      const s = run({ movement_kind: mk });
      await s.res();
      const stmt = s.tx.calls.find((c) => /inventory\.stock_movements|stock_movement/i.test(c.text));
      expect(stmt, 'a movements statement ran').toBeTruthy();
      expect(JSON.stringify(stmt!.values)).toContain('opening_balance');
    }
  });
  it('the exact web probe with a store and an item (listMovements: store_id, item_id, limit 50) reaches the service, not a 400', async () => {
    const s = run({ store_id: STORE, item_id: ITEM, limit: 50 });
    // an empty tenant has no such store: 404 common.not_found (P-B8) is the only failure allowed, never 400 and never 500
    const e = await rej(s.res()).catch(() => undefined);
    if (e) expect(e.code).toBe('common.not_found');
  });
});

describe('listStockMovements: bad input is a typed 400, never 500, and touches nothing', () => {
  const bad = (query: Record<string, unknown>) => async () => {
    const s = run(query);
    await expectLims(s.res(), 'common.validation_failed', 400);
    expect(s.tx.calls).toEqual([]);
  };
  it('array with an unknown kind', bad({ movement_kind: ['issue', 'teleport'] }));
  it('empty array', bad({ movement_kind: [] }));
  it('array with a non-string member', bad({ movement_kind: [1] }));
  it('array of more than 20 kinds', bad({ movement_kind: Array.from({ length: 21 }, () => 'issue') }));
  it('comma string with an unknown kind', bad({ movement_kind: 'issue,teleport' }));
  it('an object instead of a list', bad({ movement_kind: { 0: 'issue' } }));
  it('limit 0 and 201', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); });
});

describe('listStockMovements: permission and tenant', () => {
  it('without inventory.item.read -> auth.forbidden before any statement (array form)', async () => {
    const s = run({ movement_kind: ['opening_balance'], limit: 1 }, { permissions: [] });
    await expectLims(s.res(), 'auth.forbidden', 403);
    expect(s.tx.calls).toEqual([]);
    expect(s.roleCalls[0]).toMatchObject({ permission: 'inventory.item.read' });
  });
  it('other tenant: every statement binds the caller tenant only, never the other one', async () => {
    const s = run({ movement_kind: ['opening_balance'], limit: 1 }, {}, B);
    expect((await s.res()).status).toBe(200);
    const all = JSON.stringify(s.tx.calls.map((c) => c.values));
    expect(all).toContain(B);
    expect(all).not.toContain(A);
  });
});
