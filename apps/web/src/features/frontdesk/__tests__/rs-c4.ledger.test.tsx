// @vitest-environment jsdom
// RS-C4 — Accounts screens (10-DESIGN-SYSTEM s4 "Accounts": ledger table with opening/closing balance columns; s8 axe). Behaviour unchanged, no new data.
//  Credit-party Statement: columns Month, Fiscal year, Opening, Invoiced, Paid, Credited, Closing (Closing last). Opening is DERIVED from data the API already
//  returns (closing_balance - invoiced + paid + credited, which equals the previous month's closing); nothing is invented.
//  Daily cash: the API returns no opening balance, only expected/counted cash per session. The writer must not invent one: if the Accounts rule cannot be met
//  from existing data, raise .orchestra/cr/RS-C4.md (CR template) and keep the existing columns. This file therefore only pins that nothing is lost there.
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { setup, wrap } from './fd-t13.harness';

setup(); // cleanup + MSW lifecycle + next/navigation mock from the shared harness

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const party = { id: U(4), code: 'SYNCORP', name: 'Synthetic Corp', credit_limit_paisa: 5000000, credit_days: 30, is_locked: false, outstanding: npr(95000), version: 1 };
// month 1: 0 + 100000 - 30000 - 0 = 70000 ; month 2: 70000 + 50000 - 20000 - 5000 = 95000
const statement = [
  { period_month: '2083-06', fiscal_year_bs: '2083/84', invoiced: npr(100000), paid: npr(30000), credited: npr(0), closing_balance: npr(70000) },
  { period_month: '2083-07', fiscal_year_bs: '2083/84', invoiced: npr(50000), paid: npr(20000), credited: npr(5000), closing_balance: npr(95000) },
];
const charges = [{ id: U(9), invoice_id: U(1), status: 'billed', amount: npr(113000), created_at: '2026-11-07T04:00:00.000Z' }];
const cash = (expected: number, counted?: number) => ({ method_code: 'cash', expected: npr(expected), ...(counted !== undefined ? { counted: npr(counted), variance: npr(counted - expected) } : {}) });
const report = {
  business_date: '2026-11-07', business_date_bs: '2083-07-21',
  rows: [{ collected_by: { membership_id: U(90), display_name: 'Synthetic Cashier' }, method_code: 'cash', entries: 3, reversals: 1, gross: npr(339000), reversed: npr(11300), net: npr(327700) }],
  totals: { gross: npr(339000), reversed: npr(11300), net: npr(327700) },
  sessions: [
    { id: U(70), opened_by: { membership_id: U(90), display_name: 'Synthetic Cashier' }, centre_id: U(3), status: 'closed', opened_at: '2026-11-07T03:00:00.000Z', closed_at: '2026-11-07T11:00:00.000Z', rows: [cash(327700, 327000)], version: 2 },
    { id: U(71), opened_by: { membership_id: U(91), display_name: 'Synthetic Other' }, centre_id: U(3), status: 'open', opened_at: '2026-11-07T04:00:00.000Z', rows: [cash(10000)], version: 1 },
  ],
};

const seriousOrCritical = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
// the kit DataTable is a react-aria grid today (role=grid / gridcell); a plain table (role=table / cell) is accepted too
const tableNamed = (n: RegExp) => {
  const t = [...screen.queryAllByRole('grid'), ...screen.queryAllByRole('table')].find((e) => n.test(e.getAttribute('aria-label') ?? e.querySelector('caption')?.textContent ?? ''));
  if (!t) throw new Error(`no table/grid named ${n}`);
  return t;
};
const cellsOf = (row: Element) => [...row.querySelectorAll('[role="cell"],[role="gridcell"],[role="rowheader"],td,th')] as HTMLElement[];
const rowsOf = (t: HTMLElement) => within(t).getAllByRole('row').slice(1);
const load = async <T,>(p: string) => (await import(/* @vite-ignore */ `@/features/billing/components/${p}`)) as T;
const openStatement = async () => {
  const { CreditPartyDetail } = await load<{ CreditPartyDetail: any }>('CreditPartyDetail');
  wrap(<CreditPartyDetail party={party as never} charges={charges as never} statement={statement as never} />);
  await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: /statement/i }));
  return tableNamed(/statement/i);
};

