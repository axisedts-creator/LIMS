// SCR-06 Tests list — server component (T0D-CATTESTS-1, LD-310): same page pattern as Departments / Doctors. Filters live in the
// address bar (q, department_id, specimen_type_id, is_active, page); every value is validated here before anything reaches the API.
// department_id and is_active go to the API; q (code/name) and the specimen filter run in the BFF (the API has no such params).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { problem } from '@/core/session/types';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { ParameterForm } from '@/features/catalog/components/ParameterForm';
import { TestDetails, type Param } from '@/features/catalog/components/TestDetails';
import { TestForm } from '@/features/catalog/components/TestForm';
import { CategoriesScreen, CompleteList, PopularScreen } from '@/features/catalog/components/TestLists';
import { TestsList, type TestsFilters } from '@/features/catalog/components/TestsList';
import { getAnalyte } from '@/features/catalog/server/getAnalyte.server';
import { getTest } from '@/features/catalog/server/getTest.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listSpecimenTypes } from '@/features/catalog/server/listSpecimenTypes.server';
import { listTestCategories } from '@/features/catalog/server/listTestCategories.server';
import { listAllTests, testsWithSpecimen } from '@/features/catalog/server/listTests.server';
import { listMethods, listSpecimenTypes as listSpecimenTypesLite, listUnits, listValueSets } from '@/features/catalog/server/lists.server';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';
import { listTestsPageAction } from '@/features/catalog/server/testmgmtActions';

