'use client';
// T0D-TESTMGMT-1 items (6), (7), LD-318: the test management views on /catalog/tests behind one tab strip (no new route: rs-c2.static pins
// the route tree; nav.manifest keeps its single /catalog/tests entry). ?view=details | (none = Complete test list) | categories | popular.
// Categories: Name · Department · Display order · Print footer · Footer text · Status; New category; Deactivate (never deleted).
// Popular tests: Code · Name · Short name; Add popular test / Remove = PATCH is_popular with If-Match. Manage affordances are a UI hint.
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { createTestCategoryAction, updateTestCategoryAction, updateTestFullAction } from '../server/testMgmtActions';
import { intOf } from './compact-ui';
import { EditorDialog, MasterTable, StatusBadge, canManage, type Col } from './master-ui';
import { FailBanner, type Fail } from './shared';

export const VIEWS = ['details', 'list', 'categories', 'popular'] as const;
export type View = (typeof VIEWS)[number];
const TABS = [{ id: 'details', label: 'Test details' }, { id: 'list', label: 'Complete test list' }, { id: 'categories', label: 'Categories' }, { id: 'popular', label: 'Popular tests' }] as const;

export function TestMgmtTabs({ view, children }: { view: View; children: ReactNode }) {
  const router = useRouter();
  return (
    <Tabs aria-label="Test management" items={TABS} selectedId={view} onChange={(id) => router.push(id === 'list' ? '/catalog/tests' : `/catalog/tests?view=${id}`)}>
      {children}
    </Tabs>
  );
}

const header = (title: string) => <PageHeader title={title} helpKey="catalog.tests" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Tests', href: '/catalog/tests' }, { label: title }]} />;

type Ref = { id: string; name: string; is_active: boolean };
export interface CategoryRow { id: string; department_id: string; name: string; display_order: number; print_footer: boolean; footer_text?: string | undefined; is_active: boolean; version: number }

