// @vitest-environment jsdom
// T0D-UILIST-3 (4) engagement list views that live next to their page.tsx: reminders, enquiries, memberships (plans) — LD-353 template 1 LIST (rules 5, 8).
// Each rendered with no rows and with one row: h1 = menu label (read from the nav manifest), FilterBar rules, table header present in the kit scroll box,
// cut-off cells carry a title. Fails today: the filters are a bare `lims-inline` div (no FilterBar) on reminders and enquiries, and the long cells have no title.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectListScreen, filterBars, h1s, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/engagement/reminders',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/engagement' }));
const stub = vi.hoisted(() => () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }));
vi.mock('@/app/(staff)/engagement/reminders/actions', stub);
vi.mock('@/app/(staff)/engagement/memberships/actions', stub);

import { RemindersView } from '@/app/(staff)/engagement/reminders/RemindersView';
import { EnquiriesView } from '@/app/(staff)/engagement/enquiries/EnquiriesView';
import { MembershipsView } from '@/app/(staff)/engagement/memberships/MembershipsView';

afterEach(cleanup);
const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
const LONG = 'Synthetic Patient With A Very Long Display Name That Will Not Fit One Column';
function expectTitled(root: HTMLElement, text: string) {
  const cells = [...root.querySelectorAll<HTMLElement>('td, [role="gridcell"]')].filter((c) => norm(c.textContent).includes(text));
  expect(cells.length, `a cell with "${text}"`).toBeGreaterThan(0);
  for (const c of cells) expect([c, ...c.querySelectorAll<HTMLElement>('[title]')].some((e) => (e.getAttribute('title') ?? '').includes(text)), `title on cell "${text.slice(0, 30)}"`).toBe(true);
}

// ---------------------------------------------------------------- reminders
const reasons = [{ code: 'follow_up_test', display: 'Follow-up test', isActive: true }];
const reminder = { id: '01a1a98a-ac40-7000-8000-000000000011', patient_id: '01a1a98a-ac40-7000-8000-000000000001', patient_display: LONG, kind: 'custom', reason_code: 'follow_up_test', source: 'staff', due_at: '2026-11-20T04:00:00.000Z', status: 'scheduled', version: 3 };
describe.each([['no rows', []], ['one row', [reminder]]])('reminders (/engagement/reminders) — %s', (name, rows) => {
  const mount = () => wrap(<RemindersView reminders={rows} permissions={['engagement.reminder.read', 'engagement.reminder.manage']} reasons={reasons} searchPatients={async () => []} />);
  it('h1 is the menu label; exactly one FilterBar holding the range, status and kind controls; table header present', () => {
    const { container } = mount();
    expectListScreen(container, { path: '/engagement/reminders', headers: ['Due', 'Patient', 'Kind', 'Status'] });
    const bar = norm(filterBars(container)[0]!.textContent);
    for (const l of ['From', 'To', 'Status', 'Kind']) expect(bar, `filter "${l}" inside the FilterBar`).toContain(l);
  });
  it('the primary action sits in the page header', () => {
    expect(mount().container.querySelector('.lims-page-header')!.textContent).toContain('New reminder');
  });
  if (name === 'one row') it('cut-off cells carry a title: the patient name', () => { expectTitled(mount().container, LONG); });
});

// ---------------------------------------------------------------- enquiries
const enquiry = { id: '01a1a98a-ac40-7000-8000-000000000021', category_code: 'results', subject: 'Synthetic enquiry subject that is much longer than the column can show', status: 'open', last_message_at: '2026-11-17T04:00:00.000Z', version: 1 };
describe.each([['no rows', []], ['one row', [enquiry]]])('enquiries (/engagement/enquiries) — %s', (name, rows) => {
  const mount = () => wrap(<EnquiriesView enquiries={rows} categories={[{ code: 'results', display: 'Results' }]} permissions={['engagement.enquiry.read']} />);
  it('h1 is the menu label; exactly one FilterBar with Status; table header present', () => {
    const { container } = mount();
    expectListScreen(container, { path: '/engagement/enquiries', headers: ['Last message', 'Topic', 'Subject', 'Status'] });
    expect(norm(filterBars(container)[0]!.textContent)).toContain('Status');
  });
  if (name === 'one row') it('cut-off cells carry a title: the subject', () => { expectTitled(mount().container, enquiry.subject); });
});

// ---------------------------------------------------------------- memberships (Plans tab holds the table)
const plan = { id: '01a1a98a-ac40-7000-8000-000000000031', code: 'GOLD', display_name: 'Synthetic Gold Family Membership Plan With A Long Name', description: 'x', price_list_id: '01a1a98a-ac40-7000-8000-000000000041', validity_days: 365, is_active: true, version: 1 };
const lists = [{ id: plan.price_list_id, display: 'Synthetic Price List' }];
describe.each([['no rows', []], ['one row', [plan]]])('memberships (/engagement/memberships) — %s', (name, plans) => {
  const mount = () => wrap(<MembershipsView plans={plans} priceLists={lists} permissions={['engagement.membership.read', 'engagement.membership.enrol', 'engagement.membership_plan.manage']} searchPatients={async () => []} />);
  it('h1 is the menu label on both tabs; the Plans tab shows the header row in the kit scroll box and at most one FilterBar', async () => {
    const { container, getByRole } = mount();
    expect(h1s(container)).toEqual([menuLabel('/engagement/memberships')]);
    await userEvent.setup().click(getByRole('tab', { name: 'Plans' }));
    expectListScreen(container, { path: '/engagement/memberships', headers: ['Code', 'Name', 'Validity (days)', 'Price list', 'Status'], filterBar: 'optional' });
  });
  if (name === 'one row') it('cut-off cells carry a title: the plan name', async () => {
    const { container, getByRole } = mount();
    await userEvent.setup().click(getByRole('tab', { name: 'Plans' }));
    expectTitled(container, plan.display_name);
  });
});
