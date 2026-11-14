// T-29b (C3) — the REAL CatalogPort.getPriceListStatus (08 Addendum A24.1, CR-C16-023; consumer C16) over the composite SQL fake of helpers/quoteDb.ts (price_lists + price_list_versions). Interface: helpers/t28b.ts (SEAM header, same factory).
// Spec: 02-TRD §6.1 (getPriceListStatus row), §7.4a steps 1–4, §14 contract cases (34) (35); PRD AC-19.6; 07-SECURITY S-19 (+ S-1 tenant from ctx only, S-6 binds only); 08 R25 / P-21 (no v_pub_* view in a request handler).
// The shared packages/fakes/contract-tests/CatalogPort.contract.ts holds the A24.1 case for the FAKE (packages/fakes/__tests__/run-contracts.test.ts) and cannot be pointed at a half-built port (T-29 wires it).
// Here the same case numbers are asserted for the real port against rows seeded in the SQL fake. Answer = exactly { priceListId, isActive, status } (03-IC §4.2); rejection = LimsError common.not_found (404).
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { createRevisionService } from '../../service/revision.service.js';
import { A, NOW, T, TENANT_B, DEF, LB, call, codeOf, errOf, iso, setup28b, type Env28b } from '../helpers/t28b.js';
import { plist, pver } from '../helpers/quoteDb.js';
import type { Row } from '../helpers/mastersDb.js';

