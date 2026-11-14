// @vitest-environment jsdom
// RS-C4 — visual regression snapshots of the key screens (10-DESIGN-SYSTEM s7.4 "RS tasks record snapshots of their key screens"; LD-170).
// These are a REGRESSION BASELINE, not proof the look is right (design review does that). The WRITER records them once, LAST, after the other rs-c4 tests pass:
//   pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts --pool=threads -u rs-c4.screens
// into __snapshots__/rs-c4.screens.test.tsx.snap (LD-170 lets the writer/debugger keep that file). With CI=true a missing snapshot FAILS, which is the state today.
// Do not edit a test or the implementation just to make a snapshot match. DOM is serialised (not pixels): react-aria generated ids are normalised.
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MONEY, PATH, UNIT, of, renderForm, setup, wrap } from './fd-t13.harness';

setup();
const T = 4000;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const norm = (html: string) =>
  html
    .replace(/react-aria\d*-:?[\w-]+:?/g, 'aria-id')
    .replace(/:r[0-9a-z]+:/g, ':rN:')
    .replace(/(id|for|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-activedescendant)="[^"]*(?:aria-id|:rN:)[^"]*"/g, '$1="ID"')
    .replace(/></g, '>\n<');
const snap = (el: Element) => expect(norm(el.innerHTML)).toMatchSnapshot();

const party = { id: U(4), code: 'SYNCORP', name: 'Synthetic Corp', credit_limit_paisa: 5000000, credit_days: 30, is_locked: false, outstanding: npr(95000), version: 1 };
const statement = [
  { period_month: '2083-06', fiscal_year_bs: '2083/84', invoiced: npr(100000), paid: npr(30000), credited: npr(0), closing_balance: npr(70000) },
  { period_month: '2083-07', fiscal_year_bs: '2083/84', invoiced: npr(50000), paid: npr(20000), credited: npr(5000), closing_balance: npr(95000) },
];
const session = { id: U(71), opened_by: { membership_id: U(91), display_name: 'Synthetic Other' }, centre_id: U(3), status: 'open', opened_at: '2026-11-07T04:00:00.000Z', rows: [{ method_code: 'cash', expected: npr(10000) }], version: 1 };
const report = {
  business_date: '2026-11-07', business_date_bs: '2083-07-21',
  rows: [{ collected_by: { membership_id: U(90), display_name: 'Synthetic Cashier' }, method_code: 'cash', entries: 3, reversals: 1, gross: npr(339000), reversed: npr(11300), net: npr(327700) }],
  totals: { gross: npr(339000), reversed: npr(11300), net: npr(327700) }, sessions: [session],
};

describe('RS-C4 key-screen snapshots', () => {
  it('Register: blank', async () => {
    const v = await renderForm();
    snap(v.container);
  });

  it('Register: returning patient, one test, quote and summary filled', async () => {
    const user = userEvent.setup({ delay: null });
    const v = await renderForm();
    await user.keyboard('{F2}9841000001');
    await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T });
    await user.keyboard('{Enter}');
    await screen.findByText(/P-000123/, undefined, { timeout: T });
    await user.keyboard('{F4}CBC');
    await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.items).toHaveLength(1), { timeout: T });
    await screen.findAllByText(MONEY(UNIT), undefined, { timeout: T });
    snap(v.container);
  });

  it('Register: new-patient form open', async () => {
    const user = userEvent.setup({ delay: null });
    const v = await renderForm();
    await user.keyboard('{Alt>}n{/Alt}');
    await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    snap(v.container);
  });

  it('Daily cash (open shift)', async () => {
    const { DailyCashView } = (await import('@/features/billing/components/DailyCashView')) as { DailyCashView: any };
    const v = wrap(<DailyCashView report={report as never} session={session as never} permissions={['billing.cash_report.read', 'billing.data.export']} />);
    snap(v.container);
  });

  it('Credit party: statement tab', async () => {
    const { CreditPartyDetail } = (await import('@/features/billing/components/CreditPartyDetail')) as { CreditPartyDetail: any };
    const v = wrap(<CreditPartyDetail party={party as never} charges={[] as never} statement={statement as never} />);
    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: /statement/i }));
    snap(v.container);
  });
});
