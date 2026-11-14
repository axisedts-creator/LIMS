// T-06 (C3) — searchOrderables (#2): ranking §7.9, filters, limit, LIKE escaping, tenant isolation, shape, statement budget.
// Spec: 02-TRD §5.2 #2 (q 1–64 required; kind, panel_kind, department_id, is_orderable default true, is_active default true, limit default 20 max 50;
//       `200 {data: OrderableSummary[]}` ranked §7.9, no cursor), §7.9 (exact code 0, code prefix 1, name prefix 2, name contains 3, then length(code), code),
//       §5.1 OrderableSummary; PRD AC-08.1 (code prefix before name matches; item fields; limit 20/50), AC-08.2 (% and _ literal — REQ-SEC-082),
//       AC-08.3 (tenant B never in tenant A's results); 07-SECURITY S-1, S-12 (LIKE escaping + limit), AB-14.
// Domain ranking/escaping itself: domain/__tests__/orderableSearch.test.ts. Here: the whole service over the SQL fake (LIKE … ESCAPE, ILIKE, || are modelled).
// The fake's dialect is one table per statement — department codes / panel kinds are therefore fetched with a second batched statement.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ID, pnl, tst } from '../helpers/testsDb.js';
import { BIOC, HAEM, HAEM_B, T, errPaths, events, rejection, setup, t6Own, validation400 } from '../helpers/t6.js';

type T6 = ReturnType<typeof tst> | ReturnType<typeof pnl>;
const rowsOf = (...xs: T6[]) => ({
  orderables: xs.map((x) => x.orderable),
  tests: xs.flatMap((x) => ('test' in x ? [x.test] : [])),
  panels: xs.flatMap((x) => ('panel' in x ? [x.panel] : [])),
});

let n = 100;
const test = (code: string, name: string, o: Record<string, unknown> = {}, dep = HAEM.id, tenant = TENANT_A) => tst(++n, tenant, dep, { code, name, ...o });
const panel = (code: string, name: string, o: Record<string, unknown> = {}, tenant = TENANT_A) => pnl(++n, tenant, { code, name, ...o });

const CBC_SET = [
  test('CBC', 'Complete blood count'), test('CBCD', 'CBC with differential'), test('HB1', 'CBC profile'), test('ZZ', 'Basic CBC set'), test('XCBC', 'Other'),
  panel('CBCP', 'CBC panel', { panel_kind: 'clinical', sex_restriction: 'female' }), panel('CBCPKG', 'CBC health package', { panel_kind: 'package' }),
  test('CBCOLD', 'Old CBC', { is_active: false }), test('CBCHID', 'Hidden CBC', { is_orderable: false }),
  test('CBC', 'Tenant B CBC', {}, HAEM_B.id, TENANT_B), test('CBCB1', 'Tenant B only', {}, HAEM_B.id, TENANT_B),
  test('BIO1', 'CBC in biochemistry', {}, BIOC.id),
];
const seed = (xs: T6[]) => setup({ t6: rowsOf(...xs) });
const search = (e: ReturnType<typeof seed>, query: Record<string, unknown>, tenantId = TENANT_A) => e.db.run((ctx) => e.svc['searchOrderables']!(ctx, query), { tenantId });
const codes = (r: { data: any[] }) => r.data.map((x) => x.code);

