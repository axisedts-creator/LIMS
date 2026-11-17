// SCR-06 Tests list — server component (T0D-CATTESTS-1, LD-310): same page pattern as Departments / Doctors. Filters live in the
// address bar (q, department_id, specimen_type_id, is_active, page); every value is validated here before anything reaches the API.
// department_id and is_active go to the API; q (code/name) and the specimen filter run in the BFF (the API has no such params).
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { TestsList, type TestsFilters } from '@/features/catalog/components/TestsList';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listSpecimenTypes } from '@/features/catalog/server/listSpecimenTypes.server';
import { listAllTests, testsWithSpecimen } from '@/features/catalog/server/listTests.server';
import { orForbidden } from '@/features/catalog/server/shared';

const READ = 'catalog.test.read';
const MANAGE = 'catalog.test.manage';
const PAGE_SIZE = 25; // done_when (4); a constant imported from the 'use client' list would be a client reference here
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sp = Readonly<Record<string, string | string[] | undefined>>;
const one = (sp: Sp, k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
const idOf = (v: string) => (UUID.test(v) ? v.toLowerCase() : '');

export default async function TestsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const [sp, session] = await Promise.all([searchParams, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes(READ)) return <p>{t('catalog.tests.no_access')}</p>;

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
