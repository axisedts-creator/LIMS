'use client';
// T0D-TESTMGMT-1 done_when (6) (LD-318): Categories, Popular tests and Complete test list on /catalog/tests?view=categories|popular|complete
// (address-bar views of the existing route; no route added). Compact tables whose headers are always drawn; lists are paged (≤ 50 rows).
// Categories are never deleted: is_active false is the only way out (TestCategoryUpdate). Popular on / off = PATCH tests/{id} {is_popular}.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { formatNpr } from '../server/types';
import { createTestCategoryAction, listTestsPageAction, setPopularAction, updateTestCategoryAction, type TestRowLite } from '../server/testmgmtActions';
import { newKey } from './shared';
import { Check, ErrorList, failText, placeErrors, ReadOnlyNote, SelectIn, TextIn, type ServerError } from './tm-ui';
import { TmNav } from './TestDetails';
import './catalog.css';

type Ref = { id: string; name: string };
export interface Category { id: string; department_id: string; name: string; display_order: number; print_footer: boolean; footer_text?: string; is_active: boolean; version: number }

function Empty({ cols, text }: { cols: number; text: string }) {
  return <tr><td colSpan={cols} className="lims-description">{text}</td></tr>;
}

export function CategoriesScreen({ categories, departments, manage }: { categories: readonly Category[]; departments: readonly Ref[]; manage: boolean }) {
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const dept = new Map(departments.map((d) => [d.id, d.name]));
  const rows = [...categories].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
  return (
    <section aria-label="Test categories" className="lims-stack catalog-gap-2">
      <TmNav current="categories" />
      <div className="lims-inline catalog-gap-2">
        <h1 className="lims-page-title">Test categories</h1>
        {manage ? <Button size="sm" variant="primary" onPress={() => setEditing('new')}>New category</Button> : null}
      </div>
      {manage ? null : <ReadOnlyNote />}
      <table className="lims-table lims-table-compact">
        <caption className="lims-visually-hidden">Test categories</caption>
        <thead><tr>{['Department', 'Name', 'Display order', 'Print footer', 'Status'].map((h) => <th key={h} scope="col">{h}</th>)}{manage ? <th scope="col"><span className="lims-visually-hidden">Actions</span></th> : null}</tr></thead>
        <tbody>
          {rows.length === 0 ? <Empty cols={manage ? 6 : 5} text="No categories yet." /> : null}
          {rows.map((c) => (
            <tr key={c.id} className="lims-row">
              <td>{dept.get(c.department_id) ?? ''}</td><td>{c.name}</td><td>{c.display_order}</td><td>{c.print_footer ? 'Yes' : 'No'}</td>
              <td><Badge tone={c.is_active ? 'success' : 'neutral'}>{c.is_active ? 'Active' : 'Inactive'}</Badge></td>
              {manage ? <td><Button size="sm" variant="ghost" onPress={() => setEditing(c)}>Edit<span className="lims-visually-hidden"> category {c.name}</span></Button></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? <CategoryDialog category={editing === 'new' ? undefined : editing} departments={departments} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function CategoryDialog({ category, departments, onClose }: { category?: Category | undefined; departments: readonly Ref[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const init = { department_id: category?.department_id ?? '', name: category?.name ?? '', display_order: category ? String(category.display_order) : '', footer_text: category?.footer_text ?? '' };
  const [f, setF] = useState(init);
  const [footer, setFooter] = useState(category?.print_footer ?? false);
  const [active, setActive] = useState(category?.is_active ?? true);
  const [key] = useState(newKey);
  const [at, setAt] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof init) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    if (busy) return;
    const e: Record<string, string> = {};
    if (!category && !f.department_id) e['department_id'] = 'Choose the department.';
    if (!f.name.trim()) e['name'] = 'Required.';
    if (f.display_order && !/^\d{1,4}$/.test(f.display_order)) e['display_order'] = '0 to 9999.';
    setAt(e); setOther([]);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = {};
    if (!category) {
      Object.assign(body, { department_id: f.department_id, name: f.name.trim(), print_footer: footer }, f.display_order ? { display_order: Number(f.display_order) } : {}, f.footer_text.trim() ? { footer_text: f.footer_text } : {});
    } else {
      if (f.name.trim() !== category.name) body['name'] = f.name.trim();
      if (f.display_order !== String(category.display_order) && f.display_order) body['display_order'] = Number(f.display_order);
      if (footer !== category.print_footer) body['print_footer'] = footer;
      if (f.footer_text !== (category.footer_text ?? '')) { if (f.footer_text.trim()) body['footer_text'] = f.footer_text; else body['unset'] = ['footer_text']; }
      if (active !== category.is_active) body['is_active'] = active;
      if (!Object.keys(body).length) return onClose();
    }
    setBusy(true);
    try {
      const r = category ? await updateTestCategoryAction(category.id, category.version, body) : await createTestCategoryAction(body, key);
      if (!r.ok) {
        const { at: a, other: o } = placeErrors((r as { errors?: ServerError[] }).errors, ['department_id', 'name', 'display_order', 'footer_text']);
        setAt(a); setOther(o.length || Object.keys(a).length ? o : [failText(r.code)]);
        return;
      }
      toast.show({ tone: 'success', title: 'Category saved.' });
      onClose();
      router.refresh();
    } finally { setBusy(false); }
  };
  return (
    <Dialog title={category ? `Edit category ${category.name}` : 'New category'} isOpen size="md" onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isDisabled={busy} onPress={() => void save()}>Save</Button></>}>
      <div className="lims-form" data-label-placement="start">
        <SelectIn label="Department" value={f.department_id} onChange={set('department_id')} options={departments.map((d) => ({ value: d.id, label: d.name }))} blank="Choose…" required readOnly={!!category} error={at['department_id']} />
        <TextIn label="Name" value={f.name} onChange={set('name')} maxLength={200} required error={at['name']} />
        <TextIn label="Display order" type="number" min={0} max={9999} value={f.display_order} onChange={set('display_order')} error={at['display_order']} />
        <Check label="Print footer" checked={footer} onChange={setFooter} />
        <TextIn label="Footer text" value={f.footer_text} onChange={set('footer_text')} maxLength={2000} area error={at['footer_text']} />
        {category ? <Check label="Active" checked={active} onChange={setActive} /> : null}
        <ErrorList errors={other} />
      </div>
    </Dialog>
  );
}

export function PopularScreen({ tests, manage }: { tests: readonly TestRowLite[]; manage: boolean }) {
  const router = useRouter();
  const [popular, setPopular] = useState(() => new Set(tests.filter((t) => t.is_popular).map((t) => t.id)));
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const rows = tests.filter((t) => popular.has(t.id));
  const toggle = async (id: string, on: boolean) => {
    if (busy) return;
    setBusy(true); setErrors([]);
    try {
      const r = await setPopularAction(id, on);
      if (!r.ok) return setErrors([failText(r.code)]);
      setPopular((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
      setAdding(false); setPick(undefined);
      router.refresh();
    } finally { setBusy(false); }
  };
  return (
    <section aria-label="Popular tests" className="lims-stack catalog-gap-2">
      <TmNav current="popular" />
      <div className="lims-inline catalog-gap-2">
        <h1 className="lims-page-title">Popular tests</h1>
        {manage ? <Button size="sm" variant="primary" onPress={() => setAdding(true)}>Add popular test</Button> : null}
      </div>
      {manage ? null : <ReadOnlyNote />}
      <ErrorList errors={errors} />
      <table className="lims-table lims-table-compact">
        <caption className="lims-visually-hidden">Popular tests</caption>
        <thead><tr><th scope="col">Code</th><th scope="col">Test name</th>{manage ? <th scope="col"><span className="lims-visually-hidden">Actions</span></th> : null}</tr></thead>
        <tbody>
          {rows.length === 0 ? <Empty cols={manage ? 3 : 2} text="No popular tests yet." /> : null}
          {rows.map((t) => (
            <tr key={t.id} className="lims-row">
              <td>{t.code}</td><td>{t.display_name ?? t.name}</td>
              {manage ? <td><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void toggle(t.id, false)}>Remove<span className="lims-visually-hidden"> {t.code} from popular tests</span></Button></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {adding ? (
        <Dialog title="Add popular test" isOpen size="md" onClose={() => setAdding(false)}
          footer={<><Button variant="ghost" onPress={() => setAdding(false)}>Cancel</Button><Button variant="primary" isDisabled={!pick || busy} onPress={() => pick && void toggle(pick, true)}>Add</Button></>}>
          <ul role="listbox" aria-label="Tests" className="catalog-plain-list tm-list">
            {tests.filter((t) => !popular.has(t.id) && t.is_active).map((t) => (
              <li key={t.id} role="option" tabIndex={0} aria-selected={t.id === pick} className="tm-option" onClick={() => setPick(t.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPick(t.id); } }}>{t.code} {t.name}</li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </section>
  );
}

export function CompleteList({ rows: firstRows, next: firstNext, categories, departments, categoryId }: {
  rows: readonly TestRowLite[]; next?: string | undefined; categories: readonly Category[]; departments: readonly (Ref & { code?: string })[]; categoryId: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(firstRows);
  const [next, setNext] = useState(firstNext);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [cat, setCat] = useState(categoryId);
  const [errors, setErrors] = useState<string[]>([]);
  const dept = new Map(departments.map((d) => [d.id, d.name]));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const load = async (category: string, cursor: string | undefined, stack: (string | undefined)[]) => {
    const r = await listTestsPageAction({ ...(cursor ? { cursor } : {}), ...(category ? { categoryId: category } : {}) });
    if (!r.ok) return setErrors([failText(r.code)]);
    setErrors([]); setRows(r.data.rows); setNext(r.data.next); setCursors(stack);
  };
  const onCategory = (v: string) => {
    setCat(v);
    router.replace(`/catalog/tests?view=complete${v ? `&category_id=${v}` : ''}`);
    void load(v, undefined, [undefined]);
  };
  return (
    <section aria-label="Complete test list" className="lims-stack catalog-gap-2">
      <TmNav current="complete" />
      <h1 className="lims-page-title">Complete test list</h1>
      <div className="lims-filter-bar">
        <SelectIn label="Category" value={cat} onChange={onCategory} options={categories.map((c) => ({ value: c.id, label: c.name }))} blank="All categories" />
      </div>
      <ErrorList errors={errors} />
      <table className="lims-table lims-table-compact">
        <caption className="lims-visually-hidden">Complete test list</caption>
        <thead><tr>{['Code', 'Test name', 'Short name', 'Department', 'Category', 'Price'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? <Empty cols={6} text="No tests." /> : null}
          {rows.map((t) => (
            <tr key={t.id} className="lims-row">
              <td><a href={`/catalog/tests?view=details&test=${t.id}`}>{t.code}</a></td><td>{t.display_name ?? t.name}</td><td>{t.short_name ?? ''}</td>
              <td>{(t.department_id && dept.get(t.department_id)) || t.department_code || ''}</td><td>{t.category_name ?? (t.category_id ? catName.get(t.category_id) : '') ?? ''}</td>
              <td className="lims-money">{typeof t.default_price_paisa === 'number' ? formatNpr(t.default_price_paisa) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="lims-inline catalog-gap-2">
        {cursors.length > 1 ? <Button size="sm" onPress={() => void load(cat, cursors.at(-2), cursors.slice(0, -1))}>Previous</Button> : null}
        {next ? <Button size="sm" onPress={() => void load(cat, next, [...cursors, next])}>Next</Button> : null}
      </div>
    </section>
  );
}
