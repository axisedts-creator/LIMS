'use client';
// SCR-14 Price-list version editor (04-UI-UX §4): kit EditableGrid over the version's items. Edits stay local until Save; Save
// sends only changed rows in batches of ≤ 200 (REQ-SEC-100), each batch with its own Idempotency-Key, and shows per-row results.
// beforeunload is armed only while something is unsaved. Published versions open read-only ("Create new version" copies one).
// Prices are integer paisa end to end (AC-13.8); the client never sends a price it did not parse from the cell.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { EditableGrid, type EditableGridRow } from '@lims/ui/components/EditableGrid';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { searchOrderablesAction } from '../server/catalogActions';
import { createVersionDraftAction, publishVersionAction, removeItemsAction, upsertItemsAction } from '../server/pricingActions';
import { BULK_MAX, formatNpr, parseNpr, type Department, type OrderableSummary, type PriceItem, type PriceListVersion, type PricedOrderable } from '../server/types';
import { errAt, FailBanner, newKey, STATUS_LABEL, STATUS_TONE, type Fail } from './shared';
import { ActionDialog, canManagePrices, useWhen } from './pricing-ui';

const PRICE_ERROR = 'Enter a price between 0.00 and 9,999,999.99 with at most 2 decimals.';
const COLUMNS = [
  { id: 'code', header: 'Code', isReadOnly: true },
  { id: 'name', header: 'Name', isReadOnly: true },
  { id: 'kind', header: 'Kind', isReadOnly: true },
  { id: 'department', header: 'Department', isReadOnly: true },
  { id: 'price', header: 'Price (NPR)', maxLength: 12 },
  { id: 'current', header: 'Current published price', isReadOnly: true },
  { id: 'change', header: 'Change', isReadOnly: true },
] as const;
const chunks = <T,>(xs: readonly T[]): T[][] => Array.from({ length: Math.ceil(xs.length / BULK_MAX) }, (_, i) => xs.slice(i * BULK_MAX, (i + 1) * BULK_MAX));

interface Info { code: string; name: string; kind: 'test' | 'panel'; department_id?: string | undefined }

