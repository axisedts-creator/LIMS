// FD-T03 — Frontdesk repositories + RLS integration (06-PLAN row FD-T03; 07-SEC §6.1 list/table probes, §6.3). Real migrated PG17, tenant_a/tenant_b.
// Contract: every repo function is `fn(tx, tenantId, ...args)`; tx = { query(text, values) -> { rows } } (core tx shape); returns RAW DB rows (snake_case)
// or null / []; every SQL names `tenant_id = $n` explicitly AND is schema-qualified (the login role has search_path ''). RLS is the backstop, not the filter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CENTRE, TENANT, TENANT_A, TENANT_B, appTx, closePools, ownerRows, rows, seedWorld, superTx, uid, type Side, type World } from './helpers.js';

const load = (n: string): Promise<any> => import(/* @vite-ignore */ `../../repository/${n}.repo.js`);
let W: Record<Side, World>;
beforeAll(async () => { W = { a: await seedWorld('a'), b: await seedWorld('b') }; }, 120_000);
afterAll(closePools);

const rejects42501 = async (p: Promise<unknown>) => {
  const e: any = await p.then(() => null, (x) => x);
  expect(e, 'insert across tenants must be refused by RLS WITH CHECK').not.toBeNull();
  expect(e.code).toBe('42501');
};

interface Spec {
  name: string; file: string; table: string;
  insert: string; get?: string; list?: string;
  make: (s: Side, w: World) => Record<string, unknown>;      // new row for side s, valid parents of side s
  of: (w: World) => any;                                     // the seeded row of this table
  listArg?: (w: World) => unknown[];                         // args after tenantId for list()
  listOf?: (w: World) => any[] ;                             // seeded rows list() must return for that side
}
const specs: Spec[] = [
  { name: 'patients', file: 'patients', table: 'frontdesk.patients', insert: 'insertPatient', get: 'getPatientById',
    make: (s) => rows.patient(s), of: (w) => w.patient },
  { name: 'consents', file: 'consents', table: 'frontdesk.patient_consents', insert: 'insertConsent', list: 'listConsentsByPatient',
    make: (s, w) => rows.consent(s, w.patient.id), of: (w) => w.consent, listArg: (w) => [w.patient.id] },
  { name: 'orders', file: 'orders', table: 'frontdesk.orders', insert: 'insertOrder', get: 'getOrderById', list: 'listOrdersByPatient',
    make: (s, w) => rows.order(s, w.patient.id), of: (w) => w.order, listArg: (w) => [w.patient.id] },
  { name: 'orderItems', file: 'orderItems', table: 'frontdesk.order_items', insert: 'insertOrderItem', get: 'getOrderItemById', list: 'listOrderItemsByOrder',
    make: (s, w) => rows.item(s, w.order.id), of: (w) => w.item, listArg: (w) => [w.order.id] },
  { name: 'discounts', file: 'discounts', table: 'frontdesk.discounts', insert: 'insertDiscount', get: 'getDiscountById', list: 'listDiscountsByOrder',
    make: (s, w) => rows.discount(s, w.order.id), of: (w) => w.discount, listArg: (w) => [w.order.id] },
  { name: 'discountApprovals', file: 'discountApprovals', table: 'frontdesk.discount_approvals', insert: 'insertDiscountApproval', get: 'getDiscountApprovalById',
    list: 'listOpenDiscountApprovals', make: (s, w) => rows.approval(s, w.patient.id), of: (w) => w.approval, listArg: () => [] },
  { name: 'trf', file: 'trf', table: 'frontdesk.trf_attachments', insert: 'insertTrfAttachment', get: 'getTrfAttachmentById', list: 'listTrfByOrder',
    make: (s, w) => rows.trf(s, w.order.id), of: (w) => w.trf, listArg: (w) => [w.order.id] },
  { name: 'flags', file: 'flags', table: 'frontdesk.order_flags', insert: 'insertOrderFlag', get: 'getOrderFlagById', list: 'listOrderFlagsByOrder',
    make: (s, w) => rows.flag(s, w.order.id), of: (w) => w.flag, listArg: (w) => [w.order.id] },
];

