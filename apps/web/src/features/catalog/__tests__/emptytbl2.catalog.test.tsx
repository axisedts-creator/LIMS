// @vitest-environment jsdom
// T0D-EMPTYTBL-2 — catalog SurchargeRulesScreen and TaxScreen (rules tab and tax types tab) draw their column headers with no data (LD-310, LD-336).
// Contract = emptytbl2.helpers.ts. "New rule" / "New tax type" stay in the page and are repeated in the message row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectCreateTwice, expectEmptyTable, expectNoCardOutsideTables, placeholders, tableOf, headersOf } from './emptytbl2.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/features/catalog/server/catalogActions', async () => (await import('./emptytbl2.helpers')).stubModuleFactory());
vi.mock('@/features/catalog/server/pricingActions', async () => (await import('./emptytbl2.helpers')).stubModuleFactory());

import { SurchargeRulesScreen } from '@/features/catalog/components/SurchargeRulesScreen';
import { TaxScreen } from '@/features/catalog/components/TaxScreen';
import { PERM_MANAGE } from '@/features/catalog/components/pricing-ui';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const MANAGE = [PERM_MANAGE];

describe('catalog SurchargeRulesScreen (empty)', () => {
  const props = { rules: [], departments: [], orderables: [], priceLists: [] } as const;
  it('manager: 6 column headers + message + 4 placeholder rows; "New rule" in the page header and in the message row', () => {
    const { container } = wrap(<SurchargeRulesScreen {...props} permissions={MANAGE} />);
    const t = tableOf(container);
    expectEmptyTable(t, /No urgent surcharge rules\. Urgent tests are charged at the normal price\./, ['Applies to', 'Price list', 'Amount', 'Effective from', 'Effective to', 'Status']);
    expectCreateTwice(container, t, /^new rule$/i);
    expectNoCardOutsideTables(container);
  });
  it('read-only user: same headers (no Actions column), message and placeholders, no "New rule" anywhere', () => {
    const { container } = wrap(<SurchargeRulesScreen {...props} permissions={[]} />);
    const t = tableOf(container);
    expectEmptyTable(t, /No urgent surcharge rules/, ['Applies to', 'Status']);
    expect(headersOf(t)).not.toContain('Actions');
    expect(within(container).queryAllByRole('button', { name: /new rule/i })).toHaveLength(0);
  });
  it('the help sentence and the heading stay', () => {
    wrap(<SurchargeRulesScreen {...props} permissions={MANAGE} />);
    expect(screen.getByRole('heading', { name: /urgent surcharge rules/i })).toBeTruthy();
    expect(screen.getByText(/Applies only when the order item is marked Urgent/)).toBeTruthy();
  });
  it('with a rule: no message, no placeholder rows', () => {
    const rule = { id: 'r1', scope: 'all', amount_kind: 'percent', percent_bp: 2500, effective_from: '2026-01-01T00:00:00.000Z', version: 1 };
    const { container } = wrap(<SurchargeRulesScreen {...props} rules={[rule as never]} permissions={MANAGE} />);
    expect(placeholders(tableOf(container))).toHaveLength(0);
    expect(container.textContent).not.toMatch(/No urgent surcharge rules/);
  });
});

describe('catalog TaxScreen (empty)', () => {
  const props = { rules: [], taxTypes: [], departments: [], orderables: [] } as const;
  it('rules tab: 6 column headers + message + 4 placeholder rows; "New rule" in the page and in the message row', () => {
    const { container } = wrap(<TaxScreen {...props} permissions={MANAGE} />);
    const t = tableOf(container);
    expectEmptyTable(t, /No tax rules\. Prices cannot be quoted until a tenant default rule exists\./, ['Applies to', 'VAT', 'Other tax', 'HS code', 'Effective from', 'Effective to']);
    expectCreateTwice(container, t, /^new rule$/i);
    expectNoCardOutsideTables(container);
  });
  it('rules tab: the disclaimer banner and the "no default rule" alert stay (D-C3-04: nothing about tax is assumed)', () => {
    wrap(<TaxScreen {...props} permissions={MANAGE} />);
    expect(screen.getByText(/Configure what your auditor confirms/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Prices cannot be quoted until a lab default tax rule exists/);
  });
  it('rules tab, read-only: headers, message and placeholders, no "New rule"', () => {
    const { container } = wrap(<TaxScreen {...props} permissions={[]} />);
    const t = tableOf(container);
    expectEmptyTable(t, /No tax rules/, ['Applies to', 'VAT']);
    expect(headersOf(t)).not.toContain('Actions');
    expect(within(container).queryAllByRole('button', { name: /new rule/i })).toHaveLength(0);
  });
  it('tax types tab: 6 column headers + a message row + 4 placeholder rows; "New tax type" in the page and in the message row', async () => {
    const { container } = wrap(<TaxScreen {...props} permissions={MANAGE} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /tax types/i }));
    const t = tableOf(container);
    expectEmptyTable(t, null, ['Code', 'Name', 'Rate', 'Effective from', 'Effective to', 'Scope']);
    expectCreateTwice(container, t, /^new tax type$/i);
    expectNoCardOutsideTables(container);
  });
  it('tax types tab with a type: the row shows and there are no placeholder rows', async () => {
    const type = { id: 'tt1', code: 'VAT', display: 'Value added tax', rate_bp: 1300, effective_from: '2026-01-01T00:00:00.000Z', scope: 'global', is_active: true, version: 1 };
    const { container } = wrap(<TaxScreen {...props} taxTypes={[type as never]} permissions={MANAGE} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /tax types/i }));
    const t = tableOf(container);
    expect(placeholders(t)).toHaveLength(0);
    expect(t.textContent).toMatch(/Value added tax/);
  });
});
