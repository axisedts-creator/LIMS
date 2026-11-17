// T-29a (C3) — the REAL CatalogPort.getTaxRate over the composite SQL fake (helpers/quoteDb.ts: cs_tax_types + g_tax_types). Interface: helpers/t28b.ts (SEAM header, same factory).
// Spec: 08 A2.2 / A4.1; 02-TRD §6.1 (getTaxRate row), §7.6a steps 1–6, §14 contract cases (27) (28) (29) (30); 03-IC §4.2 JSDoc (@throws catalog.tax_config_missing); 08 R18 (C3 sole owner of rates);
//       07-SECURITY S-1 (tenant from ctx only), S-6 (binds only).
// The shared packages/fakes/contract-tests/CatalogPort.contract.ts holds cases 27–30 for the FAKE (packages/fakes/__tests__/run-contracts.test.ts) and cannot be pointed at a half-built port
// (T-29 wires it). Here the same case numbers are asserted for the real port against rows seeded in the SQL fake. The real port answers `effectiveFrom` as an ISO-8601 UTC instant (§7.6a step 4 [CONV]).
// Kathmandu is UTC+05:45: local midnight of 2026-07-16 = 2026-07-15T18:15:00.000Z. The tenant timezone is the v1 default (Asia/Kathmandu): the port factory takes no identity dependency.
import { describe, expect, it } from 'vitest';
import { A, T, TENANT_B, VAT_ROW, call, codeOf, errOf, setup28b, ttype, type Env28b } from '../helpers/t28b.js';
import type { Row } from '../helpers/mastersDb.js';

const D = (s: string) => new Date(s);
const T0 = D('2026-01-01T00:00:00.000Z');
const NPT_0716 = '2026-07-15T18:15:00.000Z';                       // 2026-07-16 00:00 Asia/Kathmandu
const NPT_0717 = '2026-07-16T18:15:00.000Z';

/** SUITE_HST: 100 bp from 2026-04-01 (NPT midnight) to 2026-07-16 (NPT midnight), then 200 bp (open). Mirrors contract cases (27)(28). */
const HST_1 = ttype(1, A, 'SUITE_HST', { rate_bp: 100, effective_from: D('2026-03-31T18:15:00.000Z'), effective_to: D(NPT_0716) });
const HST_2 = ttype(2, A, 'SUITE_HST', { rate_bp: 200, effective_from: D(NPT_0716) });
const world = (rows: Row[] = [], more: Record<string, Row[]> = {}, o: { noVat?: boolean } = {}) => setup28b({ cs_tax_types: [HST_1, HST_2, ...rows], ...more }, o);

const taxRate = (env: Env28b, input: unknown, o: { tenantId?: string } = {}): Promise<any> => call(env, (p, ctx) => p['getTaxRate']!(ctx, input), o);
const rate = (env: Env28b, taxCode: string, on: string, o: { tenantId?: string } = {}) => taxRate(env, { taxCode, on }, o);
const missing = async (env: Env28b, input: unknown, o: { tenantId?: string } = {}) => expect(await codeOf(taxRate(env, input, o)), JSON.stringify(input)).toBe('catalog.tax_config_missing');

describe('CatalogPort real impl: getTaxRate shape (08 A2.2)', () => {
  it('exposes getTaxRate as a function', { timeout: T }, () => {
    expect(typeof setup28b().port['getTaxRate']).toBe('function');
  });
});