describe('s4 Accounts: credit-party statement is a ledger with Opening and Closing columns', () => {
  it('headers in order: Month, Fiscal year, Opening, Invoiced, Paid, Credited, Closing (Closing last)', async () => {
    const t = await openStatement();
    const heads = within(t).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(heads).toEqual(['Month', 'Fiscal year', 'Opening', 'Invoiced', 'Paid', 'Credited', 'Closing']);
  });

  it('each row: opening = previous closing (first month derived from its own movements), closing as served; money right-aligned text', async () => {
    const t = await openStatement();
    const rows = rowsOf(t);
    expect(rows).toHaveLength(2);
    const text = rows.map((r) => (r.textContent ?? '').replace(/\s+/g, ' '));
    expect(text[0]).toMatch(/2083-06/);
    expect(text[0]).toMatch(/NPR\s*0\.00.*NPR\s*1,000\.00.*NPR\s*300\.00.*NPR\s*0\.00.*NPR\s*700\.00/);
    expect(text[1]).toMatch(/2083-07/);
    expect(text[1]).toMatch(/NPR\s*700\.00.*NPR\s*500\.00.*NPR\s*200\.00.*NPR\s*50\.00.*NPR\s*950\.00/);
    for (const r of rows) expect(cellsOf(r).length).toBeGreaterThanOrEqual(7);
  });

  it('Terms and Charges tabs are unchanged (Outstanding, Credit limit, Open invoice link)', async () => {
    const { CreditPartyDetail } = await load<{ CreditPartyDetail: any }>('CreditPartyDetail');
    wrap(<CreditPartyDetail party={party as never} charges={charges as never} statement={statement as never} />);
    for (const t of ['Code', 'Credit limit', 'Outstanding', 'Credit days', 'Lock']) expect(screen.getByText(t)).toBeTruthy();
    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: /charges/i }));
    expect(screen.getByRole('link', { name: /open invoice/i }).getAttribute('href')).toBe(`/billing/invoices/${U(1)}`);
  });

  it('axe: zero serious/critical on Terms and on Statement', async () => {
    const { CreditPartyDetail } = await load<{ CreditPartyDetail: any }>('CreditPartyDetail');
    const v = wrap(<CreditPartyDetail party={party as never} charges={charges as never} statement={statement as never} />);
    await seriousOrCritical();
    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: /statement/i }));
    await seriousOrCritical();
    v.unmount();
  });
});

describe('s4 Accounts: daily cash keeps every column it has today (no data dropped, none invented)', () => {
  const view = async (session: unknown = report.sessions[1]) => {
    const { DailyCashView } = await load<{ DailyCashView: any }>('DailyCashView');
    return wrap(<DailyCashView report={report as never} session={session as never} permissions={['billing.cash_report.read', 'billing.data.export']} />);
  };

  it('collections table: Staff, Method, Entries, Reversals, Gross, Reversed, Net + a Total row; sessions table: Expected cash, Counted cash, Variance as text', async () => {
    await view();
    const col = tableNamed(/collections by staff and method/i);
    expect(within(col).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(['Staff', 'Method', 'Entries', 'Reversals', 'Gross', 'Reversed', 'Net']));
    expect(within(col).getByText('Total')).toBeTruthy();
    expect(col.textContent).toMatch(/NPR\s*3,277\.00/);
    const ses = tableNamed(/cash sessions/i);
    expect(within(ses).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(['Staff', 'Opened', 'Closed', 'Expected cash', 'Counted cash', 'Variance']));
    expect(ses.textContent).toMatch(/Short NPR\s*7\.00/); // variance is words, never colour alone
    expect(within(ses).getByText('Open')).toBeTruthy();
  });

  it('opening/closing are never shown with an invented value: a column headed Opening or Closing may exist only if its cells are real money or an em dash', async () => {
    await view();
    const ses = tableNamed(/cash sessions/i);
    const heads = within(ses).getAllByRole('columnheader').map((h) => h.textContent?.trim() ?? '');
    const idx = heads.findIndex((h) => /^(opening|closing)/i.test(h));
    if (idx === -1) return; // allowed: CR path (no opening balance in the API)
    for (const r of rowsOf(ses)) expect((cellsOf(r)[idx]!.textContent ?? '').trim()).toMatch(/^(—|NPR\s*[\d,]+\.\d\d)$/);
  });

  it('shift panel and actions unchanged: "Close shift" is the one primary button; export is a secondary', async () => {
    await view();
    expect(screen.getByRole('region', { name: /my shift/i })).toBeTruthy();
    const primaries = [...document.querySelectorAll('button.lims-btn-primary')].map((b) => b.textContent?.trim());
    expect(primaries).toEqual(['Close shift']);
  });

  it('axe: zero serious/critical (with an open shift, and without)', async () => {
    const v = await view();
    await seriousOrCritical();
    v.unmount();
    await view(null);
    await seriousOrCritical();
  });
});
