'use client';
// SCR-06 Tests list (T0D-CATTESTS-1, LD-310): Departments / Doctors page pattern — header with New test, search, department /
// specimen / status filters kept in the address bar, a table whose headers are always drawn, 25 rows per page, and one New test
// form for the header button, the empty-row button and /catalog/tests?new=1. Manage affordances are a UI hint; the API enforces.
// T0D-TESTMGMT-1 (LD-318): the form is the full Add Test form (TestForm, ?new=1&copy=<id> prefills from a test).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { t } from '@/core/i18n/messages';
import { Switch } from '@lims/ui/components/Switch';
// T0D-FIX-4 (LD-446): the invoice list's money formatter (NPR 1,800.00, lakh grouping), not a new one
import { formatNpr } from '@/features/billing/components/format';
import { PERM } from './shared';
import { TestForm, type CategoryRef } from './TestForm';
import './catalog.css';

/** T0D-FIX-4 (LD-446): with no Status filter the list is active only; retired='1' (the Show retired switch) adds the retired tests. */
export interface TestsFilters { q: string; department_id: string; specimen_type_id: string; is_active: '' | 'true' | 'false'; retired?: '' | '1' }
/** T0D-TESTMGMT-1 (LD-318, Complete Test List): short name, category and default price (paisa) added after the five pinned columns. */
export interface TestRow { id: string; code: string; name: string; department: string; workflow_type: string; is_active: boolean; short_name?: string | undefined; category?: string | undefined; price_paisa?: number | undefined }
type Ref = { id: string; name: string; is_active: boolean };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ALL = 'all'; // Select / RadioGroup need a non-empty key for "no filter"

/** /catalog/tests with the filters (empty ones dropped) and page (1 dropped). */
export function testsHref(f: TestsFilters, page = 1): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.department_id) p.set('department_id', f.department_id);
  if (f.specimen_type_id) p.set('specimen_type_id', f.specimen_type_id);
  if (f.is_active) p.set('is_active', f.is_active);
  if (f.retired) p.set('retired', f.retired);
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `/catalog/tests?${s}` : '/catalog/tests';
}

