// C12.T-26 chunk gate, part 3 (ruling C12.T-26-ruling.md item 1): the 07-SECURITY §6 tests the presence check found missing: PE-4, IT-3, LT-2 (IT-4 is carried by the T-16 / T-17 duplicate-event
// suites, renamed to name it). Real migrated database as role lims_api with RLS on (harness tests/db/c12-t26/run.sh). Every test runs in ONE transaction that is ROLLED BACK: nothing is left for the perf files.
// Seams: same as gate.helpers.ts (handlers[op](req, ctx), a refusal is a thrown LimsError; the IdentityPort stub of makeRepCtx / makeCtx). Synthetic data only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGE, READ, makeCtx } from '../../handlers/__tests__/masters.helpers.js';
import * as ledger from '../../service/ledger.service.js';
import { ADMIN_URL, API_URL, A, SYS, LimsError, OPERATIONS, applyFixtures, buildRequest, call, live, uid, withSession } from './gate.helpers.js';

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 4 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await applyFixtures(admin);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

// ============================================================================================================================ PE-4 (07 §6.3)
describe.skipIf(!live)('PE-4 membership revoked after token issue: the IdentityPort re-validates on every call, so privileged operations fail and change nothing', () => {
  const privileged = OPERATIONS.filter((o) => o.privileged);
  it('the contract lists the privileged operations (#32 #33 #48 #53 #55 #67 #79 #84 #86 #93)', () => { for (const n of [32, 33, 48, 53, 55, 67, 79, 84, 86, 93]) expect(privileged.map((o) => o.n)).toContain(n); });
  for (const o of privileged) {
    it(`#${o.n} ${o.op}: a revoked member (the port grants nothing any more) is refused (auth.forbidden / auth.unauthenticated, or 404 for an object the member can no longer see) and nothing is written`, () => withSession(api, async (s) => {
      const { req } = buildRequest(o, 'A');
      const count = async () => JSON.stringify(await s.sql(A, `SELECT (SELECT count(*) FROM inventory.stock_movements WHERE tenant_id = $1) AS m, (SELECT count(*) FROM inventory.stock_documents WHERE tenant_id = $1) AS d,
        (SELECT count(*) FROM inventory.goods_receipts WHERE tenant_id = $1) AS g, (SELECT count(*) FROM inventory.stock_counts WHERE tenant_id = $1) AS c, (SELECT count(*) FROM inventory.consumption_facts WHERE tenant_id = $1) AS f`, [A]));
      const before = await count();
      const err = await s.go(o.op, req, { permissions: [], all: false, branchIds: [] }).then(() => undefined, (e) => e as LimsError);
      expect(err, `#${o.n} ${o.op} succeeded for a member whose membership was revoked`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated', 'common.not_found'], `#${o.n}: ${err!.code}`).toContain(err!.code);
      if (o.op === 'exportInventoryReport') expect(err!.code).toBe('auth.forbidden'); // tenant-level gate first: no object to hide behind
      expect(await count()).toBe(before);
    }));
  }
});

// ============================================================================================================================ IT-3 (07 §6.4)
describe.skipIf(!live)('IT-3 balance-vs-ledger property test: 1,000 randomised operations (fixed seed), then balance = sum of movements (qty and value) for every (store, item, lot)', () => {
  it('after 1,000 receive / issue / wastage / adjust_out / consume_test postings the balances equal the ledger sums, lot rows are never negative and the model agrees', () => withSession(api, async (s) => {
    const c = s.client;
    await s.sql(A, 'SELECT 1');
    const S1 = uid(1001); const S2 = uid(1002); // tenant A stores (tests/db/c12-t03/fixtures.sql)
    const rc = { tx: { query: (t: string, v?: unknown[]) => c.query(t, v) }, tenantId: A, actorId: SYS };
    const items: string[] = []; const lots: { store: string; item: string; lot: string; qty: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const item = randomUUID(); items.push(item);
      await c.query(`INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, created_by, updated_by)
        VALUES ($1, $2, $3, 'IT3 item', 'reagent', 'test', true, true, $4, $4)`, [item, A, `IT3-${i}-${item.slice(0, 6).toUpperCase()}`, SYS]);
      for (let j = 0; j < 2; j++) {
        const lot = randomUUID();
        await c.query(`INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, created_by, updated_by) VALUES ($1, $2, $3, $4, '2031-01-01', $5, $5)`, [lot, A, item, `IT3-LOT-${i}${j}`, SYS]);
        for (const store of [S1, S2]) lots.push({ store, item, lot, qty: 0 });
      }
    }
    let seed = 20260615; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; // fixed seed: the same 1,000 operations on every run
    const DOC = { receive: 'goods_receipt', issue: 'stock_document', wastage: 'stock_document', adjust_out: 'stock_document', consume_test: 'consumption_fact' } as const;
    const today = new Date().toISOString().slice(0, 10);
    const counts: Record<string, number> = {};
    for (let n = 0; n < 1000; n++) {
      const l = lots[Math.floor(rnd() * lots.length)]!;
      const pick = rnd();
      let kind: keyof typeof DOC = pick < 0.45 || l.qty < 1 ? 'receive' : pick < 0.7 ? 'issue' : pick < 0.8 ? 'wastage' : pick < 0.9 ? 'adjust_out' : 'consume_test';
      const q = kind === 'receive' ? 1 + Math.floor(rnd() * 50) : 1 + Math.floor(rnd() * Math.min(l.qty, 20));
      const mvt: Record<string, unknown> = { store_id: l.store, item_id: l.item, lot_id: l.lot, kind, qty_base: String(kind === 'receive' ? q : -q) };
      if (kind === 'receive') mvt['value_hint'] = q * (10 + Math.floor(rnd() * 90)) + Math.floor(rnd() * 7);
      if (kind === 'wastage' || kind === 'adjust_out') mvt['reason_code'] = 'syn_reason';
      await c.query('SAVEPOINT it3');
      try { await ledger.post(rc as never, { doc_type: DOC[kind], doc_id: randomUUID(), occurred_at: new Date().toISOString(), business_date: today, movements: [mvt] } as never); await c.query('RELEASE SAVEPOINT it3'); }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT it3'); throw new Error(`operation ${n} (${kind} ${JSON.stringify(mvt)}) was refused: ${(e as Error).message}`); }
      l.qty += kind === 'receive' ? q : -q; counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Object.keys(counts).length, `the sequence exercised ${JSON.stringify(counts)}`).toBeGreaterThanOrEqual(4);
    const drift = await c.query(`SELECT coalesce(b.store_id, m.store_id) AS store_id, coalesce(b.item_id, m.item_id) AS item_id, b.qty_base, b.value_paisa, m.q, m.v
      FROM (SELECT * FROM inventory.stock_balances WHERE item_id = ANY($1)) b
      FULL JOIN (SELECT store_id, item_id, lot_id, sum(qty_base) q, sum(value_paisa) v FROM inventory.stock_movements WHERE item_id = ANY($1) GROUP BY 1, 2, 3) m
        ON m.store_id = b.store_id AND m.item_id = b.item_id AND m.lot_id IS NOT DISTINCT FROM b.lot_id
      WHERE b.qty_base IS DISTINCT FROM m.q AND NOT (b.qty_base = 0 AND m.q IS NULL) OR b.value_paisa IS DISTINCT FROM m.v AND NOT (b.value_paisa = 0 AND m.v IS NULL)`, [items]);
    expect(drift.rows, 'TRD §10.1: balance == sum of movements').toEqual([]);
    expect((await c.query('SELECT 1 FROM inventory.stock_balances WHERE item_id = ANY($1) AND lot_id IS NOT NULL AND qty_base < 0', [items])).rows, 'TRD §10.2').toEqual([]);
    for (const l of lots) { // the independent model of the test agrees with the ledger
      const r = (await c.query('SELECT qty_base FROM inventory.stock_balances WHERE store_id = $1 AND item_id = $2 AND lot_id = $3', [l.store, l.item, l.lot])).rows[0];
      expect(Number(r?.qty_base ?? 0), `${l.store}/${l.lot}`).toBe(l.qty);
    }
  }), 600_000);
});

// ============================================================================================================================ LT-2 (07 §6.5)
describe.skipIf(!live)('LT-2 supplier contact values never appear in logs (ctx.log, console, stdout) nor in error messages / details, for create, update, list and refused calls', () => {
  it('contact_name, phone_display, email, address_text of a supplier written through #20 / #21 and read through #18 / #19 are in the DTO only', () => withSession(api, async (s) => {
    await s.sql(A, 'SELECT 1');
    const tag = randomUUID().slice(0, 8);
    const contact = { contact_name: `Synthetic Contact ${tag}`, phone_display: `+977-98${tag.replace(/\D/g, '0')}00`, email: `lt2-${tag}@example.invalid`, address_text: `Synthetic Street ${tag}` };
    const secrets = Object.values(contact);
    const out: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { out.push(JSON.stringify(a)); }));
    const so = vi.spyOn(process.stdout, 'write').mockImplementation(((x: unknown) => { out.push(String(x)); return true; }) as never);
    const se = vi.spyOn(process.stderr, 'write').mockImplementation(((x: unknown) => { out.push(String(x)); return true; }) as never);
    const st = makeCtx({ query: (t, v) => s.client.query(t, v) }, A, { permissions: [READ, MANAGE] });
    const errs: unknown[] = [];
    const run = async (op: string, req: Record<string, unknown>) => { try { return (await call(op, st.ctx, req)).body; } catch (e) { errs.push(e); return null; } };
    try {
      const created = await run('createInventorySupplier', { body: { supplier_code: `LT2${tag.slice(0, 5).toUpperCase()}`, name: 'LT2 supplier', ...contact } });
      expect(created?.id, 'the supplier was created (the DTO is where contact data belongs)').toBeTruthy();
      expect(JSON.stringify(created)).toContain(contact.email);
      await run('updateInventorySupplier', { params: { supplier_id: created.id }, headers: { 'if-match': `"${created.version}"` }, body: { ...contact, phone_display: `${contact.phone_display}1` } });
      await run('getInventorySupplier', { params: { supplier_id: created.id } });
      await run('listInventorySuppliers', { query: {} });
      await run('createInventorySupplier', { body: { supplier_code: 'lower case is invalid', name: 'LT2 refused', ...contact } }); // refused: validation error echoing nothing of the body
      await run('createInventorySupplier', { body: { supplier_code: `LT2${tag.slice(0, 5).toUpperCase()}`, name: 'LT2 duplicate', ...contact } }); // refused: duplicate code
    } finally { for (const x of [...spies, so, se]) x.mockRestore(); }
    const logged = JSON.stringify([st.logs, out]);
    for (const v of [...secrets, `${contact.phone_display}1`]) expect(logged, `a supplier contact value reached a log: ${v}`).not.toContain(v);
    const refusals = errs.map((e) => JSON.stringify([(e as LimsError).message, (e as LimsError).detail ?? null]));
    for (const r of refusals) for (const v of secrets) expect(r, 'an error carries a supplier contact value').not.toContain(v);
    expect(errs.length, 'the two refused calls were refused').toBeGreaterThanOrEqual(2);
  }));
});