describe.each(specs)('$name.repo — integration + cross-tenant probes', (sp) => {
  const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

  it('module exports the contract functions', async () => {
    const m = await load(sp.file);
    for (const f of [sp.insert, sp.get, sp.list].filter(Boolean) as string[]) expect(typeof m[f], f).toBe('function');
  });

  it('insert (own tenant, under RLS) persists the row and returns it with the caller tenant_id', async () => {
    const m = await load(sp.file);
    const row = sp.make('a', W.a);
    const out = await appTx(TENANT_A, (tx) => m[sp.insert](tx, TENANT_A, row));
    const got = Array.isArray(out) ? out[0] : out;
    expect(got?.tenant_id).toBe(TENANT_A);
    const key = 'id' in row ? { col: 'id', v: row.id } : { col: 'source_ref_id', v: row.source_ref_id };
    expect(await ownerRows(sp.table, `tenant_id = $1 AND ${key.col} = $2`, [TENANT_A, key.v])).toHaveLength(1);
  });

  it('insert with the OTHER tenant\'s id under tenant_a claims is refused by RLS (42501) and writes nothing (cross-tenant INSERT probe)', async () => {
    const m = await load(sp.file);
    const row = sp.make('b', W.b);
    await rejects42501(appTx(TENANT_A, (tx) => m[sp.insert](tx, TENANT_B, row)));
    expect(await ownerRows(sp.table, `id = $1`, [row.id])).toHaveLength(0);
  });

  it('a tenant_id smuggled inside the row object cannot override the tenantId argument (forged tenant_id)', async () => {
    const m = await load(sp.file);
    const row = { ...sp.make('a', W.a), tenant_id: TENANT_B };
    const r = await appTx(TENANT_A, (tx) => m[sp.insert](tx, TENANT_A, row)).then((o) => ({ ok: o }), (e) => ({ err: e }));
    if ('err' in r) expect((r.err as any).code).toBe('42501'); // refusing is fine
    expect(await ownerRows(sp.table, `tenant_id = $1 AND id = $2`, [TENANT_B, row.id])).toHaveLength(0); // never stored under B
  });

  if (sp.get) {
    it('get returns the row inside the tenant', async () => {
      const m = await load(sp.file);
      const got = await appTx(TENANT_A, (tx) => m[sp.get!](tx, TENANT_A, sp.of(W.a).id));
      expect(got?.id).toBe(sp.of(W.a).id);
      expect(got.tenant_id).toBe(TENANT_A);
    });
    it('get of a B id with tenantId=A is null with RLS BYPASSED (the repo\'s own explicit tenant_id filter) — both directions', async () => {
      const m = await load(sp.file);
      expect(await superTx((tx) => m[sp.get!](tx, TENANT_A, sp.of(W.b).id))).toBeNull();
      expect(await superTx((tx) => m[sp.get!](tx, TENANT_B, sp.of(W.a).id))).toBeNull();
      expect((await superTx((tx) => m[sp.get!](tx, TENANT_B, sp.of(W.b).id)))?.id).toBe(sp.of(W.b).id); // same query does work in-tenant
    });
    it('get with tenantId=B but tenant_a claims returns null (RLS backstop), and with a random id returns null (no throw)', async () => {
      const m = await load(sp.file);
      expect(await appTx(TENANT_A, (tx) => m[sp.get!](tx, TENANT_B, sp.of(W.b).id))).toBeNull();
      expect(await appTx(TENANT_A, (tx) => m[sp.get!](tx, TENANT_A, uid()))).toBeNull();
    });
  }

  if (sp.list) {
    it('list returns only the tenant\'s rows, RLS bypassed (explicit filter) and under RLS', async () => {
      const m = await load(sp.file);
      for (const s of ['a', 'b'] as Side[]) {
        const viaOwner = await superTx((tx) => m[sp.list!](tx, TENANT[s], ...sp.listArg!(W[s])));
        expect(viaOwner.length).toBeGreaterThan(0);
        expect(viaOwner.every((r: any) => r.tenant_id === TENANT[s])).toBe(true);
        expect(viaOwner.map((r: any) => r.id ?? r.source_ref_id)).toContain(sp.of(W[s]).id);
        const viaApp = await appTx(TENANT[s], (tx) => m[sp.list!](tx, TENANT[s], ...sp.listArg!(W[s])));
        expect(viaApp.every((r: any) => r.tenant_id === TENANT[s])).toBe(true);
      }
    });
    it('list with the OTHER tenant\'s parent id (or tenantId) yields zero rows — id swap probe', async () => {
      const m = await load(sp.file);
      for (const s of ['a', 'b'] as Side[]) {
        const o = other(s);
        if (sp.listArg!(W[o]).length) // parent-scoped lists: A's tenantId + B's parent id
          expect(await superTx((tx) => m[sp.list!](tx, TENANT[s], ...sp.listArg!(W[o])))).toEqual([]);
        expect((await appTx(TENANT[s], (tx) => m[sp.list!](tx, TENANT[o], ...sp.listArg!(W[o])))).filter((r: any) => r.tenant_id === TENANT[o])).toEqual([]);
      }
    });
  }
});