export function CategoriesView({ categories, departments, permissions }: { categories: readonly CategoryRow[]; departments: readonly Ref[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [fail, setFail] = useState<Fail>();
  const dept = new Map(departments.map((d) => [d.id, d.name]));
  const cols: Col<CategoryRow>[] = [
    { header: 'Name', cell: (r) => r.name },
    { header: 'Department', cell: (r) => dept.get(r.department_id) ?? '' },
    { header: 'Display order', cell: (r) => String(r.display_order) },
    { header: 'Print footer', cell: (r) => (r.print_footer ? 'Yes' : 'No') },
    { header: 'Footer text', cell: (r) => r.footer_text ?? '' },
    { header: 'Status', cell: (r) => <StatusBadge active={r.is_active} /> },
  ];
  const deactivate = async (r: CategoryRow) => {
    const res = await updateTestCategoryAction(r.id, r.version, { is_active: false });
    if (res.ok) { setFail(undefined); router.refresh(); } else setFail(res);
  };
  const sorted = [...categories].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
  return (
    <section aria-label="Test categories">
      {header('Test categories')}
      <div className="lims-inline catalog-gap-2">
        <Button variant="primary" isDisabled={!manage} onPress={() => setCreating(true)}>New category</Button>
        {manage ? null : <p className="lims-description">Requires permission catalog.test.manage to add or deactivate categories.</p>}
      </div>
      {fail ? <FailBanner fail={fail} /> : null}
      <MasterTable
        caption="Test categories"
        cols={cols}
        rows={sorted}
        empty="No test categories yet."
        codeOf={(r) => r.name}
        rowExtra={(r) => (r.is_active ? <Button size="sm" variant="ghost" isDisabled={!manage} onPress={() => void deactivate(r)}>Deactivate<VisuallyHidden> category {r.name}</VisuallyHidden></Button> : null)}
      />
      {creating ? <CategoryDialog departments={departments} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function CategoryDialog({ departments, onClose }: { departments: readonly Ref[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [department, setDepartment] = useState<string>();
  const [order, setOrder] = useState('');
  const [printFooter, setPrintFooter] = useState(false);
  const [footer, setFooter] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [orderError, setOrderError] = useState<string>();
  const n = intOf(order, 0, 9999);
  return (
    <EditorDialog
      title="New category"
      savedText="Category saved."
      onClose={onClose}
      onDuplicate={() => setNameError('This name is already used in this department.')}
      check={() => { const bad = Number.isNaN(n); setOrderError(bad ? 'A whole number from 0 to 9999.' : undefined); return !bad; }}
      save={(key) =>
        createTestCategoryAction({ department_id: department, name: name.trim(), ...(n !== undefined && !Number.isNaN(n) ? { display_order: n } : {}), ...(printFooter ? { print_footer: true } : {}), ...(footer.trim() ? { footer_text: footer.trim() } : {}) }, key)
      }
    >
      <TextField label="Name" name="name" maxLength={200} isRequired value={name} onChange={(v) => { setName(v); setNameError(undefined); }} {...(nameError ? { error: nameError } : {})} />
      <Select label="Department" name="department_id" isRequired {...(department ? { value: department } : {})} onChange={setDepartment} options={departments.filter((d) => d.is_active).map((d) => ({ value: d.id, label: d.name }))} />
      <TextField label="Display order" name="display_order" maxLength={4} inputMode="numeric" value={order} onChange={setOrder} {...(orderError ? { error: orderError } : {})} />
      <Checkbox label="Print footer" name="print_footer" isSelected={printFooter} onChange={setPrintFooter} />
      <TextArea label="Footer text" name="footer_text" maxLength={2000} rows={3} value={footer} onChange={setFooter} />
    </EditorDialog>
  );
}

export interface PopularRow { id: string; code: string; name: string; short_name?: string | undefined; is_popular: boolean; version: number }

export function PopularView({ tests, permissions }: { tests: readonly PopularRow[]; permissions: readonly string[] }) {
  const manage = canManage(permissions);
  const router = useRouter();
  const toast = useToast();
  const [pick, setPick] = useState<string>();
  const [fail, setFail] = useState<Fail>();
  const popular = tests.filter((x) => x.is_popular);
  const others = tests.filter((x) => !x.is_popular);
  const mark = async (r: PopularRow, on: boolean) => {
    const res = await updateTestFullAction(r.id, r.version, { is_popular: on });
    if (!res.ok) return setFail(res);
    setFail(undefined);
    setPick(undefined);
    toast.show({ tone: 'success', title: on ? `${r.code} added to popular tests.` : `${r.code} removed from popular tests.` });
    router.refresh();
  };
  const cols: Col<PopularRow>[] = [{ header: 'Code', cell: (r) => r.code }, { header: 'Name', cell: (r) => r.name }, { header: 'Short name', cell: (r) => r.short_name ?? '' }];
  return (
    <section aria-label="Popular tests">
      {header('Popular tests')}
      {manage ? (
        <div className="lims-filter-bar">
          <Select label="Add popular test" name="add_popular" {...(pick ? { value: pick } : {})} onChange={setPick} options={others.map((x) => ({ value: x.id, label: `${x.name} (${x.code})` }))} />
          <Button isDisabled={!pick} onPress={() => { const r = others.find((x) => x.id === pick); if (r) void mark(r, true); }}>Add</Button>
        </div>
      ) : <p className="lims-description">Requires permission catalog.test.manage to change popular tests.</p>}
      {fail ? <FailBanner fail={fail} /> : null}
      <MasterTable
        caption="Popular tests"
        cols={cols}
        rows={popular}
        empty="No popular tests yet."
        rowExtra={manage ? (r) => <Button size="sm" variant="ghost" onPress={() => void mark(r, false)}>Remove<VisuallyHidden> {r.code}</VisuallyHidden></Button> : undefined}
      />
    </section>
  );
}