const READ = 'catalog.test.read';
const MANAGE = 'catalog.test.manage';
const PAGE_SIZE = 25; // done_when (4); a constant imported from the 'use client' list would be a client reference here
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sp = Readonly<Record<string, string | string[] | undefined>>;
const one = (sp: Sp, k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
const idOf = (v: string) => (UUID.test(v) ? v.toLowerCase() : '');
const TM_VIEWS = new Set(['details', 'categories', 'popular', 'complete']);

/** T0D-TESTMGMT-1 screens. Every address-bar value is checked (UUIDs, fixed words) before it reaches the API. */
async function testManagementView(view: string, sp: Sp, permissions: readonly string[]): Promise<React.ReactNode> {
  const manage = permissions.includes(MANAGE);
  const page = async (q: { categoryId?: string; withTags?: boolean }) => {
    const r = await listTestsPageAction(q);
    if (!r.ok) throw new ApiError(r.status, problem(r.code, 'Request failed', r.status));
    return r.data;
  };
  const categories = async () => (await listTestCategories({ isActive: 'all', limit: 200 })).data;
  const departments = async () => (await listDepartments({ isActive: 'all', limit: 200 })).data;
  if (view === 'categories') {
    const [cats, depts] = await Promise.all([categories(), departments()]);
    return <CategoriesScreen categories={cats} departments={depts} manage={manage} />;
  }
  if (view === 'popular') return <PopularScreen tests={await listAllTests({ isActive: 'all' })} manage={manage} />;
  if (view === 'complete') {
    const categoryId = idOf(one(sp, 'category_id'));
    const [first, cats, depts] = await Promise.all([page(categoryId ? { categoryId } : {}), categories(), departments()]);
    return <CompleteList rows={first.rows} next={first.next} categories={cats} departments={depts} categoryId={categoryId} />;
  }

  // view=details: the two panes, or one of the two forms.
  const testId = idOf(one(sp, 'test'));
  const test = testId ? await orMissing(() => getTest(testId)) : undefined;
  if (testId && !test) notFound();
  const form = one(sp, 'form');
  if (form === 'new' || ((form === 'edit' || form === 'copy') && test)) {
    const [depts, cats, specs] = await Promise.all([departments(), categories(), listSpecimenTypes({ isActive: 'all', limit: 200 })]);
    return <TestForm mode={form as 'new' | 'edit' | 'copy'} test={form === 'new' ? undefined : test} departments={depts} categories={cats} specimens={specs.data} manage={manage} />;
  }
  const params = ((test?.['analytes'] ?? []) as Param[]);
  const parameter = one(sp, 'parameter');
  if (test && (parameter === 'new' || UUID.test(parameter))) {
    const analyte = parameter === 'new' ? undefined : await orMissing(() => getAnalyte(parameter));
    if (parameter !== 'new' && (!analyte || (analyte as { test_id?: string }).test_id !== test.id)) notFound();
    const versions = (analyte?.versions ?? []) as unknown as Record<string, unknown>[];
    const version = versions.find((v) => v['status'] === 'draft') ?? versions.find((v) => v['status'] === 'published') ?? (analyte as { current_version?: Record<string, unknown> } | undefined)?.current_version;
    const [units, methods, valueSets, specs] = await Promise.all([listUnits(), listMethods(), listValueSets(), listSpecimenTypesLite()]);
    return (
      <ParameterForm testId={test.id} testCode={test.code} analyte={analyte} version={version} siblings={params}
        units={units.map((u) => ({ value: u.code, label: u.display ?? (u as { name?: string }).name ?? u.code }))}
        methods={methods.filter((m) => m.is_active !== false).map((m) => ({ value: m.id, label: m.name }))}
        valueSets={valueSets.map((v) => ({ value: v.code, label: v.display ?? (v as { name?: string }).name ?? v.code }))}
        specimens={specs.map((s) => ({ value: s.id, label: s.name }))} manage={manage} />
    );
  }
  const first = await page({ withTags: true });
  return <TestDetails rows={first.rows} next={first.next} test={test ? { id: test.id, code: test.code, name: test.name } : undefined} params={params} manage={manage} />;
}

export default async function TestsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const [sp, session] = await Promise.all([searchParams, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes(READ)) return <p>{t('catalog.tests.no_access')}</p>;
  // T0D-TESTMGMT-1 (LD-318): test management views of this same route (?view=details|categories|popular|complete); no route added.
  const view = one(sp, 'view');
  if (TM_VIEWS.has(view)) {
    const out = await orForbidden(() => testManagementView(view, sp, permissions));
    return out ?? <CatalogForbidden />;
  }

  const status = one(sp, 'is_active');
  const filters: TestsFilters = {
    q: one(sp, 'q').trim().slice(0, 100),
    department_id: idOf(one(sp, 'department_id')),
    specimen_type_id: idOf(one(sp, 'specimen_type_id')),
    is_active: status === 'true' || status === 'false' ? status : '',
  };
  const r = await orForbidden(() =>
    Promise.all([
      listAllTests({ departmentId: filters.department_id || undefined, isActive: filters.is_active || 'all' }),
      listDepartments({ isActive: 'all', limit: 200 }),
      listSpecimenTypes({ isActive: 'all', limit: 200 }),
    ]),
  );
  if (!r) return <CatalogForbidden />;
  const [all, departments, specimenTypes] = r;

  const needle = filters.q.toLowerCase();
  let rows = needle ? all.filter((x) => x.code.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle)) : all;
  if (filters.specimen_type_id) rows = await testsWithSpecimen(rows, filters.specimen_type_id);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const asked = /^\d{1,5}$/.test(one(sp, 'page')) ? Number(one(sp, 'page')) : 1;
  const page = Math.min(Math.max(asked, 1), pages);
  const deptName = new Map(departments.data.map((d) => [d.id, d.name]));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((x) => ({
    id: x.id, code: x.code, name: x.name, workflow_type: x.workflow_type ?? '', is_active: x.is_active,
    department: (x.department_id && deptName.get(x.department_id)) || x.department_code || '',
  }));
  const manage = permissions.includes(MANAGE);

  return (
    <TestsList
      rows={shown}
      filters={filters}
      page={page}
      pages={pages}
      filtered={!!(filters.q || filters.department_id || filters.specimen_type_id || filters.is_active)}
      departments={departments.data.map((d) => ({ id: d.id, name: d.name, is_active: d.is_active }))}
      specimenTypes={specimenTypes.data.map((s) => ({ id: s.id, name: s.name, is_active: s.is_active }))}
      manage={manage}
      openNew={manage && one(sp, 'new') === '1'}
    />
  );
}
