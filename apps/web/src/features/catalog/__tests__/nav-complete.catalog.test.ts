// T0D-NAV-COMPLETE-1 (LD-250): catalog gains ONE entry, SCR-06 Tests (C3 04-UI-UX s1: /catalog/tests, catalog.test.read, "Catalog > Tests").
// The create-test action stays on that page (no separate "new test" nav entry). The 14 existing entries must not change.
// Order: between Units (50) and Panels (60) = the table order SCR-05, SCR-06, SCR-09 [CONV]. Id/label follow the existing catalog.<snake> / catalog.nav.<snake>.
import { describe, expect, it } from 'vitest';
import { loadManifest, pageExists, routes, specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

specSuite({
  module: 'catalog',
  owner: 'C3',
  section: 'C3 04-UI-UX s1 SCR-06',
  exact: false,
  rows: [{ name: 'Tests', path: '/catalog/tests', permission: 'catalog.test.read', group: 'catalog', orderRange: [50, 60], id: 'catalog.tests' }],
});

const EXISTING: Record<string, [string, number]> = {
  'catalog.home': ['catalog.test.read', 10], 'catalog.departments': ['catalog.test.read', 20], 'catalog.specimens': ['catalog.test.read', 30],
  'catalog.methods': ['catalog.test.read', 40], 'catalog.units': ['catalog.test.read', 50], 'catalog.panels': ['catalog.test.read', 60],
  'catalog.comment_codes': ['catalog.test.read', 70], 'catalog.doctors': ['catalog.referrer.read', 80], 'catalog.credit_parties': ['catalog.price_list.read', 90],
  'catalog.price_lists': ['catalog.price_list.read', 100], 'catalog.price_simulator': ['catalog.price_list.read', 110], 'catalog.surcharges': ['catalog.price_list.read', 120],
  'catalog.tax': ['catalog.price_list.read', 130], 'catalog.imports': ['catalog.test.read', 140],
};

describe('catalog nav manifest: Tests entry details and no regressions', () => {
  it('the Tests page exists (entry allowed) and the entry label key is catalog.nav.tests', async () => {
    expect(pageExists('/catalog/tests')).toBe(true);
    const m = await loadManifest('catalog');
    expect(m.entries.find((e) => e.id === 'catalog.tests')?.label).toBe('catalog.nav.tests');
  });
  it('routes.yaml has exactly one non-parameterised staff_web row for /catalog/tests, owner C3', () => {
    const r = routes.filter((x) => x.origin === 'staff_web' && x.path === '/catalog/tests');
    expect(r.length).toBe(1);
    expect(r[0]!.owner).toBe('C3');
    expect(routes.some((x) => x.id === 'staff.catalog.test' && x.path === '/catalog/tests/{test_id}')).toBe(true); // detail row unchanged
  });
  it('no separate create-test / detail nav entry: the create action stays on the Tests page', async () => {
    const m = await loadManifest('catalog');
    const testRoutes = m.entries.filter((e) => (routes.find((r) => r.id === e.routeId)?.path ?? '').startsWith('/catalog/tests'));
    expect(testRoutes.map((e) => e.id)).toEqual(['catalog.tests']);
    expect(m.entries.some((e) => /test_?(new|create)|new_test|create_test/.test(e.id))).toBe(false);
  });
  it('the 14 existing entries keep permission and order; orders stay unique', async () => {
    const m = await loadManifest('catalog');
    for (const [id, [permission, order]] of Object.entries(EXISTING)) {
      const e = m.entries.find((x) => x.id === id);
      expect(e, id).toBeTruthy();
      expect([e!.permission, e!.order], id).toEqual([permission, order]);
    }
    // + the Tests entry, + the ICD master entry of T0D-PARTYSET-1 (LD-321; pinned by partyset1.source.test.ts). The 14 existing entries are checked above.
    expect(m.entries.length).toBe(Object.keys(EXISTING).length + 1 + 1);
    const orders = m.entries.map((e) => e.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
