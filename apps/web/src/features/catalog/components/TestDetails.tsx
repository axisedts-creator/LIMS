'use client';
// T0D-TESTMGMT-1 done_when (2) (LD-318): two-pane Test Details on /catalog/tests?view=details[&test=<id>] (no new route; rs-c2 pins routes).
// Left: one page of tests (≤ 50) with a search box over display name, short name, code and tag. Right: the selected test's parameters
// (name, sub heading, short name) with New / Edit parameter, Add existing parameter to this test, Add space, Remove (= PATCH is_active
// false, no DELETE exists), Move up / Move down and Alt+ArrowUp / Alt+ArrowDown on a focused row (both swap sort_order of two neighbours).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { createAnalyteAction, updateAnalyteAction } from '../server/actions';
import { getTestParametersAction, listTestsPageAction, type TestRowLite } from '../server/testmgmtActions';
import { newKey } from './shared';
import { ErrorList, failText, ReadOnlyNote } from './tm-ui';
import './catalog.css';

export interface Param { id: string; code: string; name: string; report_subheading?: string; sort_order: number; version: number; is_active?: boolean; current_version?: Record<string, unknown> }
export const detailsHref = (p: Record<string, string | undefined>) => {
  const q = new URLSearchParams({ view: 'details' });
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  return `/catalog/tests?${q}`;
};

/** View switcher shared by every test management screen (address-bar views of the existing /catalog/tests route). */
export function TmNav({ current }: { current: string }) {
  const views = [['details', 'Test details'], ['categories', 'Categories'], ['popular', 'Popular tests'], ['complete', 'Complete test list']] as const;
  return (
    <nav aria-label="Test management" className="lims-inline catalog-gap-3">
      <a href="/catalog/tests">All tests</a>
      {views.map(([v, l]) => <a key={v} href={`/catalog/tests?view=${v}`} {...(v === current ? { 'aria-current': 'page' as const } : {})}>{l}</a>)}
    </nav>
  );
}

const rowText = (t: TestRowLite) => [t.display_name, t.short_name, t.code, t.name, ...(t.tags ?? [])].filter(Boolean).join(' ').toLowerCase();

