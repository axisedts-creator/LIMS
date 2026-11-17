'use client';
// SCR-06 Tests list (T0D-CATTESTS-1, LD-310): Departments / Doctors page pattern — header with New test, search, department /
// specimen / status filters kept in the address bar, a table whose headers are always drawn, 25 rows per page, and one New test
// form for the header button, the empty-row button and /catalog/tests?new=1. Manage affordances are a UI hint; the API enforces.
// T0D-TESTMGMT-1 (LD-318): the form is the full Add Test form (TestForm, ?new=1&copy=<id> prefills from a test).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { t } from '@/core/i18n/messages';
import { formatNpr } from '../server/types';
import { PERM } from './shared';
import { TestForm, type CategoryRef } from './TestForm';
import './catalog.css';

export interface TestsFilters { q: string; department_id: string; specimen_type_id: string; is_active: '' | 'true' | 'false' }
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
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `/catalog/tests?${s}` : '/catalog/tests';
}

export function TestsList({ rows, filters, page, pages, filtered, departments, specimenTypes, categories = [], copyFrom, permissions = [], manage, openNew }: {
  rows: readonly TestRow[];
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
      <PageHeader title={t('catalog.tests.title')} helpKey="catalog.tests" breadcrumbs={[{ label: t('catalog.nav.home'), href: '/catalog' }, { label: t('catalog.tests.title') }]} actions={newButton} />
      {manage ? null : <p className="lims-description">{t('catalog.tests.need_manage')}</p>}
      <div className="lims-filter-bar">
        <div onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go({ q: q.trim().slice(0, 100) }); } }}>
          <TextField label={t('catalog.tests.search')} name="q" maxLength={100} value={q} onChange={setQ} />
        </div>
        <Select
          label={t('catalog.tests.department')}
          name="department_id"
          value={filters.department_id || ALL}
          onChange={(v) => go({ department_id: v === ALL ? '' : v })}
          options={[{ value: ALL, label: t('catalog.tests.all_departments') }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
        />
        <Select
          label={t('catalog.tests.specimen')}
          name="specimen_type_id"
          value={filters.specimen_type_id || ALL}
          onChange={(v) => go({ specimen_type_id: v === ALL ? '' : v })}
          options={[{ value: ALL, label: t('catalog.tests.all_specimens') }, ...specimenTypes.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <RadioGroup<string>
          label={t('catalog.tests.status')}
          name="is_active"
          orientation="horizontal"
          value={filters.is_active || ALL}
          onChange={(v) => go({ is_active: v === 'true' || v === 'false' ? v : '' })}
          options={[{ value: ALL, label: t('catalog.tests.status_all') }, { value: 'true', label: t('catalog.tests.active') }, { value: 'false', label: t('catalog.tests.inactive') }]}
        />
      </div>
      <table className="lims-table lims-table-regular">
        <caption className="lims-visually-hidden">{t('catalog.tests.list_label')}</caption>
        <thead>
          <tr>{heads.map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            // T0D-EMPTYTBL-1 (LD-310): message row + four placeholder rows.
            <EmptyRow colSpan={heads.length}>
              {filtered ? t('catalog.tests.no_match') : <>{t('catalog.tests.empty')} {newButton}{' '}
                {/* T0D-TESTMGMT-FIX-1: starter workbook import, as on the catalog home */}
                <Button variant="secondary" isDisabled={!manage} onPress={() => router.push('/catalog/imports')}>Import from Excel</Button></>}
            </EmptyRow>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="lims-row">
                <td className="lims-cell"><a href={`/catalog/tests/${r.id}`}>{r.code}</a></td>
                <td className="lims-cell">{r.name}</td>
                <td className="lims-cell">{r.department}</td>
                <td className="lims-cell">{r.workflow_type ? cap(r.workflow_type) : ''}</td>
                <td className="lims-cell"><Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? t('catalog.tests.active') : t('catalog.tests.inactive')}</Badge></td>
                <td className="lims-cell">{r.short_name ?? ''}</td>
                <td className="lims-cell">{r.category ?? ''}</td>
                <td className="lims-cell">{r.price_paisa !== undefined ? `NPR ${formatNpr(r.price_paisa)}` : ''}</td>
              </tr>
            ))
          )}
        </tbody>
        {rows.length === 0 ? <PlaceholderRows colSpan={heads.length} /> : null}
      </table>
      {pages > 1 ? (
        <nav aria-label={t('catalog.tests.pages')} className="lims-filter-bar">
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