describe('patients.repo — search', () => {
  it('searchPatientsByName(tx, tenantId, query, limit) returns only the tenant\'s matches, bypassed and under RLS', async () => {
    const m = await load('patients');
    const q = 'asha';
    const owner = await superTx((tx) => m.searchPatientsByName(tx, TENANT_A, q, 50));
    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((r: any) => r.tenant_id === TENANT_A)).toBe(true);
    expect(owner.map((r: any) => r.id)).toContain(W.a.patient.id);
    expect(owner.map((r: any) => r.id)).not.toContain(W.b.patient.id);
    expect(await appTx(TENANT_A, (tx) => m.searchPatientsByName(tx, TENANT_B, q, 50))).toEqual([]);
  });
  it('limit is honoured; hostile query text is data, not SQL (injection)', async () => {
    const m = await load('patients');
    expect((await superTx((tx) => m.searchPatientsByName(tx, TENANT_A, 'asha', 1))).length).toBeLessThanOrEqual(1);
    for (const evil of ["' OR '1'='1", "%'; DROP TABLE frontdesk.patients; --", '\\']) {
      const r = await superTx((tx) => m.searchPatientsByName(tx, TENANT_A, evil, 50));
      expect(r.every((x: any) => x.tenant_id === TENANT_A)).toBe(true);
      expect(r.length).toBe(0);
    }
    expect(await ownerRows('frontdesk.patients', 'id = $1', [W.a.patient.id])).toHaveLength(1);
  });
  it('duplicate patient_code in the same tenant is rejected (23505); the same code in the other tenant is fine', async () => {
    const m = await load('patients');
    const dup = rows.patient('a', { patient_code: W.a.patient.patient_code });
    const e: any = await appTx(TENANT_A, (tx) => m.insertPatient(tx, TENANT_A, dup)).then(() => null, (x) => x);
    expect(e?.code).toBe('23505');
    const ok = rows.patient('b', { patient_code: W.a.patient.patient_code });
    expect((await appTx(TENANT_B, (tx) => m.insertPatient(tx, TENANT_B, ok)))?.tenant_id).toBe(TENANT_B);
  });
});

describe('consents.repo — append-only (REQ-SEC-005)', () => {
  it('exports no update/delete/remove function', async () => {
    const m = await load('consents');
    expect(Object.keys(m).filter((k) => /^(update|delete|remove|purge|set)/i.test(k))).toEqual([]);
  });
  it('listConsentsByPatient is newest-first (captured_at DESC)', async () => {
    const m = await load('consents');
    const p = rows.patient('a'); await appTx(TENANT_A, async (tx) => (await load('patients')).insertPatient(tx, TENANT_A, p));
    for (const at of ['2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z'])
      await appTx(TENANT_A, (tx) => m.insertConsent(tx, TENANT_A, rows.consent('a', p.id, { captured_at: at })));
    const got = await appTx(TENANT_A, (tx) => m.listConsentsByPatient(tx, TENANT_A, p.id));
    expect(got.map((r: any) => new Date(r.captured_at).toISOString().slice(0, 7))).toEqual(['2026-03', '2026-02', '2026-01']);
  });
});

describe('orders.repo', () => {
  it('duplicate registration_no in a tenant is rejected (23505)', async () => {
    const m = await load('orders');
    const e: any = await appTx(TENANT_A, (tx) => m.insertOrder(tx, TENANT_A, rows.order('a', W.a.patient.id, { registration_no: W.a.order.registration_no }))).then(() => null, (x) => x);
    expect(e?.code).toBe('23505');
  });
  it('order of patient B cannot be created under tenant A ids (FK is tenant-composite): A order with B patient fails', async () => {
    const m = await load('orders');
    const e: any = await appTx(TENANT_A, (tx) => m.insertOrder(tx, TENANT_A, rows.order('a', W.b.patient.id))).then(() => null, (x) => x);
    expect(e?.code).toBe('23503');
  });
});

describe('bookingLinks.repo', () => {
  it('getBookingLink(tx, tenantId, source, sourceRefId): in-tenant found; other tenant null with RLS bypassed and under RLS', async () => {
    const m = await load('bookingLinks');
    const a = W.a.link, b = W.b.link;
    expect((await appTx(TENANT_A, (tx) => m.getBookingLink(tx, TENANT_A, a.source, a.source_ref_id)))?.order_id).toBe(a.order_id);
    expect(await superTx((tx) => m.getBookingLink(tx, TENANT_A, b.source, b.source_ref_id))).toBeNull();
    expect(await appTx(TENANT_A, (tx) => m.getBookingLink(tx, TENANT_B, b.source, b.source_ref_id))).toBeNull();
  });
  it('insertBookingLink: own tenant ok, B under A claims refused (42501); duplicate (source, source_ref_id) in tenant is 23505', async () => {
    const m = await load('bookingLinks');
    const mine = rows.bookingLink('a', W.a.order.id);
    expect((await appTx(TENANT_A, (tx) => m.insertBookingLink(tx, TENANT_A, mine)))?.tenant_id).toBe(TENANT_A);
    const e: any = await appTx(TENANT_A, (tx) => m.insertBookingLink(tx, TENANT_A, mine)).then(() => null, (x) => x);
    expect(e?.code).toBe('23505');
    const theirs = rows.bookingLink('b', W.b.order.id);
    await rejects42501(appTx(TENANT_A, (tx) => m.insertBookingLink(tx, TENANT_B, theirs)));
    expect(await ownerRows('frontdesk.booking_links', 'tenant_id = $1 AND source_ref_id = $2', [TENANT_B, theirs.source_ref_id])).toHaveLength(0);
  });
});