describe('AC-08.1 ranking and shape', () => {
  it('"cbc": exact code first, then code prefix (shorter code, then code), then name prefix, then name contains; code-contains-only and inactive/non-orderable/other-tenant rows are absent', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    const r = await search(e, { q: 'cbc' });
    // rank 0: CBC | rank 1: CBCD, CBCP (len 4, by code), CBCPKG (len 6) | rank 2 (name prefix): HB1 (len 3), BIO1 (len 4) | rank 3 (name contains): ZZ
    expect(codes(r)).toEqual(['CBC', 'CBCD', 'CBCP', 'CBCPKG', 'HB1', 'BIO1', 'ZZ']);
  });

  it('q is trimmed and case-insensitive: "  CbC \t" == "cbc"', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect(codes(await search(e, { q: '  CbC \t' }))).toEqual(codes(await search(e, { q: 'cbc' })));
  });

  it('items carry exactly the OrderableSummary fields; null optionals are omitted (department_id/sex_restriction on panels, workflow_type on panels, panel_kind on tests)', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    const r = await search(e, { q: 'cbc' });
    const byCode = Object.fromEntries(r.data.map((x: any) => [x.code, x]));
    expect(byCode['CBC']).toEqual({
      id: CBC_SET[0]!.orderable.id, kind: 'test', code: 'CBC', name: 'Complete blood count', department_id: HAEM.id, department_code: 'HAEM', workflow_type: 'standard',
      is_orderable: true, is_active: true, revision: 0,
    });
    expect(byCode['CBCP']).toEqual({ id: CBC_SET[5]!.orderable.id, kind: 'panel', code: 'CBCP', name: 'CBC panel', panel_kind: 'clinical', sex_restriction: 'female', is_orderable: true, is_active: true, revision: 0 });
    expect(byCode['CBCPKG']).toMatchObject({ kind: 'panel', panel_kind: 'package' });
    expect(byCode['BIO1']).toMatchObject({ department_id: BIOC.id, department_code: 'BIOC' });
    expect(JSON.stringify(r)).not.toMatch(/tenant_id|created_by|updated_by|"version"/);
  });

  it('the stamped revision of the orderable is returned', { timeout: T }, async () => {
    const e = seed([test('REV', 'Revised', { revision: 421 })]);
    expect((await search(e, { q: 'rev' })).data[0]).toMatchObject({ code: 'REV', revision: 421 });
  });

  it('limit applies AFTER ranking: a rank-0 row that sorts late alphabetically is never cut', { timeout: T }, async () => {
    const lows = Array.from({ length: 40 }, (_, i) => test(`A${String(i).padStart(2, '0')}`, `b-name ${i}`));
    const e = seed([...lows, test('B', 'Exact'), test('BETA', 'Prefix'), test('C1', 'rank three has b inside')]);
    expect(codes(await search(e, { q: 'b', limit: 3 }))).toEqual(['B', 'BETA', 'A00']);
    const all = await search(e, { q: 'b', limit: 50 });
    expect(all.data).toHaveLength(43);                                   // B, BETA, 40 name-prefix rows, C1 (name contains)
    expect(codes(all).at(-1)).toBe('C1');
  });
});

describe('AC-08.1 limit', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => test(`LIM${String(i + 1).padStart(2, '0')}`, `Limit row ${i + 1}`));
  it('default 20; explicit limits; max 50; the first rows are the best-ranked ones', { timeout: T }, async () => {
    const many = Array.from({ length: 60 }, (_, i) => test(`LIM${String(i + 1).padStart(2, '0')}`, `Limit row ${i + 1}`));
    const e = seed(many);
    const d = await search(e, { q: 'lim' });
    expect(d.data).toHaveLength(20);
    expect(codes(d)).toEqual(many.slice(0, 20).map((x) => x.orderable.code));
    expect((await search(e, { q: 'lim', limit: 5 })).data).toHaveLength(5);
    expect((await search(e, { q: 'lim', limit: 1 })).data).toHaveLength(1);
    expect((await search(e, { q: 'lim', limit: 50 })).data).toHaveLength(50);
    expect(d).not.toHaveProperty('page');                                // no cursor
  });
  it.each([[0], [51], [1000], [-1], [1.5], [NaN], [null]])('limit %j -> 400 path /limit', { timeout: T }, async (limit) => {
    const e = seed(thirty);
    const err = await rejection(search(e, { q: 'lim', limit }));
    validation400(err);
    if (err.code === 'common.validation_failed') expect(errPaths(err)).toContain('/limit');
  });
});

