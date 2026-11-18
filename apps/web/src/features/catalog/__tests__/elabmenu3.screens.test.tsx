// @vitest-environment jsdom
// T0D-ELABMENU-3 (LD-340) — render walk: the screens that render in the harness show the ElabAssist menu label as h1, inside the ONE shared PageHeader
// (title left, primary action right), and their EMPTY message uses the menu label wording (done_when 2, 3, 4). Each screen is tied to its sidebar entry id,
// so the expected text is t(entry.label) read from the generated manifest, never typed here. Empty lists keep their column headers (T0D-EMPTYTBL-1/2).
// "Label wording" = the empty message contains the label's stem (label lower-cased, last letter y/s dropped so category/categories and unit/units both match).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';
import { headersOf, messageRow, tableOf } from './emptytbl2.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/x',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/x' }));
const { stubModule } = vi.hoisted(() => ({
  stubModule: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }),
}));
vi.mock('@/features/catalog/server/actions', stubModule);
vi.mock('@/features/catalog/server/catalogActions', stubModule);
vi.mock('@/features/catalog/server/pricingActions', stubModule);

import { DepartmentsList } from '@/features/catalog/components/DepartmentsList';
import { DoctorsList } from '@/features/catalog/components/DoctorsList';
import { SpecimensScreen } from '@/features/catalog/components/SpecimensScreen';
import { UnitsScreen } from '@/features/catalog/components/UnitsScreen';
import { PanelsList } from '@/features/catalog/components/PanelsList';
import { PriceListsList } from '@/features/catalog/components/PriceListsList';
import { CreditPartiesScreen } from '@/features/catalog/components/CreditPartiesScreen';
import { TestsList } from '@/features/catalog/components/TestsList';
import { CriticalValueList } from '@/features/lab/components/CriticalValueList';
import { IngestExceptionList } from '@/features/lab/components/IngestExceptionList';

const MANAGE = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage', 'catalog.referrer.read', 'catalog.referrer.manage'];
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const labelOf = (id: string) => {
  const e = navEntries.find((x) => x.id === id);
  if (!e) throw new Error(`no nav entry ${id}`);
  return t(e.label);
};
const stem = (label: string) => label.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/[ys]$/, '');

const SCREENS: ReadonlyArray<readonly [id: string, el: () => ReactElement]> = [
  ['catalog.departments', () => <DepartmentsList departments={[]} permissions={MANAGE} />],
  ['catalog.doctors', () => <DoctorsList doctors={[]} permissions={MANAGE} />],
  ['catalog.specimens', () => <SpecimensScreen specimenTypes={[]} containers={[]} permissions={MANAGE} />],
  ['catalog.units', () => <UnitsScreen units={[]} valueSets={[]} permissions={MANAGE} />],
  ['catalog.panels', () => <PanelsList panels={[]} departments={[]} permissions={MANAGE} />],
  ['catalog.price_lists', () => <PriceListsList priceLists={[]} permissions={MANAGE} />],
  ['catalog.credit_parties', () => <CreditPartiesScreen creditParties={[]} permissions={MANAGE} />],
  ['catalog.tests', () => <TestsList rows={[]} filters={{ q: '', department_id: '', specimen_type_id: '', is_active: '' }} page={1} pages={1} filtered={false} departments={[]} specimenTypes={[]} manage openNew={false} />],
];

describe.each(SCREENS)('%s (empty, manage rights)', (id, el) => {
  it('h1 is exactly the menu label', () => {
    const { container } = wrap(el());
    const h1s = [...container.querySelectorAll('h1')].map((h) => (h.textContent ?? '').trim());
    expect(h1s, `the screen heading must be "${labelOf(id)}"`).toEqual([labelOf(id)]);
  });

  it('shared header: the h1 sits in .lims-page-header-row before .lims-page-actions, and the primary New/Add/Create button is in the actions (right)', () => {
    const { container } = wrap(el());
    const row = container.querySelector('.lims-page-header-row');
    expect(row, 'PageHeader (.lims-page-header-row) is rendered').toBeTruthy();
    const title = row!.querySelector('h1.lims-page-title')!;
    const actions = row!.querySelector('.lims-page-actions')!;
    expect(title, 'h1.lims-page-title inside the header row').toBeTruthy();
    expect(actions, '.lims-page-actions inside the header row').toBeTruthy();
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING, 'title first, actions after').toBeTruthy();
    expect(within(actions as HTMLElement).queryAllByRole('button', { name: /^(new|add|create)\b/i }).length, 'primary action in the header').toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('.lims-page-header').length, 'one header per screen, not a second one').toBe(1);
  });

  it('empty message uses the menu label wording, and the column headers stay', () => {
    const { container } = wrap(el());
    const t0 = tableOf(container);
    expect(headersOf(t0).length, 'column headers kept').toBeGreaterThanOrEqual(3);
    const msg = (messageRow(t0)?.textContent ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
    expect(msg, `empty message "${msg}" must contain "${stem(labelOf(id))}" (menu label "${labelOf(id)}")`).toContain(stem(labelOf(id)));
  });
});

describe('lab list screens', () => {
  it('lab.critical_values: h1 = menu label, message uses the label wording', () => {
    const id = 'lab.critical_values';
    const { container } = render(<CriticalValueList items={[]} />);
    expect([...container.querySelectorAll('h1')].map((h) => (h.textContent ?? '').trim())).toEqual([labelOf(id)]);
    const msg = (messageRow(tableOf(container))?.textContent ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
    expect(msg).toContain(stem(labelOf(id)));
  });
  it('lab.ingest_exceptions: h1 = menu label, message uses the label wording', () => {
    const id = 'lab.ingest_exceptions';
    const { container } = render(<IngestExceptionList items={[]} />);
    expect([...container.querySelectorAll('h1')].map((h) => (h.textContent ?? '').trim())).toEqual([labelOf(id)]);
    const msg = (messageRow(tableOf(container))?.textContent ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
    expect(msg).toContain(stem(labelOf(id)));
  });
});
