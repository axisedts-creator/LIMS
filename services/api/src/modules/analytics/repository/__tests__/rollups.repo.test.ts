// C8 AN-T08 — repository/rollups.repo.ts (02-TRD §3.2 "SELECT from analytics.daily_* (scope param mandatory)", §6 intro + §6.1/§6.2;
// 07-SECURITY P1, REQ-SEC-013/017). Fake tx records (text, values) and replies like the database would for the scope parameters.
// SEAMS (writer may dispute): exports `incomeRows(tx, { tenantId, from, to, scope, groupBy })` and
//   `departmentIncomeRows(tx, { tenantId, from, to, scope, departmentIds?, grain })` (see handlers/__tests__/helpers.ts for row shapes);
//   the SQL returns the group key as column `key` (income) / `business_date`, `department_id` (department); bigint columns arrive as
//   strings from pg and come back as safe integers; params are positional per TRD §6.1: $1 tenant, $2 from, $3 to, $4 all, $5 centres.
import { describe, expect, it } from 'vitest';
import { departmentIncomeRows, incomeRows } from '../rollups.repo.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222221';
const C2 = '22222222-2222-4222-8222-222222222222';
const DEP = '33333333-3333-4333-8333-333333333333';
const ALL = { all: true, centreIds: [] as string[] };
const A1 = { all: false, centreIds: [C1, C2] };
const FROM = '2026-11-05', TO = '2026-11-07';

const INCOME_ROW = {
  key: '2026-11-05', invoices_issued: '5', invoices_cancelled: '1', gross_paisa: '15000', discount_paisa: '1000', exempt_paisa: '0', taxable_paisa: '14000',
  vat_paisa: '1820', other_tax_paisa: '0', invoiced_paisa: '15820', credit_notes_paisa: '3000', net_sales_paisa: '12820',
};

function fakeTx(rows: any[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      // the database answers nothing for an empty restricted scope ($4 false and $5 empty)
      if (values[3] === false && Array.isArray(values[4]) && values[4].length === 0) return { rows: [] };
      return { rows };
    },
  };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

describe('incomeRows — SQL shape (TRD §6.1)', () => {
  it('reads analytics.daily_income with tenant, [from, to) and the scope predicate, all as bound parameters in TRD order', async () => {
    const tx = fakeTx([INCOME_ROW]);
    await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: A1, groupBy: 'day' });
    expect(tx.calls).toHaveLength(1);
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toContain('from analytics.daily_income');
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('business_date >= $2');
    expect(sql).toContain('business_date < $3');
    expect(sql).toMatch(/\$4 or \(centre_id is not null and centre_id = any \(\$5\)\)/);
    expect(values.slice(0, 5)).toEqual([TENANT, FROM, TO, false, [C1, C2]]);
  });

  it('all-centre scope binds $4 = true and an empty $5', async () => {
    const tx = fakeTx();
    await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy: 'day' });
    expect(tx.calls[0]!.values.slice(0, 5)).toEqual([TENANT, FROM, TO, true, []]);
  });

  it('no value is interpolated into the statement text (tenant, dates, centre ids are parameters only)', async () => {
    const tx = fakeTx();
    await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: A1, groupBy: 'centre' });
    for (const v of [TENANT, FROM, TO, C1, C2]) expect(tx.calls[0]!.text).not.toContain(v);
  });

  it.each([
    ['day', /group by[^;]*business_date/, /date_trunc/],
    ['ad_month', /group by[^;]*date_trunc\('month', business_date\)/, null],
    ['branch', /group by[^;]*branch_id/, /date_trunc/],
    ['centre', /group by[^;]*centre_id/, /date_trunc/],
  ] as const)('groupBy %s groups by the TRD group key', async (groupBy, yes, no) => {
    const tx = fakeTx();
    await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy });
    const sql = norm(tx.calls[0]!.text);
    expect(sql).toMatch(yes);
    if (no) expect(sql).not.toMatch(no);
    expect(sql).toMatch(/order by/);
  });

  it('selects the money columns with sum(...) and nets credit notes (M12 = M10 − M11)', async () => {
    const tx = fakeTx();
    await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy: 'day' });
    const sql = norm(tx.calls[0]!.text);
    for (const c of ['invoices_issued', 'invoices_cancelled', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'credit_notes_paisa']) {
      expect(sql, c).toContain(`sum(${c})`);
    }
    expect(sql).toContain('sum(net_paisa)');
    expect(sql).toContain('as invoiced_paisa');
    expect(sql).toContain('as net_sales_paisa');
    expect(sql).not.toContain('select *');
  });
});