describe('AC-08.2 / REQ-SEC-082 / S-12: LIKE metacharacters are literal', () => {
  const W = [
    test('W1', '100% pure'), test('W2', 'Alpha'), test('W3', 'Alpha_beta'), test('W4', 'AlphaXbeta'), test('W5', 'back\\slash'),
    test('A_B', 'underscore code'), test('AXB', 'x code'), test('W6', 'per cent 5%'),
  ];
  it.each([
    ['%', ['W1', 'W6']], ['_', ['W3']], ['%%', []], ['100%', ['W1']], ['alpha_', ['W3']], ['alpha_b', ['W3']], ['a_', ['A_B', 'W3']], ['\\', ['W5']], ['\\%', []], ['\\_', []],
    ['e%', []], ['5%', ['W6']], ['.*', []], ['(', []], ['[a-z]', []],
  ])('q %j -> %j', { timeout: T }, async (q, expected) => {
    const e = seed(W);
    expect(codes(await search(e, { q }))).toEqual(expected);
  });

  it('an injection attempt is data: no match, and its text never appears in any statement', { timeout: T }, async () => {
    const e = seed(W);
    const q = "x' OR '1'='1'; DROP TABLE catalog.orderables;--";
    expect(codes(await search(e, { q }))).toEqual([]);
    for (const s of e.db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain("'1'='1'"); }
    expect(e.db.rows('orderables')).toHaveLength(W.length);
  });

  it('a 64-char q is accepted (matches nothing)', { timeout: T }, async () => {
    const e = seed(W);
    expect((await search(e, { q: 'x'.repeat(64) })).data).toEqual([]);
  });
});

describe('AC-08.3 / S-1: tenant isolation', () => {
  it('tenant B\'s orderables never appear in A\'s results (same code, same name, other department) — and vice versa', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    const a = await search(e, { q: 'cbc', is_active: 'all' });
    expect(JSON.stringify(a)).not.toMatch(/Tenant B|CBCB1/);
    expect(a.data.filter((x: any) => x.code === 'CBC')).toHaveLength(1);
    expect(a.data.find((x: any) => x.code === 'CBC').department_id).toBe(HAEM.id);
    const b = await search(e, { q: 'cbc', is_active: 'all' }, TENANT_B);
    expect(codes(b)).toEqual(['CBC', 'CBCB1']);
    expect(b.data[0]).toMatchObject({ name: 'Tenant B CBC', department_id: HAEM_B.id, department_code: 'HAEM' });
    expect(JSON.stringify(b)).not.toMatch(/Complete blood count|CBCD|BIO1|biochemistry/);
  });

  it('a department_id filter naming tenant B\'s department returns nothing for tenant A and reveals nothing', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect((await search(e, { q: 'cbc', department_id: HAEM_B.id })).data).toEqual([]);
    expect((await search(e, { q: 'cbc', department_id: ID(0xdead) })).data).toEqual([]);
  });

  it('every statement on the orderables family carries an explicit tenant_id = $n predicate and binds the caller\'s tenant', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    await search(e, { q: 'cbc' });
    const own = t6Own(e.db);
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) { expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(s.values).toContain(TENANT_A); expect(s.values).not.toContain(TENANT_B); }
  });
});