const ID = (n: number) => `0190c300-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const GHOST = ID(0xfff2);
const FUTURE = new Date('2027-06-01T00:00:00.000Z');                       // after NOW (2026-11-07)

// ---- lists of tenant A (credit_party owner; the base world's DEF is the tenant default). n >= 20 so ids/codes never collide with the base world.
const L = (n: number, o: Row = {}) => plist(n, A, o);
const V = (n: number, list: Row, no: number, status: string, o: Row = {}) => pver(n, A, list.id as string, no, { status, ...o });
const L_DRAFT = L(20), L_PUB = L(21), L_PUB_DRAFT = L(22), L_SUP_PUB = L(23), L_SUP_DRAFT = L(24), L_DISC = L(25), L_DISC_DRAFT = L(26), L_FUT = L(27);
const L_INACT_PUB = L(28, { is_active: false }), L_INACT_DRAFT = L(29, { is_active: false }), L_MANY = L(30);
const LB_DRAFT = plist(40, TENANT_B, { owner_kind: 'credit_party' });
const versions: Row[] = [
  V(20, L_DRAFT, 1, 'draft'),                                                                     // new list: draft v1 only
  V(21, L_PUB, 1, 'published'),
  V(22, L_PUB_DRAFT, 1, 'published'), V(23, L_PUB_DRAFT, 2, 'draft'),                           // published v1 + open draft v2
  V(24, L_SUP_PUB, 1, 'superseded', { effective_to: new Date('2026-06-01T00:00:00.000Z') }), V(25, L_SUP_PUB, 2, 'published', { effective_from: new Date('2026-06-01T00:00:00.000Z') }), V(26, L_SUP_PUB, 3, 'draft'),
  V(27, L_SUP_DRAFT, 1, 'superseded', { effective_to: new Date('2026-06-01T00:00:00.000Z') }), V(28, L_SUP_DRAFT, 2, 'draft'),
  V(29, L_DISC, 1, 'discarded'), V(30, L_DISC, 2, 'discarded'),                                  // every version discarded
  V(31, L_DISC_DRAFT, 1, 'discarded'), V(32, L_DISC_DRAFT, 2, 'draft'),                         // a discarded draft, then a new open draft
  V(33, L_FUT, 1, 'published', { effective_from: FUTURE }),                                       // only published version starts in the future
  V(34, L_INACT_PUB, 1, 'published'), V(35, L_INACT_DRAFT, 1, 'draft'),
  V(36, L_MANY, 1, 'superseded', { effective_to: new Date('2026-03-01T00:00:00.000Z') }), V(37, L_MANY, 2, 'superseded', { effective_from: new Date('2026-03-01T00:00:00.000Z'), effective_to: new Date('2026-06-01T00:00:00.000Z') }),
  V(38, L_MANY, 3, 'published', { effective_from: new Date('2026-06-01T00:00:00.000Z') }),
  pver(40, TENANT_B, LB_DRAFT.id as string, 1, { status: 'draft' }),
];
const world = () => setup28b({ price_lists: [L_DRAFT, L_PUB, L_PUB_DRAFT, L_SUP_PUB, L_SUP_DRAFT, L_DISC, L_DISC_DRAFT, L_FUT, L_INACT_PUB, L_INACT_DRAFT, L_MANY, LB_DRAFT], price_list_versions: versions });

const status = (env: Env28b, input: unknown, o: { tenantId?: string } = {}): Promise<any> => call(env, (p, ctx) => p['getPriceListStatus']!(ctx, input), o);
const of = (env: Env28b, list: Row, o: { tenantId?: string } = {}) => status(env, { priceListId: list.id }, o);
const expectStatus = async (env: Env28b, list: Row, isActive: boolean, st: string, o: { tenantId?: string } = {}) =>
  expect(await of(env, list, o), `${list['code']}`).toEqual({ priceListId: list.id, isActive, status: st });
const notFound = async (env: Env28b, input: unknown, o: { tenantId?: string } = {}) => expect(await codeOf(status(env, input, o)), JSON.stringify(input)).toBe('common.not_found');

describe('CatalogPort real impl: getPriceListStatus shape (08 A24.1)', () => {
  it('exposes getPriceListStatus as a function', { timeout: T }, () => {
    expect(typeof setup28b().port['getPriceListStatus']).toBe('function');
  });
});

describe('contract (34) getPriceListStatus derives the list status from its versions — 02-TRD §7.4a steps 2, 3; AC-19.6', () => {
  it('draft v1 only -> { isActive: true, status: draft }; the answer has exactly the three port keys', { timeout: T }, async () => {
    const r = await of(world(), L_DRAFT);
    expect(r).toEqual({ priceListId: L_DRAFT.id, isActive: true, status: 'draft' });
    expect(Object.keys(r).sort()).toEqual(['isActive', 'priceListId', 'status']);
  });
  it('published v1 -> published (also the tenant default list of the base world)', { timeout: T }, async () => {
    const env = world();
    await expectStatus(env, L_PUB, true, 'published');
    await expectStatus(env, DEF, true, 'published');
  });
  it('published v1 + open draft v2 -> published (published wins over draft)', { timeout: T }, async () => {
    await expectStatus(world(), L_PUB_DRAFT, true, 'published');
  });
  it('superseded v1 + published v2 + open draft v3 -> published, never superseded', { timeout: T }, async () => {
    await expectStatus(world(), L_SUP_PUB, true, 'published');
  });
  it('a chain of two superseded versions + the published successor -> published', { timeout: T }, async () => {
    await expectStatus(world(), L_MANY, true, 'published');
  });
  it('every version discarded -> discarded', { timeout: T }, async () => {
    await expectStatus(world(), L_DISC, true, 'discarded');
  });
  it('a discarded v1 and a new open draft v2 -> draft (an open draft beats discarded history)', { timeout: T }, async () => {
    await expectStatus(world(), L_DISC_DRAFT, true, 'draft');
  });
  it('superseded history + an open draft and no published version -> draft, never superseded', { timeout: T }, async () => {
    await expectStatus(world(), L_SUP_DRAFT, true, 'draft');
  });
  it('step 4: effectiveness is not part of the answer — a list whose only published version starts in the future is published', { timeout: T }, async () => {
    await expectStatus(world(), L_FUT, true, 'published');
  });
  it('a deactivated list reports isActive false with its derived status (published / draft); the caller combines the two', { timeout: T }, async () => {
    const env = world();
    await expectStatus(env, L_INACT_PUB, false, 'published');
    await expectStatus(env, L_INACT_DRAFT, false, 'draft');
  });
  it('no input ever yields superseded or retired: every seeded list answers within { draft, published, discarded }', { timeout: T }, async () => {
    const env = world();
    for (const list of [L_DRAFT, L_PUB, L_PUB_DRAFT, L_SUP_PUB, L_SUP_DRAFT, L_DISC, L_DISC_DRAFT, L_FUT, L_INACT_PUB, L_INACT_DRAFT, L_MANY, DEF]) {
      const r = await of(env, list);
      expect(['draft', 'published', 'discarded'], `${list['code']} -> ${r.status}`).toContain(r.status);
      expect(typeof r.isActive).toBe('boolean');
    }
  });
  it('the status follows a committed change: discarding the only draft of L_DRAFT (+ revision bump) turns draft into discarded on the next request, through the shared cache', { timeout: T }, async () => {
    const env = world();
    await expectStatus(env, L_DRAFT, true, 'draft');                                              // warms any price-list index
    const rev = createRevisionService({ events: createEvents({ producer: 'catalog' } as never) } as never);
    await env.db.price.run(async (ctx) => {
      await ctx.tx.query('UPDATE catalog.price_list_versions SET status = $1 WHERE tenant_id = $2 AND id = $3', ['discarded', A, versions[0]!['id']]);
      await rev.bumpRevision(ctx as never, { entityType: 'price_list', entityId: L_DRAFT.id as string, changeKind: 'updated', effectiveFrom: iso(NOW) });
    }, { at: NOW });
    await expectStatus(env, L_DRAFT, true, 'discarded');
  });
});

describe('contract (35) getPriceListStatus unknown id or another tenant\'s list -> common.not_found — §7.4a step 1; S-19', () => {
  it('unknown id -> LimsError common.not_found (404)', { timeout: T }, async () => {
    const err = await errOf(status(world(), { priceListId: GHOST }));
    expect(err.code).toBe('common.not_found');
    expect(err.statusCode).toBe(404);
  });
  it('tenant B\'s published list and draft list under tenant A -> common.not_found; the owner (B) reads its own', { timeout: T }, async () => {
    const env = world();
    await notFound(env, { priceListId: LB.id });
    await notFound(env, { priceListId: LB_DRAFT.id });
    expect(await status(env, { priceListId: LB.id }, { tenantId: TENANT_B })).toEqual({ priceListId: LB.id, isActive: true, status: 'published' });
    expect(await status(env, { priceListId: LB_DRAFT.id }, { tenantId: TENANT_B })).toEqual({ priceListId: LB_DRAFT.id, isActive: true, status: 'draft' });
  });
  it('and the reverse: tenant A\'s list under tenant B -> common.not_found', { timeout: T }, async () => {
    const env = world();
    await notFound(env, { priceListId: L_PUB.id }, { tenantId: TENANT_B });
    await notFound(env, { priceListId: DEF.id }, { tenantId: TENANT_B });
  });
  it('the id of a version (or of any non-list row) is not a list id -> common.not_found', { timeout: T }, async () => {
    const env = world();
    await notFound(env, { priceListId: versions[1]!['id'] });
  });
  it('malformed input never crashes with an untyped error: a LimsError common.not_found / common.validation_failed (hostile text is never an id)', { timeout: T }, async () => {
    const env = world();
    for (const input of [undefined, null, 'x', 42, [], {}, { priceListId: undefined }, { priceListId: null }, { priceListId: '' }, { priceListId: 'not-a-uuid' }, { priceListId: 42 }, { priceListId: {} },
      { priceListId: "x'; DROP TABLE catalog.price_lists; --" }, { priceListId: `${L_PUB.id}x` }, { priceListId: String(L_PUB.id).toUpperCase() + ' ' }]) {
      const code = await codeOf(status(env, input));
      expect(['common.not_found', 'common.validation_failed'], JSON.stringify(input)).toContain(code);
    }
  });
});

describe('getPriceListStatus — tenant isolation, nothing disclosed, read-only, binds only (07-SECURITY S-19, S-1, S-6; 08 R25 / P-21)', () => {
  it('S-19: the not_found error discloses neither isActive nor B\'s status', { timeout: T }, async () => {
    const env = world();
    for (const id of [LB.id, LB_DRAFT.id]) {
      const err = await errOf(status(env, { priceListId: id }));
      const dump = JSON.stringify({ message: err.message, details: err.details, code: err.code });
      expect(dump, String(id)).not.toMatch(/isActive|is_active|published|draft|discarded|superseded|"status"/i);
      expect(err.statusCode).toBe(404);
    }
  });
  it('the error for another tenant\'s list is indistinguishable from the one for an unknown id (same code, status, message)', { timeout: T }, async () => {
    const env = world();
    const foreign = await errOf(status(env, { priceListId: LB.id }));
    const unknown = await errOf(status(env, { priceListId: GHOST }));
    expect([foreign.code, foreign.statusCode, foreign.message]).toEqual([unknown.code, unknown.statusCode, unknown.message]);
  });
  it('tenant comes from ctx only: an input tenantId / tenant_id is ignored (A cannot reach B\'s list by naming B)', { timeout: T }, async () => {
    const env = world();
    await notFound(env, { priceListId: LB.id, tenantId: TENANT_B });
    await notFound(env, { priceListId: LB.id, tenant_id: TENANT_B });
    await expectStatus(env, L_PUB, true, 'published');
    expect(await status(env, { priceListId: L_PUB.id, tenantId: TENANT_B })).toEqual({ priceListId: L_PUB.id, isActive: true, status: 'published' });
  });
  it('one shared port + cache: interleaved requests of tenants A and B for the same id never cross answers (A: not_found, B: its own)', { timeout: T }, async () => {
    const env = world();
    const calls = Array.from({ length: 40 }, (_, i) => (i % 2
      ? status(env, { priceListId: LB.id }, { tenantId: TENANT_B }).then((r) => r.status)
      : codeOf(status(env, { priceListId: LB.id }))));
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 40 }, (_, i) => (i % 2 ? 'published' : 'common.not_found')));
    await expectStatus(env, L_PUB, true, 'published');                                           // A's own list is still fine afterwards
  });
  it('read-only (no write, no event), every price-list / version read binds the caller\'s tenant, no value is concatenated into SQL, only catalog.* base tables are read', { timeout: T }, async () => {
    const env = world();
    const hostile = "x'; DROP TABLE catalog.price_lists; --";
    await of(env, L_PUB);
    await of(env, L_DRAFT);
    await codeOf(status(env, { priceListId: LB.id }));
    await codeOf(status(env, { priceListId: hostile }));
    expect(env.db.writes).toEqual([]);
    const stmts = env.db.stmts;
    const reads = stmts.filter((s) => /\bprice_list(s|_versions)\b/i.test(s.text));
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.values, s.text).toContain(A);
    for (const s of stmts) {
      expect(s.text, s.text).not.toMatch(/DROP|--|\bx'|'/i);
      expect(s.text, s.text).not.toContain(String(L_PUB.id));
      for (const m of s.text.matchAll(/\b(?:FROM|JOIN)\s+([\w."]+)/gi)) expect(m[1], s.text).toMatch(/^(catalog|core)\./i);
    }
  });
  it('P-21 / R25: the request path reads no catalog.v_pub_* view and no item / surcharge / tax table', { timeout: T }, async () => {
    const env = world();
    await of(env, L_PUB);
    await of(env, L_PUB_DRAFT);
    await codeOf(status(env, { priceListId: GHOST }));
    for (const s of env.db.stmts) {
      expect(s.text, s.text).not.toMatch(/\bv_pub_/i);
      expect(s.text, s.text).not.toMatch(/\b(price_list_items|orderables|tax_rules|cs_tax_types|surcharge_rules|doctors|credit_parties)\b/i);
    }
  });
  it('deterministic and fresh: the same input gives deeply equal results; mutating one result never changes the next answer', { timeout: T }, async () => {
    const env = world();
    const a = await of(env, L_PUB);
    const b = await of(env, L_PUB);
    expect(b).toEqual(a);
    try { a.status = 'discarded'; a.isActive = false; } catch { /* frozen is fine too */ }
    expect(await of(env, L_PUB)).toEqual(b);
  });
});
