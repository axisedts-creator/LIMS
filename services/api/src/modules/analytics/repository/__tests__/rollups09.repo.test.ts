// C8 AN-T09 — new reads in repository/rollups.repo.ts and labels.repo.ts (02-TRD §6.3 collections, §6.4 volume/centres/referrers; 07-SECURITY P1,
// REQ-SEC-013/017, D-44 "top referrers reads daily_referrer_volume only"). Fake tx records (text, values) as in rollups.repo.test.ts (AN-T08).
// SEAMS (writer may dispute): export names + argument/row shapes are those documented in handlers/__tests__/t09.helpers.ts; positional params as AN-T08:
//   $1 tenant, $2 from, $3 to, $4 all, $5 centres, optional filters after. paymentMethodCodes/specimenTypeCodes take (tx,{tenantId,scope}) -> $1,$2,$3.
import { describe, expect, it } from 'vitest';
import { collectionRows, paymentMethodCodes, referrerVolumeRows, specimenTypeCodes, topCentresRows, volumeRows } from '../rollups.repo.js';
import { searchReferrers } from '../labels.repo.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222221';
const ALL = { all: true, centreIds: [] as string[] };
const R1 = { all: false, centreIds: [C1] };
const FROM = '2026-11-05', TO = '2026-11-07';
const base = { tenantId: TENANT, from: FROM, to: TO };

function fakeTx(rows: any[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (values[3] === false && Array.isArray(values[4]) && values[4].length === 0) return { rows: [] };
      return { rows };
    },
  };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const SCOPE = /\$4 or \(centre_id is not null and centre_id = any \(\$5\)\)/;
const big = (n: string) => n; // pg returns bigint as string

describe.each([
  ['volumeRows', (tx: any, scope: any) => volumeRows(tx, { ...base, scope, groupBy: 'day' }), 'analytics.daily_orders'],
  ['topCentresRows', (tx: any, scope: any) => topCentresRows(tx, { ...base, scope }), 'analytics.daily_centre_volume'],
  ['referrerVolumeRows', (tx: any, scope: any) => referrerVolumeRows(tx, { ...base, scope }), 'analytics.daily_referrer_volume'],
  ['collectionRows', (tx: any, scope: any) => collectionRows(tx, { ...base, scope, groupBy: 'method' }), 'analytics.daily_collections'],
] as const)('%s — shared guarantees (TRD §6 intro, P1)', (_name, run, table) => {
  it(`reads ${table} with tenant, [from, to) and the scope predicate as bound parameters in TRD order`, async () => {
    const tx = fakeTx();
    await run(tx, R1);
    expect(tx.calls).toHaveLength(1);
    const sql = norm(tx.calls[0]!.text);
    expect(sql).toContain(`from ${table}`);
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('business_date >= $2');
    expect(sql).toContain('business_date < $3');
    expect(sql).toMatch(SCOPE);
    expect(tx.calls[0]!.values.slice(0, 5)).toEqual([TENANT, FROM, TO, false, [C1]]);
  });

  it('all-centre scope binds $4 = true with an empty $5; nothing from the input is interpolated into the text', async () => {
    const tx = fakeTx();
    await run(tx, ALL);
    expect(tx.calls[0]!.values.slice(0, 5)).toEqual([TENANT, FROM, TO, true, []]);
    for (const v of [TENANT, FROM, TO, C1]) expect(tx.calls[0]!.text).not.toContain(v);
  });

  it('a missing or malformed scope is refused (scope is mandatory); an empty restricted scope answers [] without widening', async () => {
    await expect(run(fakeTx(), undefined)).rejects.toThrow(/scope/i);
    await expect(run(fakeTx(), { all: 'yes', centreIds: 'x' })).rejects.toThrow(/scope/i);
    expect(await run(fakeTx([{}]), { all: false, centreIds: [] })).toEqual([]);
  });
});

describe('volumeRows', () => {
  const ROW = { key: '2026-11-05', orders_registered: big('15'), orders_cancelled: '1', patient_visits: '13', new_patients: '3', urgent_orders: '3', opd_orders: '10', ipd_orders: '3', tests_ordered: '36' };

  it('adds tests_ordered from daily_centre_volume by the same key (a join/aggregate on order_items), keeps the TRD key per groupBy', async () => {
    for (const [groupBy, key] of [['day', /business_date/], ['ad_month', /date_trunc\('month', business_date\)/], ['branch', /branch_id/], ['centre', /centre_id/]] as const) {
      const tx = fakeTx();
      await volumeRows(tx, { ...base, scope: ALL, groupBy });
      const sql = norm(tx.calls[0]!.text);
      expect(sql, groupBy).toContain('analytics.daily_centre_volume');
      expect(sql, groupBy).toContain('order_items');
      expect(sql, groupBy).toMatch(new RegExp(`group by[^;]*${key.source}`));
    }
  });

  it('bigint strings come back as safe integers; > 2^53 is refused, never rounded', async () => {
    const out = await volumeRows(fakeTx([ROW]), { ...base, scope: ALL, groupBy: 'day' });
    expect(out[0]).toMatchObject({ key: '2026-11-05', orders_registered: 15, tests_ordered: 36 });
    await expect(volumeRows(fakeTx([{ ...ROW, orders_registered: '9007199254740993' }]), { ...base, scope: ALL, groupBy: 'day' })).rejects.toThrow(/safe integer/);
  });

  it.each(['bs_month', 'week', '', 'day; drop table x', 'constructor', '__proto__'])('groupBy %j is outside the allow-list → throws, no query', async (groupBy) => {
    const tx = fakeTx();
    await expect(volumeRows(tx, { ...base, scope: ALL, groupBy: groupBy as any })).rejects.toThrow(/allow-list|groupBy/);
    expect(tx.calls).toEqual([]);
  });
});

