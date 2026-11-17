// SCR-06 Tests list — server component (T0D-CATTESTS-1, LD-310): same page pattern as Departments / Doctors. Filters live in the
// address bar (q, department_id, specimen_type_id, is_active, page); every value is validated here before anything reaches the API.
// department_id and is_active go to the API; q (code/name) and the specimen filter run in the BFF (the API has no such params).
// T0D-TESTMGMT-1 (LD-318): test management tab strip on the same route (no new route): ?view=details[&test=<id>] | categories | popular;
// no view = the Complete test list. ?new=1[&copy=<id>] opens the full Add Test form.
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { TestDetailsView, type DetailsParam } from '@/features/catalog/components/TestDetailsView';
import { CategoriesView, PopularView, TestMgmtTabs, VIEWS, type View } from '@/features/catalog/components/TestMgmtViews';
import { TestsList, type TestsFilters } from '@/features/catalog/components/TestsList';
import { getTest } from '@/features/catalog/server/getTest.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listSpecimenTypes } from '@/features/catalog/server/listSpecimenTypes.server';
import { listAllTests, testsWithSpecimen } from '@/features/catalog/server/listTests.server';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';
import { allTestDetails, listTestCategories } from '@/features/catalog/server/testMgmt.server';

const READ = 'catalog.test.read';
const MANAGE = 'catalog.test.manage';
const PAGE_SIZE = 25; // done_when (4); a constant imported from the 'use client' list would be a client reference here
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sp = Readonly<Record<string, string | string[] | undefined>>;
const one = (sp: Sp, k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
const idOf = (v: string) => (UUID.test(v) ? v.toLowerCase() : '');
type Summary = Awaited<ReturnType<typeof listAllTests>>[number] & { short_name?: string; display_name?: string; category_name?: string; default_price_paisa?: number };

export default async function TestsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const [sp, session] = await Promise.all([searchParams, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes(READ)) return <p>{t('catalog.tests.no_access')}</p>;
  const asked = one(sp, 'view');
  const view: View = (VIEWS as readonly string[]).includes(asked) && asked !== 'list' ? (asked as View) : 'list';

  const body = await (view === 'details' ? detailsView(sp, permissions) : view === 'categories' ? categoriesView(permissions) : view === 'popular' ? popularView(permissions) : listView(sp, permissions));
  if (body === null) return <CatalogForbidden />;
  return <TestMgmtTabs view={view}>{body}</TestMgmtTabs>;
}

async function listView(sp: Sp, permissions: readonly string[]) {
  const status = one(sp, 'is_active');
  const filters: TestsFilters = {
    q: one(sp, 'q').trim().slice(0, 100),
    department_id: idOf(one(sp, 'department_id')),
    specimen_type_id: idOf(one(sp, 'specimen_type_id')),
    is_active: status === 'true' || status === 'false' ? status : '',
  };
  const manage = permissions.includes(MANAGE);
  const openNew = manage && one(sp, 'new') === '1';
  const copyId = openNew ? idOf(one(sp, 'copy')) : '';
  const r = await orForbidden(() =>
    Promise.all([
      listAllTests({ departmentId: filters.department_id || undefined, isActive: filters.is_active || 'all' }) as Promise<Summary[]>,
      // LD-340: the filter lists are optional, a failing one must not take the whole Test Details page down (T0D-TESTMGMT-FIX-1 finds the root cause)
      listDepartments({ isActive: 'all', limit: 200 }).catch(() => ({ data: [] as Awaited<ReturnType<typeof listDepartments>>['data'] })),
      listSpecimenTypes({ isActive: 'all', limit: 200 }).catch(() => ({ data: [] as Awaited<ReturnType<typeof listSpecimenTypes>>['data'] })),
      listTestCategories().catch(() => []),
      copyId ? orMissing(() => getTest(copyId)) : Promise.resolve(undefined),
    ]),
  );
  if (!r) return null;
  const [all, departments, specimenTypes, categories, copyFrom] = r;

  const needle = filters.q.toLowerCase();
  let rows = needle ? all.filter((x) => x.code.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle)) : all;
  if (filters.specimen_type_id) rows = await testsWithSpecimen(rows, filters.specimen_type_id);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const askedPage = /^\d{1,5}$/.test(one(sp, 'page')) ? Number(one(sp, 'page')) : 1;
  const page = Math.min(Math.max(askedPage, 1), pages);
  const deptName = new Map(departments.data.map((d) => [d.id, d.name]));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((x) => ({
    id: x.id, code: x.code, name: x.name, workflow_type: x.workflow_type ?? '', is_active: x.is_active,
    department: (x.department_id && deptName.get(x.department_id)) || x.department_code || '',
    short_name: x.short_name, category: x.category_name, price_paisa: typeof x.default_price_paisa === 'number' ? x.default_price_paisa : undefined,
  }));

  return (
    <TestsList
      rows={shown}
      filters={filters}
      page={page}
      pages={pages}
      filtered={!!(filters.q || filters.department_id || filters.specimen_type_id || filters.is_active)}
      departments={departments.data.map((d) => ({ id: d.id, name: d.name, is_active: d.is_active }))}
      specimenTypes={specimenTypes.data.map((s) => ({ id: s.id, name: s.name, is_active: s.is_active }))}
      categories={categories.map((c) => ({ id: c.id, name: c.name, department_id: c.department_id, is_active: c.is_active }))}
      copyFrom={copyFrom}
      permissions={permissions}
      manage={manage}
      openNew={openNew}
    />
  );
}

async function detailsView(sp: Sp, permissions: readonly string[]) {
  const testId = idOf(one(sp, 'test'));
  const r = await orForbidden(() => Promise.all([listAllTests({ isActive: 'all' }) as Promise<Summary[]>, testId ? orMissing(() => getTest(testId)) : Promise.resolve(undefined)]));
  if (!r) return null;
  const [all, detail] = r;
  const analytes = ((detail?.['analytes'] ?? []) as Record<string, any>[]).filter((a) => a['is_active'] !== false).map((a): DetailsParam => ({
    id: a['id'], code: a['code'], name: a['name'], print_name: a['print_name'], report_subheading: a['report_subheading'], sort_order: a['sort_order'], version: a['version'], current_version: a['current_version'],
  }));
  return (
    <TestDetailsView
      tests={all.map((x) => ({ id: x.id, code: x.code, name: x.name, short_name: x.short_name, display_name: x.display_name }))}
      selected={detail ? { id: detail.id, name: detail.name, analytes } : undefined}
      permissions={permissions}
    />
  );
}

async function categoriesView(permissions: readonly string[]) {
  const r = await orForbidden(() => Promise.all([listTestCategories(), listDepartments({ isActive: 'all', limit: 200 })]));
  if (!r) return null;
  const [categories, departments] = r;
  return <CategoriesView categories={categories} departments={departments.data.map((d) => ({ id: d.id, name: d.name, is_active: d.is_active }))} permissions={permissions} />;
}

async function popularView(permissions: readonly string[]) {
  const all = await orForbidden(() => allTestDetails());
  if (!all) return null;
  return (
    <PopularView
      tests={all.map((x) => ({ id: x.id, code: x.code, name: x.name, short_name: x['short_name'], is_popular: x['is_popular'] === true, version: x.version }))}
      permissions={permissions}
    />
  );
}