describe('contract (27) getTaxRate returns the rate effective on `on` — 02-TRD §7.6a steps 2, 4', () => {
  it('day before the successor starts -> 100 bp (effectiveFrom = its own start, kind other); on the successor\'s first local day -> 200 bp', { timeout: T }, async () => {
    const env = world();
    expect(await rate(env, 'SUITE_HST', '2026-07-15')).toEqual({ taxCode: 'SUITE_HST', ratePercentBasisPoints: 100, kind: 'other', effectiveFrom: '2026-03-31T18:15:00.000Z' });
    expect(await rate(env, 'SUITE_HST', '2026-07-16')).toEqual({ taxCode: 'SUITE_HST', ratePercentBasisPoints: 200, kind: 'other', effectiveFrom: NPT_0716 });
    expect((await rate(env, 'SUITE_HST', '2027-01-01')).ratePercentBasisPoints).toBe(200);          // open-ended window
  });
  it('the day is the TENANT-LOCAL day, not the UTC day: a version starting 2026-07-16T00:00Z (05:45 NPT) is NOT yet effective on 2026-07-16, effective on 2026-07-17', { timeout: T }, async () => {
    const env = setup28b({ cs_tax_types: [
      ttype(1, A, 'ZTZ', { rate_bp: 100, effective_from: T0, effective_to: D('2026-07-16T00:00:00.000Z') }),
      ttype(2, A, 'ZTZ', { rate_bp: 900, effective_from: D('2026-07-16T00:00:00.000Z') }),
    ] });
    expect((await rate(env, 'ZTZ', '2026-07-16')).ratePercentBasisPoints).toBe(100);
    expect((await rate(env, 'ZTZ', '2026-07-17')).ratePercentBasisPoints).toBe(900);
    expect((await rate(env, 'ZTZ', '2026-07-15')).ratePercentBasisPoints).toBe(100);
  });
  it('a version starting exactly at local midnight of `on` is effective that day (effective_from inclusive); one starting 1 ms later is not', { timeout: T }, async () => {
    const edge = setup28b({ cs_tax_types: [ttype(1, A, 'EDGE', { rate_bp: 300, effective_from: D(NPT_0716) })] });
    expect((await rate(edge, 'EDGE', '2026-07-16')).ratePercentBasisPoints).toBe(300);
    await missing(edge, { taxCode: 'EDGE', on: '2026-07-15' });
    const late = setup28b({ cs_tax_types: [ttype(1, A, 'LATE', { rate_bp: 300, effective_from: D('2026-07-15T18:15:00.001Z') })] });
    await missing(late, { taxCode: 'LATE', on: '2026-07-16' });
    expect((await rate(late, 'LATE', '2026-07-17')).ratePercentBasisPoints).toBe(300);
  });
  it('effective_to is exclusive: the last effective local day is the one before it ends; on the end day with no successor -> tax_config_missing', { timeout: T }, async () => {
    const env = setup28b({ cs_tax_types: [ttype(1, A, 'ENDS', { rate_bp: 400, effective_from: T0, effective_to: D(NPT_0717) })] });
    expect((await rate(env, 'ENDS', '2026-07-16')).ratePercentBasisPoints).toBe(400);
    await missing(env, { taxCode: 'ENDS', on: '2026-07-17' });
  });
  it('0 bp is a configured rate, not a missing one', { timeout: T }, async () => {
    expect(await rate(setup28b({ cs_tax_types: [ttype(1, A, 'ZERO', { rate_bp: 0 })] }), 'ZERO', '2026-07-16')).toMatchObject({ taxCode: 'ZERO', ratePercentBasisPoints: 0, kind: 'other' });
  });
  it('every version of the code is considered: a rate change is picked by date, not by insertion order', { timeout: T }, async () => {
    const env = setup28b({ cs_tax_types: [HST_2, HST_1] });                                          // seeded newest first
    expect((await rate(env, 'SUITE_HST', '2026-05-01')).ratePercentBasisPoints).toBe(100);
    expect((await rate(env, 'SUITE_HST', '2026-08-01')).ratePercentBasisPoints).toBe(200);
  });
});

