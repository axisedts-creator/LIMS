'use client';
// T0D-TESTMGMT-1 item (2), LD-318 (ElabAssist Test Details): two panes on /catalog/tests?view=details[&test=<id>].
// Left: tests with a search box (name, display name, short name, code; tags through the test detail because OrderableSummary has no
// tags), 25 per page. Right: parameters of the chosen test (Name · Sub heading · Short name) in sort order; New parameter, Edit parameter,
// Add existing parameter to this test, Add space, Remove (confirm; PATCH is_active:false, never DELETE), Move up / Move down and
// Alt+ArrowUp / Alt+ArrowDown (swap sort_order with the neighbour, both PATCHed with If-Match). Headings and columns show when empty.
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { createAnalyteFullAction, otherAnalytesAction, testTagsAction, updateAnalyteFullAction, type OtherAnalyte } from '../server/testMgmtActions';
import { FailBanner, newKey, PERM, type Fail } from './shared';
import './catalog.css';

const PAGE = 25;
type Rec = Record<string, any>;
export interface DetailsTest { id: string; code: string; name: string; short_name?: string | undefined; display_name?: string | undefined }
export interface DetailsParam { id: string; code: string; name: string; print_name?: string; report_subheading?: string; sort_order: number; version: number; current_version?: Rec }