export function PriceVersionEditor({ priceList, version, items, currentItems, orderables, departments = [], permissions }: {
  priceList: { id: string; code: string; name: string };
  version: PriceListVersion;
  items: readonly PriceItem[];
  currentItems: readonly PriceItem[];
  orderables: readonly PricedOrderable[];
  departments?: readonly Pick<Department, 'id' | 'name'>[];
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const manage = canManagePrices(permissions);
  const editable = manage && version.status === 'draft';

  const [base, setBase] = useState<Readonly<Record<string, number>>>(() => Object.fromEntries(items.map((i) => [i.orderable_id, i.unit_price.amount_paisa])));
  const [order, setOrder] = useState<readonly string[]>(() => items.map((i) => i.orderable_id));
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [added, setAdded] = useState<Readonly<Record<string, Info>>>({});
  const [query, setQuery] = useState('');
  const [fail, setFail] = useState<Fail>();
  const [inUse, setInUse] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0); // remounts the combobox after each pick so its text is cleared
  const saving = useRef(false);

  const info = useMemo(() => {
    const m = new Map<string, Info>();
    for (const i of items) if (i.orderable_code) m.set(i.orderable_id, { code: i.orderable_code, name: '—', kind: i.orderable_kind ?? 'test' });
    for (const o of orderables) m.set(o.id, { code: o.code, name: o.name, kind: o.kind, department_id: o.department_id });
    for (const [id, a] of Object.entries(added)) m.set(id, a);
    return m;
  }, [items, orderables, added]);
  const current = useMemo(() => new Map(currentItems.map((i) => [i.orderable_id, i.unit_price.amount_paisa])), [currentItems]);
  const deptName = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);

  const isNew = (id: string) => base[id] === undefined;
  const dirty = Object.keys(edits).length > 0 || removed.size > 0 || order.some(isNew);

  // Unsaved-changes guard: armed only while dirty; removed on release and on unmount.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const gridRows = useMemo<EditableGridRow[]>(() => {
    const needle = query.trim().toLowerCase();
    return order
      .filter((id) => {
        const x = info.get(id);
        return !needle || (x?.code.toLowerCase().includes(needle) ?? false) || (x?.name.toLowerCase().includes(needle) ?? false);
      })
      .map((id): EditableGridRow => {
        const x = info.get(id);
        const text = edits[id] ?? (base[id] !== undefined ? formatNpr(base[id]!) : '');
        const price = parseNpr(text);
        const cur = current.get(id);
        let change = '—';
        if (price !== undefined && cur !== undefined && cur > 0 && price !== cur) {
          const pct = ((price - cur) / cur) * 100;
          change = `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)} %${Math.abs(price - cur) * 2 > cur ? ' · Large change' : ''}`; // > 50 % (exactly 50 % is not large)
        }
        const err = errors[id];
        const status: EditableGridRow['status'] = err ? 'error' : removed.has(id) || edits[id] !== undefined || isNew(id) ? 'unsaved' : 'saved';
        return {
          id,
          values: { code: x?.code ?? '—', name: x?.name ?? '—', kind: x?.kind === 'panel' ? 'Panel' : 'Test', department: x?.department_id ? (deptName.get(x.department_id) ?? '—') : '—', price: text, current: cur !== undefined ? formatNpr(cur) : '—', change },
          status,
          ...(removed.has(id) && !err ? { statusText: 'Marked for removal' } : {}),
          ...(err ? { errors: { price: err } } : {}),
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, info, edits, base, current, errors, removed, query, deptName]);

  const onCell = (id: string, col: string, value: string) => {
    if (col !== 'price' || !editable) return;
    const text = value.trim();
    setErrors(({ [id]: _, ...rest }) => rest);
    setEdits(({ [id]: _, ...rest }) => (!isNew(id) && parseNpr(text) === base[id] ? rest : { ...rest, [id]: text }));
  };

  // Delete on a focused row toggles "marked for removal" (a row that was never saved is simply dropped).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Delete' || !editable || !(e.target instanceof HTMLElement) || e.target.tagName === 'INPUT') return;
    const idx = Number(e.target.closest('tr')?.getAttribute('aria-rowindex')) - 2;
    const id = gridRows[idx]?.id;
    if (!id) return;
    e.preventDefault();
    if (isNew(id)) {
      setOrder((o) => o.filter((x) => x !== id));
      setEdits(({ [id]: _, ...rest }) => rest);
    } else setRemoved((s) => { const t = new Set(s); if (!t.delete(id)) t.add(id); return t; });
  };

  const save = async () => {
    if (saving.current || !editable) return;
    const bad: Record<string, string> = {};
    const upserts: { orderable_id: string; unit_price: { amount_paisa: number; currency: 'NPR' } }[] = [];
    for (const id of order) {
      if (removed.has(id) || (edits[id] === undefined && !isNew(id))) continue;
      const paisa = parseNpr(edits[id] ?? '');
      if (paisa === undefined) bad[id] = PRICE_ERROR;
      else upserts.push({ orderable_id: id, unit_price: { amount_paisa: paisa, currency: 'NPR' } });
    }
    if (Object.keys(bad).length) return setErrors((e) => ({ ...e, ...bad }));
    const removals = [...removed].filter((id) => !isNew(id));
    if (!upserts.length && !removals.length) return;
    saving.current = true;
    setBusy(true);
    setFail(undefined);
    setInUse(false);
    let ok = true;
    try {
      const apply = (results: { orderable_id: string; outcome: string; error_code?: string }[], sent: readonly string[], onSaved: (id: string) => void) => {
        const rowErr = new Map(results.filter((r) => r.outcome === 'error').map((r) => [r.orderable_id, r.error_code ?? 'error']));
        for (const id of sent) if (!rowErr.has(id)) onSaved(id);
        if (rowErr.size) {
          ok = false;
          setErrors((e) => ({ ...e, ...Object.fromEntries(rowErr) }));
        }
      };
      for (const batch of chunks(upserts)) {
        const r = await upsertItemsAction(version.id, batch, newKey());
        if (!r.ok) {
          ok = false;
          if (r.code === 'catalog.version_in_use') setInUse(true);
          else setFail(r);
          return;
        }
        const paid = Object.fromEntries(batch.map((b) => [b.orderable_id, b.unit_price.amount_paisa]));
        apply(r.data, batch.map((b) => b.orderable_id), (id) => {
          setBase((b) => ({ ...b, [id]: paid[id]! }));
          setEdits(({ [id]: _, ...rest }) => rest);
        });
      }
      for (const batch of chunks(removals)) {
        const r = await removeItemsAction(version.id, batch, newKey());
        if (!r.ok) {
          ok = false;
          if (r.code === 'catalog.version_in_use') setInUse(true);
          else setFail(r);
          return;
        }
        apply(r.data, batch, (id) => {
          setBase(({ [id]: _, ...rest }) => rest);
          setOrder((o) => o.filter((x) => x !== id));
          setRemoved((s) => { const t = new Set(s); t.delete(id); return t; });
        });
      }
      if (ok) {
        toast.show({ tone: 'success', title: 'Prices saved.' });
        router.refresh();
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const [creating, setCreating] = useState(false);
  const newVersion = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const r = await createVersionDraftAction(priceList.id, { copy_from_version_no: version.version_no }, newKey());
      if (r.ok) router.push(`/catalog/price-lists/${priceList.id}/versions/${r.data.id}`);
      else setFail(r);
    } finally {
      setCreating(false);
    }
  };
  const createButton = manage ? <Button variant="primary" isLoading={creating} onPress={newVersion}>Create new version</Button> : null;

  const addOptions = async (q: string): Promise<OrderableSummary[]> => (await searchOrderablesAction(q)).filter((o) => !order.includes(o.id));
  const showDone = done && version.status === 'draft';

  return (
    <section aria-label="Price list version">
      <PageHeader
        title={`${priceList.name} — version ${version.version_no}`}
        helpKey="catalog.price_list_version"
        breadcrumbs={[{ label: 'Pricing' }, { label: 'Price lists' }, { label: priceList.code }, { label: `v${version.version_no}` }]}
        actions={<Badge tone={STATUS_TONE[version.status] ?? 'neutral'}>{STATUS_LABEL[version.status] ?? version.status}</Badge>}
      />
      {showDone ? (
        <div className="lims-stack" role="status">
          <p>This version is now live and read-only.</p>
          <a className="lims-link" href={`/catalog/price-lists/${priceList.id}`}>Back to the price list</a>
        </div>
      ) : (
        <>
          {fail ? <FailBanner fail={fail} /> : null}
          {inUse ? (
            <div role="alert" className="lims-stack">
              <Banner tone="warning" title="This version is already published." />
              {createButton}
            </div>
          ) : null}
          {!editable && manage ? <div className="lims-inline">{createButton}</div> : null}
          <div className="lims-filter-bar">
            <input type="search" className="lims-input" aria-label="Search prices" placeholder="Search code or name" maxLength={100} value={query} onChange={(e) => setQuery(e.target.value)} />
            {editable ? (
              <>
                <Combobox<OrderableSummary>
                  key={n}
                  label="Add orderable"
                  name="add_orderable"
                  loadOptions={addOptions}
                  getKey={(o) => o.id}
                  renderOption={(o) => `${o.code} — ${o.name}${o.kind === 'panel' ? ' (panel)' : ''}`}
                  renderValue={(o) => o.name}
                  onChange={(o) => {
                    if (!o) return;
                    setAdded((a) => ({ ...a, [o.id]: { code: o.code, name: o.name, kind: o.kind, department_id: (o as PricedOrderable).department_id } }));
                    setOrder((x) => [...x, o.id]);
                    setN((x) => x + 1);
                  }}
                />
                <Button variant="primary" isLoading={busy} onPress={save} shortcut="Ctrl+S">Save</Button>
                <Button isDisabled={dirty} onPress={() => setPublishing(true)}>Publish…</Button>
              </>
            ) : null}
          </div>
          {order.length === 0 ? <p>This version has no prices. Add rows or import from Excel.</p> : null}
          {/* Delete is handled on the wrapper: the grid is a roving-tabindex table and only reports cell edits. */}
          <div onKeyDown={onKeyDown}>
            <EditableGrid label="Price list items" columns={COLUMNS} rows={gridRows} onCellChange={onCell} isReadOnly={!editable} />
          </div>
        </>
      )}
      {publishing ? <PublishVersionDialog version={version} onClose={() => setPublishing(false)} onDone={() => setDone(true)} /> : null}
    </section>
  );
}

function PublishVersionDialog({ version, onClose, onDone }: { version: PriceListVersion; onClose: () => void; onDone: () => void }) {
  const when = useWhen();
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      title={`Publish version ${version.version_no}`}
      submit="Publish"
      savedText={`Version ${version.version_no} published.`}
      onClose={onClose}
      onDone={onDone}
      run={(key) => publishVersionAction(version.id, version.version, { effective_from: when.get(), change_reason: reason }, key)}
    >
      {(fail) => (
        <>
          <DateTimePicker label="Effective from" name="effective_from" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_from') ? { error: errAt(fail, '/effective_from')! } : {})} />
          <TextArea label="Change reason" name="change_reason" maxLength={500} isRequired value={reason} onChange={setReason} {...(errAt(fail, '/change_reason') ? { error: errAt(fail, '/change_reason')! } : {})} />
          <p>Requires two-step verification</p>
        </>
      )}
    </ActionDialog>
  );
}