describe('contract (28) getTaxRate unknown code, or no rate effective on `on` -> catalog.tax_config_missing — §7.6a steps 1, 4, 5', () => {
  it('unknown code; `on` before the first version (day before it starts)', { timeout: T }, async () => {
    const env = world();
    const err = await errOf(taxRate(env, { taxCode: 'SUITE_UNKNOWN', on: '2026-07-16' }));
    expect(err.code).toBe('catalog.tax_config_missing');
    expect(err.statusCode).toBe(422);
    await missing(env, { taxCode: 'SUITE_HST', on: '2026-03-31' });                                  // 2026-03-31 00:00 NPT < 2026-04-01 00:00 NPT
    expect((await rate(env, 'SUITE_HST', '2026-04-01')).ratePercentBasisPoints).toBe(100);
  });
  it('an inactive type, a NULL rate, and a scheduled (future-only) type are not usable', { timeout: T }, async () => {
    const env = world([
      ttype(3, A, 'OFF', { rate_bp: 100, is_active: false }),
      ttype(4, A, 'NORATE', { rate_bp: null }),
      ttype(5, A, 'FUTURE', { rate_bp: 100, effective_from: D('2027-01-01T00:00:00.000Z') }),
    ]);
    for (const taxCode of ['OFF', 'NORATE']) await missing(env, { taxCode, on: '2026-07-16' });
    await missing(env, { taxCode: 'FUTURE', on: '2026-07-16' });
    expect((await rate(env, 'FUTURE', '2027-01-02')).ratePercentBasisPoints).toBe(100);
  });
  it('an inactive successor does not hide an active predecessor window; an inactive version alone leaves a gap', { timeout: T }, async () => {
    const env = setup28b({ cs_tax_types: [
      ttype(1, A, 'GAP', { rate_bp: 100, effective_from: T0, effective_to: D(NPT_0716) }),
      ttype(2, A, 'GAP', { rate_bp: 999, effective_from: D(NPT_0716), is_active: false }),
    ] });
    expect((await rate(env, 'GAP', '2026-07-15')).ratePercentBasisPoints).toBe(100);
    await missing(env, { taxCode: 'GAP', on: '2026-07-16' });
  });
  it('malformed input maps to the same code (no rate can exist): taxCode not ^[A-Z0-9_]{1,16}$ and `on` not a YYYY-MM-DD date — never a TypeError, never validation_failed', { timeout: T }, async () => {
    const env = world();
    for (const taxCode of ['', 'suite_hst', 'SUITE-HST', 'SUITE HST', 'A'.repeat(17), 'SUITE_HST\n', "SUITE_HST'; DROP TABLE catalog.cs_tax_types; --", '%', 'SUITE_HST ', 'ŞUITE', 5 as never, null as never, undefined as never])
      await missing(env, { taxCode, on: '2026-07-16' });
    for (const on of ['', '2026-7-16', '16-07-2026', '2026/07/16', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00.000Z', ' 2026-07-16', '2026-07-16\n', '2026-13-01', '2026-02-30', '2026-00-10', 'yesterday', '20260716', 20260716 as never, null as never, undefined as never])
      await missing(env, { taxCode: 'SUITE_HST', on });
    for (const input of [undefined, null, 'SUITE_HST', 42, [], {}, { taxCode: 'SUITE_HST' }, { on: '2026-07-16' }]) await missing(env, input);
  });
  it('a valid-looking 16-char code is accepted by the format check (then simply not found); 1 char too', { timeout: T }, async () => {
    const env = world([ttype(3, A, 'A', { rate_bp: 5 }), ttype(4, A, 'ABCDEFGH12345678', { rate_bp: 6 })]);
    expect((await rate(env, 'A', '2026-07-16')).ratePercentBasisPoints).toBe(5);
    expect((await rate(env, 'ABCDEFGH12345678', '2026-07-16')).ratePercentBasisPoints).toBe(6);
    await missing(env, { taxCode: 'ABCDEFGH123456789', on: '2026-07-16' });
  });
  it('the exact code only: no prefix / case-insensitive / LIKE match', { timeout: T }, async () => {
    const env = world();
    for (const taxCode of ['SUITE_HS', 'SUITE_HSTT', 'SUITE_H', 'SUITE']) await missing(env, { taxCode, on: '2026-07-16' });
  });
  it('no leap-day surprise: 2028-02-29 is a date, 2027-02-29 is not', { timeout: T }, async () => {
    const env = setup28b({ cs_tax_types: [ttype(1, A, 'LEAP', { rate_bp: 77 })] });
    expect((await rate(env, 'LEAP', '2028-02-29')).ratePercentBasisPoints).toBe(77);
    await missing(env, { taxCode: 'LEAP', on: '2027-02-29' });
  });
});

describe('contract (29) getTaxRate global VAT code (no versioned history) -> kind vat, effectiveFrom null — §7.6a step 3', () => {
  it('VAT -> {taxCode, 1300 bp from g_tax_types, kind vat, effectiveFrom null} exactly', { timeout: T }, async () => {
    const r = await rate(world(), 'VAT', '2026-07-16');
    expect(r).toEqual({ taxCode: 'VAT', ratePercentBasisPoints: 1300, kind: 'vat', effectiveFrom: null });
    expect(Object.keys(r).sort()).toEqual(['effectiveFrom', 'kind', 'ratePercentBasisPoints', 'taxCode']);
    expect(r.effectiveFrom).toBeNull();                                                                // present and null, never undefined / created_at
  });
  it('the VAT rate has no history: any valid date answers the same, past and future', { timeout: T }, async () => {
    const env = world();
    for (const on of ['1990-01-01', '2026-01-01', '2026-07-16', '2099-12-31']) expect(await rate(env, 'VAT', on), on).toEqual({ taxCode: 'VAT', ratePercentBasisPoints: 1300, kind: 'vat', effectiveFrom: null });
  });
  it('the rate is the ROW\'s value, never a constant (08 R18): a 1100 bp row answers 1100; 0 bp answers 0', { timeout: T }, async () => {
    expect((await rate(setup28b({ g_tax_types: [{ ...VAT_ROW, rate_bp: 1100 }] }, { noVat: true }), 'VAT', '2026-07-16')).ratePercentBasisPoints).toBe(1100);
    expect((await rate(setup28b({ g_tax_types: [{ ...VAT_ROW, rate_bp: 0 }] }, { noVat: true }), 'VAT', '2026-07-16')).ratePercentBasisPoints).toBe(0);
  });
  it('VAT with no active g_tax_types row, or an inactive one, or rate_bp NULL -> tax_config_missing (never an assumed 13 %)', { timeout: T }, async () => {
    await missing(setup28b({}, { noVat: true }), { taxCode: 'VAT', on: '2026-07-16' });
    await missing(setup28b({ g_tax_types: [{ ...VAT_ROW, is_active: false }] }, { noVat: true }), { taxCode: 'VAT', on: '2026-07-16' });
    await missing(setup28b({ g_tax_types: [{ ...VAT_ROW, rate_bp: null }] }, { noVat: true }), { taxCode: 'VAT', on: '2026-07-16' });
  });
  it('VAT is matched exactly: "vat" / "VAT " / "VAT2" are not VAT (and not found)', { timeout: T }, async () => {
    const env = world();
    for (const taxCode of ['vat', 'VAT ', 'VAT2', 'Vat']) await missing(env, { taxCode, on: '2026-07-16' });
  });
  it('VAT still validates `on` (malformed date -> tax_config_missing)', { timeout: T }, async () => {
    for (const on of ['2026-7-16', '2026-02-30', 'today', '']) await missing(world(), { taxCode: 'VAT', on });
  });
});

describe('contract (30) getTaxRate result kind is never \'exempt\' — 08 A4.1', () => {
  it('kind is vat for VAT and other for every tenant code, over many dates; the key set is fixed', { timeout: T }, async () => {
    const env = world();
    for (const [taxCode, on, kind] of [['VAT', '2026-01-01', 'vat'], ['VAT', '2026-11-01', 'vat'], ['SUITE_HST', '2026-05-01', 'other'], ['SUITE_HST', '2026-11-01', 'other']] as const) {
      const r = await rate(env, taxCode, on);
      expect(['vat', 'other']).toContain(r.kind);
      expect(r.kind, `${taxCode} ${on}`).toBe(kind);
      expect(Object.keys(r).sort()).toEqual(['effectiveFrom', 'kind', 'ratePercentBasisPoints', 'taxCode']);
    }
  });
  it('a code literally named EXEMPT / a tenant rule with vat_treatment exempt never yields an exempt kind: exemption is a treatment, not a rate', { timeout: T }, async () => {
    const env = world([ttype(3, A, 'EXEMPT', { rate_bp: 0 })]);
    const r = await rate(env, 'EXEMPT', '2026-07-16');
    expect(r.kind).toBe('other');
    expect(r.ratePercentBasisPoints).toBe(0);
    expect(JSON.stringify(await rate(env, 'VAT', '2026-07-16'))).not.toMatch(/exempt/i);
  });
  it('optional-looking fields are never null except effectiveFrom of VAT; effectiveFrom of an "other" code is an ISO-8601 UTC string (with ms, Z)', { timeout: T }, async () => {
    const r = await rate(world(), 'SUITE_HST', '2026-08-01');
    expect(r.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Object.values(r).filter((v) => v === null || v === undefined)).toEqual([]);
    expect(Number.isInteger(r.ratePercentBasisPoints)).toBe(true);
  });
});

describe('getTaxRate — tenant isolation, read-only, binds only (07-SECURITY S-1, S-6; 08 R18)', () => {
  it('tenant comes from ctx only: B\'s own rate for the same code, B\'s private code invisible to A, an input `tenantId` is ignored', { timeout: T }, async () => {
    const env = world([ttype(7, TENANT_B, 'SUITE_HST', { rate_bp: 4242 }), ttype(8, TENANT_B, 'ONLY_B', { rate_bp: 777 })]);
    expect((await rate(env, 'SUITE_HST', '2026-08-01')).ratePercentBasisPoints).toBe(200);
    expect((await rate(env, 'SUITE_HST', '2026-08-01', { tenantId: TENANT_B })).ratePercentBasisPoints).toBe(4242);
    await missing(env, { taxCode: 'ONLY_B', on: '2026-08-01' });
    expect((await rate(env, 'ONLY_B', '2026-08-01', { tenantId: TENANT_B })).ratePercentBasisPoints).toBe(777);
    expect((await taxRate(env, { taxCode: 'SUITE_HST', on: '2026-08-01', tenantId: TENANT_B })).ratePercentBasisPoints).toBe(200);
  });
  it('a tenant that has no versions of a code gets tax_config_missing even though another tenant has it (and the global VAT row is the only global rate)', { timeout: T }, async () => {
    const env = setup28b({ cs_tax_types: [ttype(7, TENANT_B, 'ONLY_B', { rate_bp: 777 })] });
    await missing(env, { taxCode: 'ONLY_B', on: '2026-08-01' });
    expect((await rate(env, 'VAT', '2026-08-01', { tenantId: TENANT_B })).ratePercentBasisPoints).toBe(1300);
  });
  it('read-only (no write / no event), every cs_tax_types read binds the caller\'s tenant, no value is concatenated into SQL, and only C3 tables are read', { timeout: T }, async () => {
    const env = world();
    const hostile = "SUITE_HST'; DROP TABLE catalog.cs_tax_types; --";
    await rate(env, 'SUITE_HST', '2026-08-01');
    await rate(env, 'VAT', '2026-08-01');
    await codeOf(taxRate(env, { taxCode: hostile, on: '2026-08-01' }));
    expect(env.db.writes).toEqual([]);
    const stmts = env.db.stmts;
    const taxReads = stmts.filter((s) => /\bcs_tax_types\b/i.test(s.text));
    expect(taxReads.length).toBeGreaterThan(0);
    for (const s of taxReads) expect(s.values, s.text).toContain(A);
    for (const s of stmts) {
      expect(s.text, s.text).not.toMatch(/DROP|--|SUITE_HST|2026-08-01/i);
      for (const m of s.text.matchAll(/\b(?:FROM|JOIN)\s+([\w."]+)/gi)) expect(m[1], s.text).toMatch(/^catalog\./i);
    }
  });
  it('a valid call touches only tax-type data: no price-list, orderable or tax_rules table is read', { timeout: T }, async () => {
    const env = world();
    await rate(env, 'SUITE_HST', '2026-08-01');
    await rate(env, 'VAT', '2026-08-01');
    for (const s of env.db.stmts) expect(s.text, s.text).not.toMatch(/\b(price_list|orderables|tax_rules|surcharge_rules|doctors|credit_parties)/i);
  });
  it('deterministic and fresh: the same input gives deeply equal results; mutating one result never changes the next answer', { timeout: T }, async () => {
    const env = world();
    const a = await rate(env, 'SUITE_HST', '2026-08-01');
    const b = await rate(env, 'SUITE_HST', '2026-08-01');
    expect(b).toEqual(a);
    try { a.ratePercentBasisPoints = 1; a.kind = 'exempt'; } catch { /* frozen is fine too */ }
    expect(await rate(env, 'SUITE_HST', '2026-08-01')).toEqual(b);
    const v = await rate(env, 'VAT', '2026-08-01');
    try { v.effectiveFrom = '2026-01-01'; } catch { /* frozen is fine too */ }
    expect((await rate(env, 'VAT', '2026-08-01')).effectiveFrom).toBeNull();
  });
  it('concurrent calls on one port with different tenants / codes never cross answers', { timeout: T }, async () => {
    const env = world([ttype(7, TENANT_B, 'SUITE_HST', { rate_bp: 4242 })]);
    const calls = Array.from({ length: 40 }, (_, i) => (i % 2 ? rate(env, 'SUITE_HST', '2026-08-01', { tenantId: TENANT_B }) : rate(env, 'SUITE_HST', '2026-08-01')));
    expect((await Promise.all(calls)).map((r) => r.ratePercentBasisPoints)).toEqual(Array.from({ length: 40 }, (_, i) => (i % 2 ? 4242 : 200)));
  });
});