describe('filters', () => {
  it('kind', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect(codes(await search(e, { q: 'cbc', kind: 'test' }))).toEqual(['CBC', 'CBCD', 'HB1', 'BIO1', 'ZZ']);
    expect(codes(await search(e, { q: 'cbc', kind: 'panel' }))).toEqual(['CBCP', 'CBCPKG']);
  });
  it('panel_kind selects panels of that kind only (tests have none)', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect(codes(await search(e, { q: 'cbc', panel_kind: 'package' }))).toEqual(['CBCPKG']);
    expect(codes(await search(e, { q: 'cbc', panel_kind: 'clinical' }))).toEqual(['CBCP']);
  });
  it('department_id', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect(codes(await search(e, { q: 'cbc', department_id: BIOC.id }))).toEqual(['BIO1']);
  });
  it('is_active: default hides inactive; "all" includes; "false" only inactive', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect(codes(await search(e, { q: 'cbc' }))).not.toContain('CBCOLD');
    expect(codes(await search(e, { q: 'cbc', is_active: 'all' }))).toContain('CBCOLD');
    expect(codes(await search(e, { q: 'cbc', is_active: 'false' }))).toEqual(['CBCOLD']);
    expect(codes(await search(e, { q: 'cbc', is_active: 'true' }))).not.toContain('CBCOLD');
  });
  it('is_orderable defaults to true: non-orderable rows are hidden', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    expect(codes(await search(e, { q: 'cbc' }))).not.toContain('CBCHID');
    expect(codes(await search(e, { q: 'cbc', is_orderable: true }))).not.toContain('CBCHID');
  });
});

describe('validation (the service validates itself)', () => {
  it.each([
    ['q missing', {}, '/q'], ['q empty', { q: '' }, '/q'], ['q blank', { q: '   ' }, '/q'], ['q 65 chars', { q: 'x'.repeat(65) }, '/q'], ['q number', { q: 5 }, '/q'], ['q object', { q: { a: 1 } }, '/q'],
    ['kind unknown', { q: 'a', kind: 'analyte' }, '/kind'], ['panel_kind unknown', { q: 'a', panel_kind: 'bundle' }, '/panel_kind'],
    ['department_id not a uuid', { q: 'a', department_id: 'nope' }, '/department_id'], ['is_active unknown', { q: 'a', is_active: 'maybe' }, '/is_active'],
    ['is_orderable string', { q: 'a', is_orderable: 'yes' }, '/is_orderable'], ['undeclared tenant_id', { q: 'a', tenant_id: TENANT_B }, '/tenant_id'], ['undeclared cursor', { q: 'a', cursor: 'abc' }, '/cursor'],
  ])('%s -> 400', { timeout: T }, async (_n, query, path) => {
    const e = seed(CBC_SET);
    const err = await rejection(search(e, query as Record<string, unknown>));
    validation400(err);
    if (err.code === 'common.validation_failed') expect(errPaths(err)).toContain(path);
    expect(e.db.stmts.filter((s) => s.tenantId === TENANT_A)).toHaveLength(0);       // rejected before any SQL
  });
  it('error detail never echoes the submitted q (AB-20)', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    const err = await rejection(search(e, { q: 'PLANTED-VALUE-9c1d'.repeat(5) }));
    expect(JSON.stringify({ m: err.message, d: err.detail, errs: err.errors })).not.toContain('PLANTED-VALUE');
  });
});

describe('read-only and cheap', () => {
  it('no INSERT/UPDATE/DELETE, no event, no revision bump', { timeout: T }, async () => {
    const e = seed(CBC_SET);
    await search(e, { q: 'cbc' });
    for (const s of e.db.stmts.filter((x) => x.tenantId === TENANT_A)) expect(s.text).toMatch(/^\s*SELECT/i);
    expect(events(e.db)).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417);
  });
  it('statement budget: at most 4 statements for a full page (no per-row lookups for department code / panel kind)', { timeout: T }, async () => {
    const many = Array.from({ length: 30 }, (_, i) => (i % 3 ? test(`BUD${i}`, `Budget ${i}`, {}, i % 2 ? HAEM.id : BIOC.id) : panel(`BUD${i}`, `Budget ${i}`, { panel_kind: i % 2 ? 'clinical' : 'package' })));
    const e = seed(many);
    const r = await search(e, { q: 'bud', limit: 20 });
    expect(r.data).toHaveLength(20);
    expect(e.db.stmts.filter((s) => s.tenantId === TENANT_A).length).toBeLessThanOrEqual(4);
  });
  it('a quiet query on an empty catalog is an empty list, not an error', { timeout: T }, async () => {
    const e = seed([]);
    expect(await search(e, { q: 'anything' })).toEqual({ data: [] });
  });
});