describe('incomeRows — result mapping and exactness', () => {
  it('pg bigint strings become safe integers; the key is kept as a string; negative net is preserved', async () => {
    const tx = fakeTx([{ ...INCOME_ROW, net_sales_paisa: '-740' }]);
    const rows = await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy: 'day' });
    expect(rows).toEqual([{
      key: '2026-11-05', invoices_issued: 5, invoices_cancelled: 1, gross_paisa: 15000, discount_paisa: 1000, exempt_paisa: 0, taxable_paisa: 14000,
      vat_paisa: 1820, other_tax_paisa: 0, invoiced_paisa: 15820, credit_notes_paisa: 3000, net_sales_paisa: -740,
    }]);
    for (const v of Object.values(rows[0]!)) expect(typeof v === 'number' || typeof v === 'string').toBe(true);
  });

  it('only the documented columns come back (an extra column in the row is not passed through)', async () => {
    const tx = fakeTx([{ ...INCOME_ROW, tenant_id: TENANT, secret: 'x' }]);
    const rows = await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy: 'day' });
    expect(Object.keys(rows[0]!).sort()).toEqual(Object.keys(INCOME_ROW).sort());
  });

  it('a bigint beyond 2^53 is refused (RangeError / Error), never silently rounded', async () => {
    const tx = fakeTx([{ ...INCOME_ROW, invoiced_paisa: '9007199254740993' }]);
    await expect(incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy: 'day' })).rejects.toThrow();
  });

  it('empty restricted scope returns [] (never the unscoped rows)', async () => {
    const tx = fakeTx([INCOME_ROW]);
    expect(await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: { all: false, centreIds: [] }, groupBy: 'day' })).toEqual([]);
  });

  it('database errors propagate unchanged', async () => {
    const boom = new Error('db down');
    const tx = { async query() { throw boom; } };
    await expect(incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy: 'day' })).rejects.toBe(boom);
  });
});

describe('incomeRows — guards (07 P1; injection)', () => {
  it('scope is mandatory: a call without it rejects and runs no query', async () => {
    const tx = fakeTx();
    await expect(incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, groupBy: 'day' } as any)).rejects.toThrow();
    expect(tx.calls).toEqual([]);
  });

  it('a malformed scope (all missing / non-boolean, centreIds not an array) rejects and runs no query', async () => {
    const tx = fakeTx();
    for (const scope of [{ centreIds: [C1] }, { all: 'true', centreIds: [] }, { all: false, centreIds: 'x' }, null, undefined]) {
      await expect(incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope, groupBy: 'day' } as any)).rejects.toThrow();
    }
    expect(tx.calls).toEqual([]);
  });

  it.each(['day; drop table analytics.daily_income', 'bs_month', 'DAY', '', 'centre_id, tenant_id', undefined])('groupBy %j is outside the allow-list → rejects, no query, nothing reaches SQL text', async (groupBy) => {
    const tx = fakeTx();
    await expect(incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, groupBy } as any)).rejects.toThrow();
    expect(tx.calls).toEqual([]);
  });

  it('a hostile centre id stays a bound value, never part of the text', async () => {
    const evil = `${C1}'); drop table analytics.daily_income; --`;
    const tx = fakeTx();
    await incomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: { all: false, centreIds: [evil] }, groupBy: 'day' }).catch(() => undefined);
    for (const c of tx.calls) expect(c.text).not.toContain('drop table');
  });
});

