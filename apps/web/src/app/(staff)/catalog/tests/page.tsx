// SCR-06 Tests list — server component (T0D-CATTESTS-1, LD-310): same page pattern as Departments / Doctors. Filters live in the
// address bar (q, department_id, specimen_type_id, is_active, page); every value is validated here before anything reaches the API.
// department_id and is_active go to the API; q (code/name) and the specimen filter run in the BFF (the API has no such params).
// T0D-TESTMGMT-1 (LD-318): test management tab strip on the same route (no new route): ?view=details[&test=<id>] | categories | popular;
// no view = the Complete test list. ?new=1[&copy=<id>] opens the full Add Test form.
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { TestDetailsView, type DetailsParam } from '@/features/catalog/components/TestDetailsView';
import { CategoriesView, PopularView, TestMgmtTabs, VIEWS, type View } from '@/features/catalog/components/TestMgmtViews';
import { TestsList, type TestsFilters } from '@/features/catalog/components/TestsList';
import { getTest } from '@/features/catalog/server/getTest.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listSpecimenTypes } from '@/features/catalog/server/listSpecimenTypes.server';
import { listAllTests, testsWithSpecimen } from '@/features/catalog/server/listTests.server';
import { PageError } from '@/features/catalog/components/PageError';
import { failedRequestId } from '@/features/catalog/components/page-failed';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';
import { allTestDetails, listTestCategories } from '@/features/catalog/server/testMgmt.server';

const READ = 'catalog.test.read';
const MANAGE = 'catalog.test.manage';
const PAGE_SIZE = 25; // done_when (4); a constant imported from the 'use client' list would be a client reference here
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sp = Readonly<Record<string, string | string[] | undefined>>;
const one = (sp: Sp, k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
const idOf = (v: string) => (UUID.test(v) ? v.toLowerCase() : '');
/** T0D-TESTMGMT-FIX-1 (LD-340): a secondary list (filters, dropdowns, names) never decides the page; a failure gives `empty` + one note. */
const soft = <T, E>(p: Promise<T>, empty: E, name: string, missing: string[]): Promise<T | E> => p.catch(() => { missing.push(name); return empty; });
const Notes = ({ missing }: { missing: readonly string[] }) => (
  <>{missing.map((n) => <p key={n} role="note" className="lims-description">{n} could not be loaded; the page is shown without them. Reload to try again.</p>)}</>
);
type Summary =Awaited<ReturnType<typeof listAllTests>>[number] & { short_name?: string; display_name?: string; category_name?: string; default_price_paisa?: number };

export default async function TestsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const [sp, session] = await Promise.all([searchParams, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes(READ)) return <p>{t('catalog.tests.no_access')}</p>;
  const asked = one(sp, 'view');
  const view: View = (VIEWS as readonly string[]).includes(asked) && asked !== 'list' ? (asked as View) : 'list';

  // T0D-UNSLOP-1 / LD-353 rule 6: 501 operation_pending keeps the title and the header row (NotAvailable), never error.tsx.
  const heads = [t('catalog.tests.col_code'), t('catalog.tests.col_name'), t('catalog.tests.col_department'), t('catalog.tests.col_status')];
  // T0D-UILIST-3 / LD-353 rule 6: any other failure keeps the title (PageError with Retry) instead of the error page.
  let body;
  try {
    body = await pendingOr(t('catalog.tests.title'), heads, () =>
      view === 'details' ? detailsView(sp, permissions) : view === 'categories' ? categoriesView(permissions) : view === 'popular' ? popularView(permissions) : listView(sp, permissions),
    );
  } catch (e) {
    body = <PageError title={t('catalog.tests.title')} requestId={failedRequestId(e)} />;
  }
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
    ...(one(sp, 'retired') === '1' ? { retired: '1' as const } : {}),
  };
  const manage = permissions.includes(MANAGE);
  const openNew = manage && one(sp, 'new') === '1';
  const copyId = openNew ? idOf(one(sp, 'copy')) : '';
  const missing: string[] = [];
  const r = await orForbidden(() =>
    Promise.all([
      listAllTests({ departmentId: filters.department_id || undefined, isActive: filters.is_active || 'all' }) as Promise<Summary[]>,
      soft(listDepartments({ isActive: 'all', limit: 200 }), { data: [] as Awaited<ReturnType<typeof listDepartments>>['data'] }, 'Departments', missing),
      soft(listSpecimenTypes({ isActive: 'all', limit: 200 }), { data: [] as Awaited<ReturnType<typeof listSpecimenTypes>>['data'] }, 'Specimen types', missing),
      soft(listTestCategories(), [], 'Test categories', missing),
      copyId ? orMissing(() => getTest(copyId)) : Promise.resolve(undefined),
    ]),
  );
  if (!r) return null;
  const [all, departments, specimenTypes, categories, copyFrom] = r;

  const needle = filters.q.toLowerCase();
  let rows = needle ? all.filter((x) => x.code.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle)) : all;
  if (filters.specimen_type_id) rows = await testsWithSpecimen(rows, filters.specimen_type_id);
  // T0D-FIX-4 (LD-446, CR DEPLOY-AXIS-012 item 7c): no Status filter = active only; the Show retired switch (retired=1) adds the retired ones.
  const retiredCount = rows.filter((x) => !x.is_active).length;
  if (!filters.is_active && !filters.retired) rows = rows.filter((x) => x.is_active);

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
    <>
    <Notes missing={missing} />
    <TestsList
      rows={shown}
      retiredCount={retiredCount}
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
    </>
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
  const missing: string[] = [];
  const r = await orForbidden(() =>
    Promise.all([listTestCategories(), soft(listDepartments({ isActive: 'all', limit: 200 }), { data: [] as Awaited<ReturnType<typeof listDepartments>>['data'] }, 'Departments', missing)]),
  );
  if (!r) return null;
  const [categories, departments] = r;
  return <><Notes missing={missing} /><CategoriesView categories={categories} departments={departments.data.map((d) => ({ id: d.id, name: d.name, is_active: d.is_active }))} permissions={permissions} /></>;
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