describe('settings.repo', () => {
  it('getSettings(tx, tenantId): own row; other tenant null (bypassed and under RLS)', async () => {
    const m = await load('settings');
    expect((await appTx(TENANT_A, (tx) => m.getSettings(tx, TENANT_A)))?.tenant_id).toBe(TENANT_A);
    expect((await superTx((tx) => m.getSettings(tx, TENANT_B)))?.tenant_id).toBe(TENANT_B);
    expect(await appTx(TENANT_A, (tx) => m.getSettings(tx, TENANT_B))).toBeNull();
  });
});

describe('counters.repo — nextCounterValue(tx, tenantId, kind, scopeKey, actorId)', () => {
  const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
  const scope = () => `fdt03-${uid()}`;
  it('first call is 1, then 2, 3 (monotonic); tenants are independent', async () => {
    const m = await load('counters');
    const sk = scope();
    const next = (t: string) => appTx(t, (tx) => m.nextCounterValue(tx, t, 'registration_no', sk, ACTOR)).then(Number);
    expect([await next(TENANT_A), await next(TENANT_A), await next(TENANT_A)]).toEqual([1, 2, 3]);
    expect(await next(TENANT_B)).toBe(1);
    expect(await next(TENANT_A)).toBe(4);
  });
  it('20 concurrent allocations (separate connections) return 20 distinct values 1..20 — no duplicate numbers', async () => {
    const m = await load('counters');
    const sk = scope();
    const got = (await Promise.all(Array.from({ length: 20 }, () => appTx(TENANT_A, (tx) => m.nextCounterValue(tx, TENANT_A, 'registration_no', sk, ACTOR))))).map(Number);
    expect([...got].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  }, 60_000);
  it('a rolled-back allocation may leave a gap but a committed value never repeats (03-IC §9.3)', async () => {
    const m = await load('counters');
    const sk = scope();
    const v1 = Number(await appTx(TENANT_A, (tx) => m.nextCounterValue(tx, TENANT_A, 'patient_code', sk, ACTOR)));
    await appTx(TENANT_A, async (tx) => { await m.nextCounterValue(tx, TENANT_A, 'patient_code', sk, ACTOR); throw new Error('boom'); }).catch(() => {});
    const v3 = Number(await appTx(TENANT_A, (tx) => m.nextCounterValue(tx, TENANT_A, 'patient_code', sk, ACTOR)));
    expect(v3).toBeGreaterThan(v1); // gaps allowed (03-IC §9.3), repeats are not
  });
  it('allocating for tenant B under tenant_a claims is refused (42501) and B\'s counter is untouched', async () => {
    const m = await load('counters');
    const sk = scope();
    await rejects42501(appTx(TENANT_A, (tx) => m.nextCounterValue(tx, TENANT_B, 'registration_no', sk, ACTOR)));
    expect(await ownerRows('frontdesk.number_counters', 'tenant_id = $1 AND scope_key = $2', [TENANT_B, sk])).toHaveLength(0);
  });
  it('unknown counter_kind is refused by the DB CHECK (23514)', async () => {
    const m = await load('counters');
    const e: any = await appTx(TENANT_A, (tx) => m.nextCounterValue(tx, TENANT_A, 'invoice_no', scope(), ACTOR)).then(() => null, (x) => x);
    expect(e?.code).toBe('23514');
  });
});

describe('table sweep — no frontdesk repo leaks the other tenant (07-SEC §6.3 shape, through the repos)', () => {
  it('every list/get function, called with tenant_a and RLS bypassed, returns nothing from tenant_b', async () => {
    const out: any[] = [];
    for (const sp of specs) {
      const m = await load(sp.file);
      if (sp.list) out.push(...(await superTx((tx) => m[sp.list!](tx, TENANT_A, ...sp.listArg!(W.a)))));
    }
    expect(out.length).toBeGreaterThan(0);
    expect(out.filter((r) => r.tenant_id === TENANT_B)).toEqual([]);
    expect(CENTRE.a).not.toBe(CENTRE.b);
  });
});