describe('departmentIncomeRows — SQL shape (TRD §6.2)', () => {
  const DROW = { business_date: null, department_id: DEP, line_count: '7', gross_paisa: '13910', discount_paisa: '1000', net_paisa: '9910' };

  it('reads analytics.daily_department_income with tenant, [from, to) and the scope predicate as bound parameters', async () => {
    const tx = fakeTx([DROW]);
    await departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: A1, grain: 'total' });
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toContain('from analytics.daily_department_income');
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('business_date >= $2');
    expect(sql).toContain('business_date < $3');
    expect(sql).toMatch(/\$4 or \(centre_id is not null and centre_id = any \(\$5\)\)/);
    expect(values.slice(0, 5)).toEqual([TENANT, FROM, TO, false, [C1, C2]]);
    for (const v of [TENANT, FROM, TO, C1]) expect(text).not.toContain(v);
  });

  it('grain total groups by department only; grain day groups by date and department', async () => {
    const total = fakeTx(); await departmentIncomeRows(total, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total' });
    const day = fakeTx(); await departmentIncomeRows(day, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'day' });
    const g = (t: string) => (norm(t).match(/group by ([^;]*?)(?: order by|$)/)?.[1] ?? '');
    expect(g(total.calls[0]!.text)).toContain('department_id');
    expect(g(total.calls[0]!.text)).not.toContain('business_date');
    expect(g(day.calls[0]!.text)).toContain('business_date');
    expect(g(day.calls[0]!.text)).toContain('department_id');
  });

  it('departmentIds → a bound department_id = ANY filter; absent or empty → no department predicate', async () => {
    const withIds = fakeTx(); await departmentIncomeRows(withIds, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total', departmentIds: [DEP] });
    expect(norm(withIds.calls[0]!.text)).toMatch(/department_id = any \(\$\d+\)/);
    expect(withIds.calls[0]!.values).toContainEqual([DEP]);
    expect(withIds.calls[0]!.text).not.toContain(DEP);
    const none = fakeTx(); await departmentIncomeRows(none, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total' });
    expect(norm(none.calls[0]!.text)).not.toMatch(/department_id = any/);
  });

  it('selects sum() of line_count, gross_paisa, discount_paisa, net_paisa with no select *', async () => {
    const tx = fakeTx(); await departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'day' });
    const sql = norm(tx.calls[0]!.text);
    for (const c of ['line_count', 'gross_paisa', 'discount_paisa', 'net_paisa']) expect(sql, c).toContain(`sum(${c})`);
    expect(sql).not.toContain('select *');
  });
});

describe('departmentIncomeRows — mapping, guards', () => {
  it('bigint strings → safe integers; NULL department_id stays null (package line); signed net kept', async () => {
    const tx = fakeTx([
      { business_date: null, department_id: null, line_count: '1', gross_paisa: '500', discount_paisa: '30', net_paisa: '470' },
      { business_date: null, department_id: DEP, line_count: '1', gross_paisa: '2260', discount_paisa: '0', net_paisa: '-740' },
    ]);
    const rows = await departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total' });
    expect(rows).toEqual([
      { business_date: null, department_id: null, line_count: 1, gross_paisa: 500, discount_paisa: 30, net_paisa: 470 },
      { business_date: null, department_id: DEP, line_count: 1, gross_paisa: 2260, discount_paisa: 0, net_paisa: -740 },
    ]);
  });

  it('bigint beyond 2^53 is refused', async () => {
    const tx = fakeTx([{ business_date: null, department_id: DEP, line_count: '1', gross_paisa: '1', discount_paisa: '0', net_paisa: '9007199254740993' }]);
    await expect(departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total' })).rejects.toThrow();
  });

  it('scope mandatory and well-formed; grain allow-listed; empty restricted scope → []', async () => {
    const tx = fakeTx([{ business_date: null, department_id: DEP, line_count: '1', gross_paisa: '1', discount_paisa: '0', net_paisa: '1' }]);
    await expect(departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, grain: 'total' } as any)).rejects.toThrow();
    await expect(departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total; drop' } as any)).rejects.toThrow();
    expect(tx.calls).toEqual([]);
    expect(await departmentIncomeRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope: { all: false, centreIds: [] }, grain: 'total' })).toEqual([]);
  });

  it('database errors propagate unchanged', async () => {
    const boom = new Error('db down');
    await expect(departmentIncomeRows({ async query() { throw boom; } }, { tenantId: TENANT, from: FROM, to: TO, scope: ALL, grain: 'total' })).rejects.toBe(boom);
  });
});