const VERSION_COPY = ['result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'default_value', 'long_text_value', 'high_low', 'require_verification'] as const;
/** The clinical definition of another test's parameter, without its formula (a formula names that test's parameters). */
const copyVersion = (v: Rec) => Object.fromEntries(VERSION_COPY.filter((k) => v[k] !== undefined && v[k] !== null && v[k] !== '').map((k) => [k, v[k]]));
const DUP = 'This code is already used in this test.';
const TEST_COLS: readonly ColumnDef<DetailsTest>[] = [
  { id: 'name', header: 'Test', cell: (t) => t.name, isRowHeader: true },
  { id: 'code', header: 'Code', cell: (t) => t.code },
];
const PARAM_COLS: readonly ColumnDef<DetailsParam>[] = [
  { id: 'name', header: 'Name', cell: (a) => a.name, isRowHeader: true },
  { id: 'sub', header: 'Sub heading', cell: (a) => a.report_subheading ?? '' },
  { id: 'code', header: 'Short name', cell: (a) => a.code },
];

export function TestDetailsView({ tests, selected, permissions }: { tests: readonly DetailsTest[]; selected?: { id: string; name: string; analytes: readonly DetailsParam[] } | undefined; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const manage = permissions.includes(PERM.manage);
  const ids = { tests: useId(), params: useId() };
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [tags, setTags] = useState<Record<string, string[]> | null>(null);
  const asked = useRef(false);
  const [chosen, setChosen] = useState<string>();
  const [fail, setFail] = useState<Fail>();
  const [note, setNote] = useState<string>();
  const [dialog, setDialog] = useState<'remove' | 'existing' | null>(null);
  const busy = useRef(false);

  const needle = q.trim().toLowerCase();
  useEffect(() => {
    if (!needle || asked.current || tests.length === 0) return;
    asked.current = true; // one lookup per page view; ponytail: N+1 detail reads until the list API returns tags
    void testTagsAction(tests.map((t) => t.id)).then((r) => { if (r.ok) setTags(r.data); });
  }, [needle, tests]);
  const shown = tests.filter((t) => !needle || [t.name, t.code, t.short_name, t.display_name, ...(tags?.[t.id] ?? [])].some((x) => !!x && x.toLowerCase().includes(needle)));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages);
  const paged = shown.slice((cur - 1) * PAGE, cur * PAGE);

  const params = [...(selected?.analytes ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const at = params.findIndex((a) => a.id === chosen);
  const base = selected ? `/catalog/tests/${selected.id}` : '';

  const act = async (f: () => Promise<boolean>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (await f()) router.refresh();
    } finally {
      busy.current = false;
    }
  };
  const failed = (r: Fail) => { if (r.code === 'catalog.code_duplicate') { setNote(DUP); setFail(undefined); } else { setFail(r); setNote(undefined); } return false; };
  const move = (i: number, dir: 1 | -1) => act(async () => {
    const a = params[i];
    const b = params[i + dir];
    if (!manage || !a || !b) return false;
    // Review fix: analytes may share sort_order (API default 100), so a swap can be a no-op. Renumber to (index+1)*10 instead.
    const order = [...params];
    order[i] = b;
    order[i + dir] = a;
    for (const [k, p] of order.entries()) {
      const want = (k + 1) * 10;
      if (p.sort_order === want) continue;
      const r = await updateAnalyteFullAction(p.id, p.version, { sort_order: want });
      if (!r.ok) return failed(r);
    }
    setFail(undefined);
    toast.show({ tone: 'success', title: 'Order saved.' });
    return true;
  });
  const addSpace = () => act(async () => {
    if (!selected) return false;
    const used = new Set(params.map((p) => p.code));
    let n = 1;
    while (used.has(`SPACE${n}`)) n++;
    const top = params.reduce((m, p) => Math.max(m, p.sort_order), 0);
    const r = await createAnalyteFullAction(selected.id, { code: `SPACE${n}`, name: 'Space', sort_order: Math.min(9999, top + 10), initial_version: { result_type: 'space' } }, newKey());
    if (!r.ok) return failed(r);
    setFail(undefined); setNote(undefined);
    toast.show({ tone: 'success', title: 'Space added.' });
    return true;
  });
  const remove = () => act(async () => {
    const a = params[at];
    setDialog(null);
    if (!a) return false;
    const r = await updateAnalyteFullAction(a.id, a.version, { is_active: false });
    if (!r.ok) return failed(r);
    setChosen(undefined);
    toast.show({ tone: 'success', title: `Parameter ${a.code} removed from this test.` });
    return true;
  });

  return (
    <div className="catalog-two-pane">
      {/* T0D-UIGUARD-1-CATALOG (LD-436 R7): each pane is a kit Card region with its title row, no raw h2 */}
      <div className="catalog-pane">
      <Card title="Tests" region>
        <input type="search" className="lims-input" aria-label="Search tests" placeholder="Name, short name, code or tag" maxLength={100} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        {/* LD-442 (T0D-UIX-2): kit DataTable; a click or Enter on a row opens that test (consoleSelection marks it aria-selected). */}
        <DataTable
          caption="Tests"
          density="compact"
          columns={TEST_COLS}
          rows={paged}
          getRowId={(t) => t.id}
          emptyState={{ title: tests.length === 0 ? 'No tests yet.' : 'No test matches the search.' }}
          consoleSelection={{ selectedId: selected?.id, onSelect: (id) => router.push(`/catalog/tests?view=details&test=${id}`) }}
        />
        {pages > 1 ? (
          <div className="lims-inline catalog-gap-2">
            {cur > 1 ? <a href={`/catalog/tests?view=details`} onClick={(e) => { e.preventDefault(); setPage(cur - 1); }}>Previous</a> : null}
            <span>{`Page ${cur} of ${pages}`}</span>
            {cur < pages ? <a href={`/catalog/tests?view=details`} onClick={(e) => { e.preventDefault(); setPage(cur + 1); }}>Next</a> : null}
          </div>
        ) : null}
      </Card>
      </div>

      <div className="catalog-pane">
      <Card title="Parameters" region>
        <div className="lims-inline catalog-gap-1 catalog-wrap">
          <Button size="sm" variant="primary" isDisabled={!selected || !manage} onPress={() => router.push(`${base}?tab=analytes&analyte=new`)}>New parameter</Button>
          <Button size="sm" isDisabled={at < 0} onPress={() => router.push(`${base}?tab=analytes&analyte=${chosen}`)}>Edit parameter</Button>
          <Button size="sm" isDisabled={!selected || !manage} onPress={() => setDialog('existing')}>Add existing parameter to this test</Button>
          <Button size="sm" isDisabled={!selected || !manage} onPress={() => void addSpace()}>Add space</Button>
          <Button size="sm" variant="danger" isDisabled={at < 0 || !manage} onPress={() => setDialog('remove')}>Remove</Button>
          <Button size="sm" isDisabled={at <= 0 || !manage} onPress={() => void move(at, -1)}>Move up</Button>
          <Button size="sm" isDisabled={at < 0 || at >= params.length - 1 || !manage} onPress={() => void move(at, 1)}>Move down</Button>
        </div>
        {fail ? <FailBanner fail={fail} /> : null}
        {note ? <p role="alert" className="lims-error">{note}</p> : null}
        {/* LD-442: kit DataTable; click / Enter chooses a row, Alt+ArrowUp / Alt+ArrowDown on a row moves it (caught before the grid's own arrows). */}
        <div
          onKeyDownCapture={(e) => {
            if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            const id = (e.target as HTMLElement).closest?.('[data-row-id]')?.getAttribute('data-row-id');
            const i = params.findIndex((p) => p.id === id);
            if (i < 0) return;
            e.preventDefault();
            e.stopPropagation();
            setChosen(params[i]!.id);
            void move(i, e.key === 'ArrowDown' ? 1 : -1);
          }}
        >
          <DataTable
            caption={selected ? `Parameters of ${selected.name}` : 'Parameters'}
            density="compact"
            columns={PARAM_COLS}
            rows={params}
            getRowId={(a) => a.id}
            emptyState={{ title: !selected ? 'Select a test on the left to see its parameters.' : 'This test has no parameters yet.' }}
            consoleSelection={{ selectedId: chosen, onSelect: setChosen }}
          />
        </div>
      </Card>
      </div>

      {dialog === 'remove' && at >= 0 ? (
        <Dialog
          title="Remove parameter"
          isOpen
          size="sm"
          onClose={() => setDialog(null)}
          footer={<><Button variant="ghost" onPress={() => setDialog(null)}>Cancel</Button><Button variant="danger" onPress={() => void remove()}>Remove</Button></>}
        >
          <p>{`${params[at]!.name} (${params[at]!.code}) is taken off this test. It is deactivated, not deleted: results already saved keep it.`}</p>
        </Dialog>
      ) : null}
      {dialog === 'existing' && selected ? (
        <AddExistingDialog testId={selected.id} params={params} onClose={() => setDialog(null)} onDone={() => { setDialog(null); router.refresh(); }} onFail={failed} />
      ) : null}
    </div>
  );
}

function AddExistingDialog({ testId, params, onClose, onDone, onFail }: { testId: string; params: readonly DetailsParam[]; onClose: () => void; onDone: () => void; onFail: (r: Fail) => boolean }) {
  const toast = useToast();
  const [all, setAll] = useState<OtherAnalyte[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void otherAnalytesAction(testId).then((r) => { if (live) { if (r.ok) setAll(r.data); else setError(true); } });
    return () => { live = false; };
  }, [testId]);
  const f = filter.trim().toLowerCase();
  const shown = (all ?? []).filter((a) => !f || `${a.code} ${a.name} ${a.test_name}`.toLowerCase().includes(f)).slice(0, 100);
  const add = async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      let top = params.reduce((m, p) => Math.max(m, p.sort_order), 0);
      for (const a of (all ?? []).filter((x) => picked.has(x.id))) {
        top = Math.min(9999, top + 10);
        const r = await createAnalyteFullAction(testId, {
          code: a.code, name: a.name, ...(a.print_name ? { print_name: a.print_name } : {}), ...(a.report_subheading ? { report_subheading: a.report_subheading } : {}),
          sort_order: top, initial_version: copyVersion(a.version),
        }, newKey());
        if (!r.ok) { onClose(); onFail(r); return; }
      }
      toast.show({ tone: 'success', title: `${picked.size} parameter${picked.size === 1 ? '' : 's'} added.` });
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Add existing parameter to this test"
      isOpen
      size="md"
      onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isDisabled={picked.size === 0} isLoading={busy} onPress={() => void add()}>Add</Button></>}
    >
      <input type="search" className="lims-input" aria-label="Filter parameters" placeholder="Code, name or test" maxLength={100} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {error ? <p role="alert">The parameters of the other tests could not be loaded.</p> : all === null ? <p>Loading…</p> : shown.length === 0 ? <p>No parameter found.</p> : null}
      <div role="list" className="catalog-plain-list catalog-pick-list">
        {shown.map((a) => (
          <div role="listitem" key={a.id}>
            <label className="catalog-check">
              <input type="checkbox" checked={picked.has(a.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} />
              {`${a.name} (${a.code}, ${a.test_name})`}
            </label>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
