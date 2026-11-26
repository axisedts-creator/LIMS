'use client';
// SCR worklist of one department (PRD AC-07.1/07.2/07.4; 03-APP-FLOW §3.4; 04-UI-UX §3.4). Urgent shows "★ Urgent" as text. The instrument filter lists C7 names (E23, via the BFF);
// on 403 it is hidden and nothing is typed free (08 A13 D-14). "Create worksheet" is a UI hint: lab.worksheet.manage is enforced by the API.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import type { ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { t } from '@/core/i18n/messages';
import { createWorksheetAction, listInstrumentsAction, listWorklistAction } from '../../server/worklist.actions';
import { getWorklistOrderResultsAction, type WorklistResultsData } from '../../server/actions';
import type { ActionResult, InstrumentOption, WorklistItem } from '../../server/types';
import { ListTable, NO_ACCESS, hhmm, statusLabel, utc } from '../shared';
import { ResultGrid } from '../grid/ResultGrid';

type Load = { s: 'loading' } | { s: 'ok'; rows: WorklistItem[] } | { s: 'fail'; r: Extract<ActionResult<unknown>, { ok: false }> };
type ResultLoad = { s: 'idle' } | { s: 'loading'; orderId: string } | { s: 'ok'; data: WorklistResultsData } | { s: 'fail'; error: string };