export function TestDetails({ rows: firstRows, next: firstNext, test, params: initial, manage }: {
  rows: readonly TestRowLite[];
  next?: string | undefined;
  test?: { id: string; code: string; name: string } | undefined;
  params: readonly Param[];
  manage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState(firstRows);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]); // cursor of each visited page
  const [next, setNext] = useState(firstNext);
  const [q, setQ] = useState('');
  const [params, setParams] = useState(() => [...initial].filter((p) => p.is_active !== false).sort((a, b) => a.sort_order - b.sort_order));
  const [sel, setSel] = useState<number>();
  const [dialog, setDialog] = useState<'remove' | 'existing' | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((t) => rowText(t).includes(needle)) : rows;
  const page = async (cursor: string | undefined, stack: (string | undefined)[]) => {
    const r = await listTestsPageAction({ ...(cursor ? { cursor } : {}), withTags: true });
    if (!r.ok) return setErrors([failText(r.code)]);
    setRows(r.data.rows); setNext(r.data.next); setCursors(stack);
  };
  const go = (p: Record<string, string | undefined>) => router.push(detailsHref({ test: test?.id, ...p }));
  const fail = (code: string) => setErrors([failText(code)]);

  const guard = async (f: () => Promise<void>) => { if (busy) return; setBusy(true); setErrors([]); try { await f(); } finally { setBusy(false); } };
  /** Swap sort_order of rows i and i+dir (two PATCHes, If-Match each). */
  const move = (i: number, dir: -1 | 1) => guard(async () => {
    const a = params[i], b = params[i + dir];
    if (!a || !b) return;
    const [oa, ob] = a.sort_order === b.sort_order ? [a.sort_order + dir, a.sort_order] : [b.sort_order, a.sort_order];
    const ra = await updateAnalyteAction(a.id, a.version, { sort_order: oa });
    if (!ra.ok) return fail(ra.code);
    const rb = await updateAnalyteAction(b.id, b.version, { sort_order: ob });
    if (!rb.ok) return fail(rb.code);
    const next = [...params];
    next[i] = { ...b, sort_order: ob, version: rb.data.version };
    next[i + dir] = { ...a, sort_order: oa, version: ra.data.version };
    setParams(next); setSel(i + dir);
    router.refresh();
  });
  const remove = () => guard(async () => {
    const p = sel === undefined ? undefined : params[sel];
    if (!p) return;
    const r = await updateAnalyteAction(p.id, p.version, { is_active: false });
    setDialog(null);
    if (!r.ok) return fail(r.code);
    setParams(params.filter((x) => x.id !== p.id)); setSel(undefined);
    toast.show({ tone: 'success', title: `${p.code} removed from the test.` });
    router.refresh();
  });
  const addSpace = () => guard(async () => {
    if (!test) return;
    const used = new Set(params.map((p) => p.code));
    let n = 1;
    while (used.has(`SP${n}`)) n++;
    const after = (sel !== undefined ? params[sel] : params.at(-1))?.sort_order ?? 0;
    const r = await createAnalyteAction(test.id, { code: `SP${n}`, name: 'Space', sort_order: Math.min(after + 1, 9999), is_reportable: false, initial_version: { result_type: 'space' } }, newKey());
    if (!r.ok) return fail(r.code);
    toast.show({ tone: 'success', title: 'Space added.' });
    router.refresh();
  });

  const selected = sel === undefined ? undefined : params[sel];
  const btn = (label: string, onPress: () => void, disabled = false) => <Button size="sm" isDisabled={disabled || busy} onPress={onPress}>{label}</Button>;

  return (
    <section aria-label="Test details" className="lims-stack catalog-gap-2">
      <TmNav current="details" />
      {manage ? null : <ReadOnlyNote />}
      <div className="tm-panes">
        <section aria-labelledby="tm-left" className="tm-pane">
          <div className="lims-inline catalog-gap-2">
            <h2 id="tm-left" className="lims-section-title">Tests</h2>
            {manage ? <Button size="sm" variant="primary" onPress={() => router.push(detailsHref({ form: 'new' }))}>New test</Button> : null}
          </div>
          <input type="search" aria-label="Search tests" placeholder="Name, short name, code or tag" className="lims-input" maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul role="listbox" aria-label="Tests" className="catalog-plain-list tm-list">
            {shown.map((t) => (
              <li key={t.id} role="option" tabIndex={0} aria-selected={t.id === test?.id} className="tm-option"
                onClick={() => router.push(detailsHref({ test: t.id }))}
                onKeyDown={(e) => { if (e.key === 'Enter') router.push(detailsHref({ test: t.id })); }}>
                <strong>{t.code}</strong> {t.display_name ?? t.name}
              </li>
            ))}
          </ul>
          {shown.length === 0 ? <p className="lims-description">{rows.length ? 'No test matches the search.' : 'No tests yet.'}</p> : null}
          <div className="lims-inline catalog-gap-2">
            {cursors.length > 1 ? <Button size="sm" onPress={() => void page(cursors.at(-2), cursors.slice(0, -1))}>Previous</Button> : null}
            {next ? <Button size="sm" onPress={() => void page(next, [...cursors, next])}>Next</Button> : null}
          </div>
        </section>
        <section aria-labelledby="tm-right" className="tm-pane tm-grow">
          <h2 id="tm-right" className="lims-section-title">Parameters</h2>
          {test ? <p className="lims-description">{test.code} {test.name}</p> : <p className="lims-description">Choose a test on the left to see its parameters.</p>}
          {manage && test ? (
            <div className="lims-inline catalog-gap-1 catalog-wrap">
              {btn('New parameter', () => go({ parameter: 'new' }))}
              {btn('Edit parameter', () => selected && go({ parameter: selected.id }), !selected)}
              {btn('Add existing parameter to this test', () => setDialog('existing'))}
              {btn('Add space', () => void addSpace())}
              {btn('Remove', () => setDialog('remove'), !selected)}
              {btn('Move up', () => sel !== undefined && void move(sel, -1), sel === undefined || sel === 0)}
              {btn('Move down', () => sel !== undefined && void move(sel, 1), sel === undefined || sel === params.length - 1)}
            </div>
          ) : null}
          <ErrorList errors={errors} />
          <table className="lims-table lims-table-compact">
            <caption className="lims-visually-hidden">Parameters{test ? ` of ${test.code}` : ''}</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Sub heading</th><th scope="col">Short name</th></tr></thead>
            <tbody>
              {params.length === 0 ? <tr><td colSpan={3} className="lims-description">{test ? 'No parameters in this test yet.' : 'No test selected.'}</td></tr> : null}
              {params.map((p, i) => (
                <tr key={p.id} tabIndex={0} aria-selected={i === sel} className="lims-row tm-row"
                  onClick={() => setSel(i)} onFocus={() => setSel(i)}
                  onKeyDown={(e) => {
                    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); if (manage) void move(i, e.key === 'ArrowDown' ? 1 : -1); }
                    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); ((e.currentTarget[e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling']) as HTMLElement | null)?.focus(); }
                    else if (e.key === 'Enter' && manage) go({ parameter: p.id });
                  }}>
                  <td>{p.name}</td><td>{p.report_subheading ?? ''}</td><td>{p.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {manage && params.length > 1 ? <p className="lims-description">Alt+Arrow Up / Down moves the focused parameter.</p> : null}
        </section>
      </div>
      {dialog === 'remove' && selected ? (
        <Dialog title={`Remove ${selected.code}`} isOpen size="sm" onClose={() => setDialog(null)}
          footer={<><Button variant="ghost" onPress={() => setDialog(null)}>Cancel</Button><Button variant="danger" isDisabled={busy} onPress={() => void remove()}>Remove</Button></>}>
          <p>{selected.name} is taken off this test. Results already reported keep it; it can be made active again later.</p>
        </Dialog>
      ) : null}
      {dialog === 'existing' && test ? <AddExisting tests={rows.filter((t) => t.id !== test.id)} testId={test.id} taken={new Set(params.map((p) => p.code))} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

/** Copy a parameter of another test into this one (the contract has no "link" operation, so it is a new analyte with the same fields). */
function AddExisting({ tests, testId, taken, onClose }: { tests: readonly TestRowLite[]; testId: string; taken: ReadonlySet<string>; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState<string>();
  const [list, setList] = useState<Record<string, any>[]>([]);
  const [error, setError] = useState<string>();
  const needle = q.trim().toLowerCase();
  const pick = async (id: string) => {
    setFrom(id);
    const r = await getTestParametersAction(id);
    setList(r.ok ? r.data.filter((a) => a['is_active'] !== false) : []);
  };
  const copy = async (a: Record<string, any>) => {
    const v = (a['current_version'] ?? {}) as Record<string, unknown>;
    const keep = (o: Record<string, unknown>, ks: string[]) => Object.fromEntries(ks.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));
    const r = await createAnalyteAction(testId, {
      ...keep(a, ['code', 'name', 'print_name', 'report_subheading', 'is_reportable', 'trend_name', 'font', 'result_display_type', 'print_on_negative', 'print_on_worksheet', 'send_in_sms', 'nabl', 'accab_logo', 'is_trend']),
      code: a['code'], name: a['name'],
      initial_version: keep(v, ['result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'default_value', 'long_text_value', 'high_low', 'require_verification']),
    } as never, newKey());
    if (!r.ok) return setError(r.code === 'catalog.code_duplicate' ? `${String(a['code'])} is already a parameter of this test.` : failText(r.code));
    onClose();
    router.refresh();
  };
  return (
    <Dialog title="Add existing parameter" isOpen size="md" onClose={onClose}>
      <div className="lims-stack catalog-gap-2">
        <input type="search" aria-label="Search tests to copy from" className="lims-input" maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} />
        <ul role="listbox" aria-label="Copy from test" className="catalog-plain-list tm-list">
          {tests.filter((t) => !needle || rowText(t).includes(needle)).map((t) => (
            <li key={t.id} role="option" tabIndex={0} aria-selected={t.id === from} className="tm-option" onClick={() => void pick(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') void pick(t.id); }}>{t.code} {t.name}</li>
          ))}
        </ul>
        {from ? (
          <ul className="catalog-plain-list" aria-label="Parameters to copy">
            {list.map((a) => (
              <li key={String(a['id'])} className="lims-inline catalog-gap-2">
                <span>{String(a['code'])} {String(a['name'])}</span>
                <Button size="sm" isDisabled={taken.has(String(a['code']))} onPress={() => void copy(a)}>Copy into this test</Button>
              </li>
            ))}
            {list.length === 0 ? <li className="lims-description">That test has no parameters.</li> : null}
          </ul>
        ) : null}
        {error ? <p role="alert" className="lims-error">{error}</p> : null}
        <p className="lims-description">The copy is a new parameter of this test with the same settings; its reference ranges are added separately as a draft.</p>
      </div>
    </Dialog>
  );
}