export function TestsList({ rows, filters, page, pages, filtered, departments, specimenTypes, categories = [], copyFrom, permissions = [], manage, openNew, retiredCount = 0 }: {
  rows: readonly TestRow[];
  /** T0D-FIX-4: retired tests in the whole filtered catalog (not the page). */
  retiredCount?: number;
  filters: TestsFilters;
  page: number;
  pages: number;
  filtered: boolean;
  departments: readonly Ref[];
  specimenTypes: readonly Ref[];
  categories?: readonly CategoryRef[];
  /** ?new=1&copy=<id>: the test whose values prefill the form (every field but Code). */
  copyFrom?: Record<string, unknown> | undefined;
  permissions?: readonly string[];
  manage: boolean;
  openNew: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(openNew && manage);
  const [q, setQ] = useState(filters.q);
  const go = (patch: Partial<TestsFilters>) => router.push(testsHref({ ...filters, ...patch }));
  const open = () => setCreating(true);
  const newButton = <Button variant="primary" isDisabled={!manage} onPress={open}>{t('catalog.tests.new')}</Button>;
  const heads = [t('catalog.tests.col_code'), t('catalog.tests.col_name'), t('catalog.tests.col_department'), t('catalog.tests.col_workflow'), t('catalog.tests.col_status'), 'Short name', 'Category', 'Price'];

  return (
    <section aria-label={t('catalog.tests.list_label')}>
      <PageHeader title={t('catalog.tests.title')} helpKey="catalog.tests" actions={newButton} />
      {manage ? null : <p className="lims-description">{t('catalog.tests.need_manage')}</p>}
      {/* T0D-UIGUARD-1-CATALOG (LD-353 rule 2, LD-436 worklist mock): the kit FilterBar; search on Enter or Search, filters in the address bar */}
      <FilterBar
        filters={[
          { id: 'q', label: t('catalog.tests.search'), kind: 'text', maxLength: 100, search: true },
          { id: 'department_id', label: t('catalog.tests.department'), kind: 'select', options: [{ value: ALL, label: t('catalog.tests.all_departments') }, ...departments.map((d) => ({ value: d.id, label: d.name }))] },
          { id: 'specimen_type_id', label: t('catalog.tests.specimen'), kind: 'select', options: [{ value: ALL, label: t('catalog.tests.all_specimens') }, ...specimenTypes.map((x) => ({ value: x.id, label: x.name }))] },
          { id: 'is_active', label: t('catalog.tests.status'), kind: 'select', options: [{ value: ALL, label: t('catalog.tests.status_all') }, { value: 'true', label: t('catalog.tests.active') }, { value: 'false', label: t('catalog.tests.inactive') }] },
        ]}
        value={{ q, department_id: filters.department_id || ALL, specimen_type_id: filters.specimen_type_id || ALL, is_active: filters.is_active || ALL }}
        onChange={(v) => {
          const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : ALL);
          setQ(typeof v['q'] === 'string' ? v['q'] : '');
          const dept = s('department_id') === ALL ? '' : s('department_id');
          const spec = s('specimen_type_id') === ALL ? '' : s('specimen_type_id');
          const act = s('is_active') === 'true' || s('is_active') === 'false' ? (s('is_active') as 'true' | 'false') : '';
          if (dept !== filters.department_id || spec !== filters.specimen_type_id || act !== filters.is_active) go({ department_id: dept, specimen_type_id: spec, is_active: act });
        }}
        onSearch={() => go({ q: q.trim().slice(0, 100) })}
        onReset={() => { setQ(''); router.push(testsHref({ q: '', department_id: '', specimen_type_id: '', is_active: '' })); }}
        resetLabel="Clear filters"
      />
      {/* T0D-FIX-4 (LD-446, CR DEPLOY-AXIS-012 item 7c): retired (recoded) tests stay reachable behind the kit Switch */}
      {filters.is_active ? null : (
        <div className="lims-inline catalog-gap-2">
          <Switch label="Show retired" isSelected={filters.retired === '1'} onChange={(on) => go({ retired: on ? '1' : '' })} />
          <span className="lims-description">{retiredCount} retired</span>
        </div>
      )}
      {/* T0D-UIX-2 (LD-442): the kit DataTable (density regular, header kept when empty, price end aligned) */}
      <DataTable<TestRow>
        caption={t('catalog.tests.list_label')}
        density="regular"
        rows={rows}
        getRowId={(r) => r.id}
        columns={[
          { id: 'code', header: heads[0]!, isRowHeader: true, cell: (r) => <a href={`/catalog/tests/${r.id}`}>{r.code}</a> },
          { id: 'name', header: heads[1]!, cell: (r) => r.name },
          { id: 'department', header: heads[2]!, cell: (r) => r.department },
          { id: 'workflow', header: heads[3]!, cell: (r) => (r.workflow_type ? cap(r.workflow_type) : '') },
          { id: 'status', header: heads[4]!, cell: (r) => <Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? t('catalog.tests.active') : t('catalog.tests.inactive')}</Badge> },
          { id: 'short_name', header: heads[5]!, cell: (r) => r.short_name ?? '' },
          { id: 'category', header: heads[6]!, cell: (r) => r.category ?? '' },
          { id: 'price', header: heads[7]!, numeric: true, cell: (r) => (r.price_paisa !== undefined ? formatNpr(r.price_paisa) : '') },
        ]}
        emptyState={filtered ? { title: t('catalog.tests.no_match') } : {
          title: t('catalog.tests.empty'),
          ...(manage ? { action: { label: t('catalog.tests.new'), onPress: open } } : {}),
        }}
      />
      {/* T0D-TESTMGMT-FIX-1: starter workbook import, as on the catalog home */}
      {rows.length === 0 && !filtered ? <div><Button variant="secondary" isDisabled={!manage} onPress={() => router.push('/catalog/imports')}>Import from Excel</Button></div> : null}
      {pages > 1 ? (
        <nav aria-label={t('catalog.tests.pages')} className="lims-inline catalog-gap-2">
          {page > 1 ? <a href={testsHref(filters, page - 1)}>{t('catalog.tests.previous')}</a> : null}
          <span>{t('catalog.tests.page_of').replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
          {page < pages ? <a href={testsHref(filters, page + 1)}>{t('catalog.tests.next')}</a> : null}
        </nav>
      ) : null}
      {creating ? (
        <TestForm mode="create" test={copyFrom} departments={departments} categories={categories} specimenTypes={specimenTypes} permissions={permissions.length ? permissions : manage ? [PERM.manage] : []} onClose={() => setCreating(false)} />
      ) : null}
    </section>
  );
}