export function WorklistPage({ departmentId, permissions }: { departmentId: string; permissions: readonly string[] }) {
  const canManage = permissions.includes('lab.worksheet.manage');
  const [priority, setPriority] = useState('');
  const [instrumentId, setInstrumentId] = useState('');
  const [instruments, setInstruments] = useState<InstrumentOption[]>([]);   // empty (incl. 403) = no filter shown
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<WorklistItem | null>(null);
  const [resultLoad, setResultLoad] = useState<ResultLoad>({ s: 'idle' });
  const rowBtn = useRef(new Map<string, HTMLButtonElement>());
  const panel = useRef<HTMLElement>(null);
  const seq = useRef(0);

  useEffect(() => { void listInstrumentsAction().then((r) => { if (r.ok) setInstruments(r.data); }); }, []);
  useEffect(() => {
    const mine = ++seq.current;                                       // a slow older answer must not overwrite a newer filter
    setLoad({ s: 'loading' });
    void listWorklistAction({ departmentId, ...(priority ? { priority } : {}), ...(instrumentId ? { instrumentId } : {}) }).then((r) => {
      if (mine !== seq.current) return;
      setSelected(new Set());
      setLoad(r.ok ? { s: 'ok', rows: r.data.data } : { s: 'fail', r });
    });
  }, [departmentId, priority, instrumentId, tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);

  const rows = load.s === 'ok' ? load.rows : [];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const now = Date.now();

  const selectRow = useCallback((r: WorklistItem) => {
    setChosen(r);
    setResultLoad({ s: 'loading', orderId: r.order_id });
    void getWorklistOrderResultsAction(r.order_id, departmentId).then((res) => {
      if (res.ok) {
        setResultLoad({ s: 'ok', data: res.data });
      } else {
        setResultLoad({ s: 'fail', error: res.title ?? 'Failed to load results.' });
      }
    });
    setTimeout(() => {
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }, [departmentId]);

  const refreshCurrentResults = useCallback((orderId?: string) => {
    const targetId = orderId ?? chosen?.order_id;
    if (!targetId) return;
    setResultLoad({ s: 'loading', orderId: targetId });
    void getWorklistOrderResultsAction(targetId, departmentId).then((res) => {
      if (res.ok) {
        setResultLoad({ s: 'ok', data: res.data });
      } else {
        setResultLoad({ s: 'fail', error: res.title ?? 'Failed to load results.' });
      }
    });
  }, [chosen?.order_id, departmentId]);

  const closePanel = () => {
    const back = chosen && rowBtn.current.get(chosen.order_test_id);
    setChosen(null);
    setResultLoad({ s: 'idle' });
    back?.focus();
  };

  return (
    <section aria-label="Worklist">
      <style>{`
        .lims-worklist-table tbody tr {
          cursor: pointer;
        }
        .lims-worklist-table tbody tr:hover {
          background-color: rgba(0, 0, 0, 0.03);
        }
        .lims-worklist-table tbody tr[aria-selected="true"],
        .lims-worklist-table tbody tr[data-selected="true"] {
          background-color: rgba(16, 185, 129, 0.08) !important;
          outline: 2px solid rgba(16, 185, 129, 0.5);
        }
      `}</style>
      {/* T0D-UILIST-1 (LD-353 template 1, rule 8): title = the menu label in the PageHeader, the one primary action at right; filters in one filter row */}
      <PageHeader title={t('lab.nav.worklists')} helpKey="lab.worklists"
        {...(canManage ? { actions: <Button variant="primary" isDisabled={selected.size === 0} onPress={() => setCreating(true)}>Create worksheet</Button> } : {})} />
      {/* T0D-UIGUARD-1-LAB (LD-353 rule 2, LD-441): the kit FilterBar row around the two selects */}
      <FilterBar>
        <label className="lims-field">Priority
          <select className="lims-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">All</option><option value="urgent">★ Urgent</option><option value="routine">Routine</option>
          </select>
        </label>
        {instruments.length ? (
          <label className="lims-field">Instrument
            <select className="lims-input" value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
              <option value="">All instruments</option>
              {instruments.map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}
            </select>
          </label>
        ) : null}
      </FilterBar>

      {/* 2-row layout: Row 1 = full width worklist table, Row 2 = full width result viewing/editing box */}
      {load.s !== 'loading' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', marginTop: '1rem' }}>
          {/* Row 1: Full-width Table */}
          <div className="lims-worklist-table" style={{ width: '100%', overflowX: 'auto' }}>
            <ListTable
              caption="Worklist"
              getRowId={(r) => r.order_test_id}
              empty="No pending tests for this department."
              fail={load.s === 'fail' ? load.r : undefined}
              onRetry={retry}
              consoleSelection={{
                selectedId: chosen?.order_test_id,
                onSelect: (id) => {
                  const r = rows.find((x) => x.order_test_id === id);
                  if (r) selectRow(r);
                },
              }}
              onRowAction={(r) => selectRow(r)}
              columns={[
                ...(canManage ? [{ id: 'select', header: 'Select', cell: (r: WorklistItem) => <input type="checkbox" aria-label={`Select ${r.barcode ?? r.registration_no} ${r.test_code}`} checked={selected.has(r.order_test_id)} onChange={() => toggle(r.order_test_id)} /> }] : []),
                { id: 'barcode', header: 'Barcode', isRowHeader: true, cell: (r) => <span style={{ fontWeight: 600 }}>{r.barcode ?? '—'}</span> },
                { id: 'reg', header: 'Reg no', cell: (r) => r.registration_no },
                { id: 'patient', header: 'Patient', cell: (r) => <>{r.patient_display.full_name} <span className="lims-muted">{r.patient_display.age_sex}</span></> },
                { id: 'test', header: 'Test', cell: (r) => <span style={{ fontWeight: 600 }}>{r.test_code}</span> },
                { id: 'priority', header: 'Priority', cell: (r) => (r.priority === 'urgent' ? '★ Urgent' : 'Routine') },
                { id: 'status', header: 'Status', cell: (r) => statusLabel(r.status) },
                { id: 'received', header: 'Received', cell: (r) => utc(r.received_at) },
                { id: 'age', header: 'Age since received', numeric: true, cell: (r) => (r.received_at ? hhmm((now - Date.parse(r.received_at)) / 1000) : '—') },
                { id: 'tat', header: 'TAT target', cell: () => '—' },
                { id: 'entry', header: 'Results', cell: (r) => (
                  <Button
                    ref={(el) => { if (el) rowBtn.current.set(r.order_test_id, el); else rowBtn.current.delete(r.order_test_id); }}
                    variant={chosen?.order_test_id === r.order_test_id ? 'primary' : 'ghost'}
                    size="sm"
                    onPress={() => selectRow(r)}>
                    {chosen?.order_test_id === r.order_test_id ? '● Active' : `${r.result_counts.resulted}/${r.result_counts.total} Resulted`}
                  </Button>
                ) },
              ] satisfies ColumnDef<WorklistItem>[]}
              rows={rows}
            />
          </div>

          {/* Row 2: Full-width Result Box */}
          <aside aria-label="Result entry" ref={panel} style={{ width: '100%' }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } }}>
            <Card title={chosen ? `Result Entry & Review — ${chosen.patient_display.full_name} (Reg: ${chosen.registration_no})` : 'Result Entry & Review'}>
              {chosen ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color, #e5e7eb)', gap: '1rem' }}>
                    <DescriptionList items={[
                      { term: 'Reg no', value: chosen.registration_no },
                      { term: 'Barcode', value: chosen.barcode ?? '—' },
                      { term: 'Patient', value: <>{chosen.patient_display.full_name} <span className="lims-muted">({chosen.patient_display.age_sex})</span></> },
                      { term: 'Test', value: chosen.test_code },
                      { term: 'Status', value: `${chosen.result_counts.resulted} of ${chosen.result_counts.total} resulted (${statusLabel(chosen.status)})` },
                    ]} />
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <Button variant="secondary" size="sm" onPress={() => refreshCurrentResults()}>Refresh results</Button>
                      <Button variant="ghost" size="sm" onPress={closePanel}>Close</Button>
                    </div>
                  </div>

                  {resultLoad.s === 'loading' ? (
                    <div style={{ padding: '2.5rem', textAlign: 'center' }}>
                      <p className="lims-description" style={{ fontSize: '1rem' }}>Loading results for {chosen.registration_no} ({chosen.test_code})...</p>
                    </div>
                  ) : resultLoad.s === 'fail' ? (
                    <div style={{ padding: '2rem', textAlign: 'center' }}>
                      <p style={{ color: '#ef4444', fontWeight: 500 }}>{resultLoad.error}</p>
                      <div style={{ marginTop: '0.75rem' }}>
                        <Button variant="secondary" size="sm" onPress={() => refreshCurrentResults()}>Retry</Button>
                      </div>
                    </div>
                  ) : resultLoad.s === 'ok' ? (
                    <div style={{ width: '100%', marginTop: '0.5rem' }}>
                      <ResultGrid
                        embedded={true}
                        data={resultLoad.data.orderResults}
                        analytes={resultLoad.data.analytes}
                        permissions={permissions}
                        returnReasons={resultLoad.data.returnReasons}
                        amendmentReasons={resultLoad.data.amendmentReasons}
                        onSaved={() => setTick((t) => t + 1)}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style={{ padding: '3rem', textAlign: 'center' }}>
                  <p className="lims-description" style={{ fontSize: '1.05rem', fontWeight: 500, color: 'var(--text-muted, #6b7280)' }}>
                    Select any patient row above to view and enter results
                  </p>
                  <p style={{ fontSize: '0.875rem', marginTop: '0.5rem', color: 'var(--text-muted, #9ca3af)' }}>
                    Click anywhere on a row in the worklist table to immediately open and edit results here.
                  </p>
                </div>
              )}
            </Card>
          </aside>
        </div>
      ) : null}
      {creating ? <CreateDialog departmentId={departmentId} instrumentId={instrumentId} ids={rows.filter((r) => selected.has(r.order_test_id)).map((r) => r.order_test_id)} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function CreateDialog({ departmentId, instrumentId, ids, onClose }: { departmentId: string; instrumentId: string; ids: string[]; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const [key] = useState(() => crypto.randomUUID());            // one Idempotency-Key per dialog open: a retry is the same create (02-CONVENTIONS §4.5)
  const busy = useRef(false);

  const submit = async () => {
    if (busy.current) return;
    if (title.trim() === '') { setError('Enter a title.'); return; }
    busy.current = true;
    setError(undefined);
    try {
      const r = await createWorksheetAction({ title, department_id: departmentId, ...(instrumentId ? { instrument_id: instrumentId } : {}), order_test_ids: ids }, key);
      if (r.ok) { router.push(`/lab/worksheets/${r.data.id}`); return; }
      setError(r.status === 403 ? NO_ACCESS : r.status === 404 ? 'A selected test is no longer available. Reload the worklist.' : `Could not create the worksheet (${r.code}).`);
    } finally { busy.current = false; }
  };

  return (
    <Dialog title="Create worksheet" isOpen onClose={onClose} size="md">
      {error ? <p role="alert">{error}</p> : null}
      <TextField label="Title" name="title" maxLength={80} isRequired value={title} onChange={setTitle} />
      <p>{ids.length} test{ids.length === 1 ? '' : 's'} selected.</p>
      <Button variant="primary" onPress={() => void submit()}>Create</Button>
    </Dialog>
  );
}