describe('topCentresRows', () => {
  it('joins net sales from daily_income by centre and pivots collection_mode; groups by centre', async () => {
    const tx = fakeTx();
    await topCentresRows(tx, { ...base, scope: ALL });
    const sql = norm(tx.calls[0]!.text);
    expect(sql).toContain('analytics.daily_income');
    expect(sql).toContain('collection_mode');
    expect(sql).toMatch(/group by[^;]*centre_id/);
    for (const m of ['walk_in', 'home', 'centre', 'partner']) expect(sql).toContain(`'${m}'`);
    expect(sql).not.toMatch(/net_billed|daily_referrer_billing/);
  });

  it('income side carries the same tenant/period/scope parameters (no unscoped subquery): scope predicate appears for each table read', async () => {
    const tx = fakeTx();
    await topCentresRows(tx, { ...base, scope: R1 });
    const sql = norm(tx.calls[0]!.text);
    expect((sql.match(/tenant_id = \$1/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/business_date >= \$2/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/centre_id = any \(\$5\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('coerces bigint strings and the mode pivot into numbers', async () => {
    const out = await topCentresRows(fakeTx([{ centre_id: C1, branch_id: C1, orders: '14', patient_visits: '11', tests_ordered: '34', net_sales_paisa: '-5', orders_walk_in: '11', orders_home: '3', orders_centre: '0', orders_partner: '0' }]), { ...base, scope: ALL });
    expect(out[0]).toMatchObject({ orders: 14, net_sales_paisa: -5, orders_walk_in: 11, orders_home: 3 });
  });
});

describe('referrerVolumeRows — volume only (D-44, P13)', () => {
  it('selects orders, patients_distinct, order_items grouped by referrer_id; never touches billing, never a money column', async () => {
    const tx = fakeTx();
    await referrerVolumeRows(tx, { ...base, scope: ALL });
    const sql = norm(tx.calls[0]!.text);
    expect(sql).toMatch(/group by[^;]*referrer_id/);
    expect(sql).not.toMatch(/billing|billed|paisa|daily_referrer_billing|daily_income|commission/);
  });

  it('NULL referrer comes back as null (the service labels it SELF); counts are safe integers', async () => {
    const out = await referrerVolumeRows(fakeTx([{ referrer_id: null, orders: '2', patient_visits: '2', tests_ordered: '2' }, { referrer_id: C1, orders: '5', patient_visits: '5', tests_ordered: '10' }]), { ...base, scope: ALL });
    expect(out).toEqual([{ referrer_id: null, orders: 2, patient_visits: 2, tests_ordered: 2 }, { referrer_id: C1, orders: 5, patient_visits: 5, tests_ordered: 10 }]);
  });
});

describe('collectionRows (TRD §6.3)', () => {
  it.each([
    ['method', /group by[^;]*payment_method_code/], ['staff', /group by[^;]*collected_by_membership_id/], ['centre', /group by[^;]*centre_id/],
    ['day', /group by[^;]*business_date/], ['ad_month', /group by[^;]*date_trunc\('month', business_date\)/],
  ] as const)('groupBy %s groups by the TRD key and selects the five measures', async (groupBy, re) => {
    const tx = fakeTx();
    await collectionRows(tx, { ...base, scope: ALL, groupBy });
    const sql = norm(tx.calls[0]!.text);
    expect(sql).toMatch(re);
    for (const c of ['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa']) expect(sql).toContain(c);
  });

  it('staff_method groups by both dimensions', async () => {
    const tx = fakeTx();
    await collectionRows(tx, { ...base, scope: ALL, groupBy: 'staff_method' });
    const sql = norm(tx.calls[0]!.text);
    expect(sql).toMatch(/group by[^;]*collected_by_membership_id[^;]*payment_method_code|group by[^;]*payment_method_code[^;]*collected_by_membership_id/);
  });

  it('payment_method_code filter is one bound array (= any($6)); the code strings never reach the text', async () => {
    const tx = fakeTx();
    await collectionRows(tx, { ...base, scope: ALL, groupBy: 'method', paymentMethodCodes: ['cash', "x'; drop table t;--"] });
    expect(norm(tx.calls[0]!.text)).toMatch(/payment_method_code = any \(\$6\)/);
    expect(tx.calls[0]!.values[5]).toEqual(['cash', "x'; drop table t;--"]);
    expect(tx.calls[0]!.text).not.toMatch(/drop table|cash/i);
  });

  it('no filter → no $6; NULL staff (gateway) and NULL centre rows survive as null, signed net is kept', async () => {
    const tx = fakeTx([{ method_code: 'esewa', staff_id: null, centre_id: null, entries: '1', reversals: '0', gross_collected_paisa: '300', reversed_paisa: '0', net_collected_paisa: '-300' }]);
    const out = await collectionRows(tx, { ...base, scope: ALL, groupBy: 'staff_method' });
    expect(tx.calls[0]!.values).toHaveLength(5);
    expect(out[0]).toMatchObject({ staff_id: null, entries: 1, net_collected_paisa: -300 });
  });

  it.each(['bs_month', 'week', 'x', 'constructor'])('groupBy %j outside the allow-list → throws, no query', async (groupBy) => {
    const tx = fakeTx();
    await expect(collectionRows(tx, { ...base, scope: ALL, groupBy: groupBy as any })).rejects.toThrow(/allow-list|groupBy/);
    expect(tx.calls).toEqual([]);
  });
});

describe('paymentMethodCodes / specimenTypeCodes — filter-option sources', () => {
  it('distinct codes from daily_collections / daily_specimens, tenant + scope bound; no period needed', async () => {
    const a = fakeTx([{ code: 'cash' }, { code: 'esewa' }]);
    const codes = await paymentMethodCodes(a, { tenantId: TENANT, scope: R1 });
    expect(norm(a.calls[0]!.text)).toMatch(/select distinct[^;]*payment_method_code[^;]*from analytics\.daily_collections/);
    expect(a.calls[0]!.values.slice(0, 3)).toEqual([TENANT, false, [C1]]);
    expect(Array.isArray(codes) && codes.every((c) => typeof c === 'string')).toBe(true);
    const b = fakeTx([{ code: 'serum' }]);
    await specimenTypeCodes(b, { tenantId: TENANT, scope: ALL });
    expect(norm(b.calls[0]!.text)).toMatch(/from analytics\.daily_specimens/);
    expect(b.calls[0]!.values.slice(0, 3)).toEqual([TENANT, true, []]);
    expect(norm(b.calls[0]!.text)).toMatch(/tenant_id = \$1/);
    expect(norm(b.calls[0]!.text)).toMatch(/\$2 or \(centre_id is not null and centre_id = any \(\$3\)\)/);
  });

  it('empty restricted scope → [] without a widening query', async () => {
    const a = fakeTx([{ code: 'cash' }]);
    expect(await paymentMethodCodes(a, { tenantId: TENANT, scope: { all: false, centreIds: [] } })).toEqual([]);
    expect(await specimenTypeCodes(a, { tenantId: TENANT, scope: { all: false, centreIds: [] } })).toEqual([]);
  });
});

describe('labels.repo searchReferrers (#17, REQ-SEC-098)', () => {
  const ROW = { referrer_id: C1, display_name: 'Dr. Test Alpha', is_active: true, canonical_referrer_id: null };

  it('one bound SELECT on catalog.v_pub_referrer_directory: tenant $1, term as a bound LIKE pattern, limit bound; explicit column list', async () => {
    const tx = fakeTx([ROW]);
    await searchReferrers(tx, { tenantId: TENANT, query: 'alpha', limit: 20 });
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toContain('from catalog.v_pub_referrer_directory');
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toMatch(/(i?like|~\*) \$2/);
    expect(sql).not.toContain('select *');
    expect(values[0]).toBe(TENANT);
    expect(String(values[1]).toLowerCase()).toContain('alpha');
    expect(text).not.toContain('alpha');
    expect(sql).toMatch(/limit (\$3|20)\b/);
  });

  it.each([['100%', '100\\%'], ['a_b', 'a\\_b'], ['back\\slash', 'back\\\\slash']])('LIKE wildcards in %j are taken literally (escaped → contains %j)', async (term, escaped) => {
    const tx = fakeTx([]);
    await searchReferrers(tx, { tenantId: TENANT, query: term, limit: 20 });
    expect(String(tx.calls[0]!.values[1])).toContain(escaped);
    expect(norm(tx.calls[0]!.text)).toContain('escape');
  });

  it('an injection string stays a value', async () => {
    const tx = fakeTx([]);
    await searchReferrers(tx, { tenantId: TENANT, query: "x' or '1'='1", limit: 20 });
    expect(tx.calls[0]!.text).not.toContain("1'='1");
  });
});
