// T0D-MSERIES-2 shared harness (tester-owned; not a test file). Synthetic data only.
// LD-251 (2026-11-16): the staff sidebar shows the 14 NavGroups of C0 04-UI-UX s3 (spec/program/13-M-SERIES.md s3).
// Each jsdom test file registers the same mocks as r04 (vi.mock is hoisted), but the nav fixture is THIS file's:
//   vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock)
//   vi.mock('next/link', async () => (await import('./r04.harness')).linkMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock)
//   vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock)
//   vi.mock('@/core/nav/generated', async () => (await import('./m2.harness')).generatedMock)
import { screen, within } from '@testing-library/react';
import { session } from './r04.harness';

export { CENTRES, seriousViolations, user } from './r04.harness';

export const GROUP_IDS = ['front_desk', 'laboratory', 'reporting', 'billing', 'catalog', 'instruments', 'analytics', 'quality', 'inventory', 'partners', 'engagement', 'home_collection', 'admin', 'platform'] as const;
/** 13-M-SERIES s3 order and English labels (core.nav.group.<NavGroup>). */
export const GROUP_LABELS: Record<(typeof GROUP_IDS)[number], string> = {
  front_desk: 'Front desk', laboratory: 'Laboratory', reporting: 'Reporting', billing: 'Billing', catalog: 'Catalog', instruments: 'Instruments', analytics: 'Analytics',
  quality: 'Quality', inventory: 'Inventory', partners: 'Partners', engagement: 'Engagement', home_collection: 'Home collection', admin: 'Admin', platform: 'Platform',
};
export const TENANT_LABELS = GROUP_IDS.filter((g) => g !== 'platform').map((g) => GROUP_LABELS[g]);

export interface E {
  id: string; label: string; permission: string; group: string; order: number; path: string; routeId: string; module: string;
  icon?: string; section?: string; createLabel?: string; createPath?: string; createPermission?: string;
}
const e = (module: string, id: string, label: string, group: string, order: number, path: string, extra: Partial<E> = {}): E =>
  ({ id: `${module}.${id}`, label, permission: `p.${module}.${id}`, group, order, path, routeId: `staff.${module}.${id}`, module, ...extra });

// Deliberately NOT in group order (platform and admin first): the shell must group by the 14 NavGroups, not by input order.
export const ENTRIES: E[] = [
  e('platform', 'tenants', 'Tenants', 'platform', 10, '/platform/tenants'),
  e('admin', 'users', 'Users', 'admin', 10, '/admin/users', { icon: 'users', createLabel: 'Invite user', createPath: '/admin/users/new', createPermission: 'p.admin.user_new' }),
  e('admin', 'roles', 'Roles', 'admin', 20, '/admin/roles'),
  e('frontdesk', 'register', 'Register', 'front_desk', 10, '/frontdesk/register', { icon: 'user-plus' }),
  e('frontdesk', 'accession', 'Accession', 'front_desk', 20, '/frontdesk/accession'),
  e('frontdesk', 'discount_approvals', 'Discount approvals', 'front_desk', 30, '/frontdesk/discount-approvals'),
  e('lab', 'status_board', 'Status board', 'laboratory', 10, '/lab/status-board', { section: 'Daily work' }),
  e('lab', 'worklist', 'Worklist', 'laboratory', 20, '/lab/worklist', { section: 'Daily work' }),
  e('lab', 'results', 'Results', 'laboratory', 30, '/lab/results', { section: 'Daily work' }),
  e('micro', 'culture', 'Culture worklist', 'laboratory', 40, '/micro/culture', { section: 'Microbiology' }),
  e('anatomic', 'cases', 'Case workbench', 'laboratory', 50, '/anatomic/cases', { section: 'Anatomic pathology' }),
  e('reporting', 'queue', 'Report queue', 'reporting', 10, '/reporting/worklist'),
  e('billing', 'daily_cash', 'Daily cash', 'billing', 10, '/billing/daily-cash'),
  e('payments', 'receipts', 'Receipts', 'billing', 20, '/payments/receipts', { section: 'Payments' }),
  e('catalog', 'home', 'Test catalogue', 'catalog', 10, '/catalog'),
  e('catalog', 'tests', 'Tests', 'catalog', 20, '/catalog/tests', { createLabel: 'New test', createPath: '/catalog/tests/new', createPermission: 'p.catalog.test_new' }),
  e('catalog', 'price_lists', 'Price lists', 'catalog', 30, '/catalog/price-lists', { section: 'Pricing' }),
  e('instruments', 'agents', 'Agents', 'instruments', 10, '/instruments/agents'),
  e('analytics', 'ops', 'Operations dashboard', 'analytics', 10, '/analytics/operations'),
  e('quality', 'qc', 'QC results', 'quality', 10, '/quality/qc'),
  e('inventory', 'stock', 'Stock', 'inventory', 10, '/inventory/stock'),
  e('partners', 'accounts', 'Partner accounts', 'partners', 10, '/partners/accounts'),
  e('engagement', 'campaigns', 'Campaigns', 'engagement', 10, '/engagement/campaigns'),
  e('homecollection', 'visits', 'Visit board', 'home_collection', 10, '/homecollection/visits'),
];
export const CREATE_PERMS = ENTRIES.flatMap((x) => (x.createPermission ? [x.createPermission] : []));
export const ALL_PERMS = [...ENTRIES.map((x) => x.permission), ...CREATE_PERMS];
export const TENANT_ENTRIES = ENTRIES.filter((x) => x.group !== 'platform');
export const byId = (id: string) => ENTRIES.find((x) => x.id === id)!;
export const generatedMock = {
  navEntries: ENTRIES,
  staffRoutes: ENTRIES.map((x) => ({ id: x.routeId, path: x.path, permission: x.permission })),
};

/** A platform-staff session (session.kind === 'platform'): the shell shows only the platform group (13-M-SERIES s3). */
export const platformSession = (permissions: string[]) => session(permissions, { kind: 'platform' });
export { session };

// ---------------------------------------------------------------- DOM helpers (contract: see m2.sidebar.test.tsx header)
export const sidebar = () => screen.getByRole('navigation', { name: 'Main' });
export const groupEl = (label: string) => within(sidebar()).getByRole('group', { name: label });
export const groupLabels = () => within(sidebar()).queryAllByRole('group').map((g) => g.getAttribute('aria-label'));
export const header = (label: string) => within(groupEl(label)).getByRole('button', { name: new RegExp(`^${label}`) });
export const expandedLabels = () => groupLabels().filter((l) => header(l!).getAttribute('aria-expanded') === 'true');
export const linkNames = (root: HTMLElement = sidebar()) => within(root).queryAllByRole('link').map((a) => a.textContent?.trim() ?? '');
