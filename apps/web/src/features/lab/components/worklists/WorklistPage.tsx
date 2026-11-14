'use client';
// SCR worklist of one department (PRD AC-07.1/07.2/07.4; 03-APP-FLOW §3.4; 04-UI-UX §3.4). Urgent shows "★ Urgent" as text. The instrument filter lists C7 names (E23, via the BFF);
// on 403 it is hidden and nothing is typed free (08 A13 D-14). "Create worksheet" is a UI hint: lab.worksheet.manage is enforced by the API.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Dialog } from '@lims/ui/components/Dialog';
import { Grid } from '@lims/ui/components/Grid';
import { TextField } from '@lims/ui/components/TextField';
import { createWorksheetAction, listInstrumentsAction, listWorklistAction } from '../../server/worklist.actions';
import type { ActionResult, InstrumentOption, WorklistItem } from '../../server/types';
import { Failure, NO_ACCESS, hhmm, statusLabel, utc } from '../shared';

type Load = { s: 'loading' } | { s: 'ok'; rows: WorklistItem[] } | { s: 'fail'; r: Extract<ActionResult<unknown>, { ok: false }> };

export function WorklistPage({ departmentId, permissions }: { departmentId: string; permissions: readonly string[] }) {
  const canManage = permissions.includes('lab.worksheet.manage');
  const [priority, setPriority] = useState('');
  const [instrumentId, setInstrumentId] = useState('');
  const [instruments, setInstruments] = useState<InstrumentOption[]>([]);   // empty (incl. 403) = no filter shown
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<WorklistItem | null>(null);   // RS-C5 (LD-140): right panel, facts from the worklist DTO only
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
      setChosen(null);
      setLoad(r.ok ? { s: 'ok', rows: r.data.data } : { s: 'fail', r });
    });
  }, [departmentId, priority, instrumentId, tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);

  const rows = load.s === 'ok' ? load.rows : [];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const now = Date.now();
  useEffect(() => { if (chosen) panel.current?.querySelector('a')?.focus(); }, [chosen]);
  const closePanel = () => { const back = chosen && rowBtn.current.get(chosen.order_test_id); setChosen(null); back?.focus(); };

  return (
    <section aria-label="Worklist">
      <h1>Worklist</h1>
      <div className="lims-toolbar">
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
        {canManage ? <Button variant="primary" isDisabled={selected.size === 0} onPress={() => setCreating(true)}>Create worksheet</Button> : null}
      </div>
      {load.s === 'fail' ? <Failure r={load.r} onRetry={retry} /> : null}
      {load.s === 'ok' && rows.length === 0 ? <div className="lims-state"><p className="lims-state-title">No pending tests for this department.</p></div> : null}
      {load.s === 'ok' && rows.length > 0 ? (
        <Grid columns={2}>
        <div>
        <table className="lims-table" aria-label="Worklist">
          <thead><tr>
            {canManage ? <th scope="col"><span className="lims-visually-hidden">Select</span></th> : null}
            <th scope="col">Barcode</th><th scope="col">Reg no</th><th scope="col">Patient</th><th scope="col">Test</th><th scope="col">Priority</th>
            <th scope="col">Status</th><th scope="col">Received</th><th scope="col">Age since received</th><th scope="col">TAT target</th><th scope="col">Result entry</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.order_test_id}>
                {canManage ? <td><input type="checkbox" aria-label={`Select ${r.barcode ?? r.registration_no} ${r.test_code}`} checked={selected.has(r.order_test_id)} onChange={() => toggle(r.order_test_id)} /></td> : null}
                <td>{r.barcode ?? '—'}</td>
                <td>{r.registration_no}</td>
                <td>{r.patient_display.full_name} <span className="lims-muted">{r.patient_display.age_sex}</span></td>
                <td>{r.test_code}</td>
                <td>{r.priority === 'urgent' ? '★ Urgent' : ''}</td>
                <td>{statusLabel(r.status)}</td>
                <td>{utc(r.received_at)}</td>
                <td>{r.received_at ? hhmm((now - Date.parse(r.received_at)) / 1000) : '—'}</td>
                <td>—</td>{/* the worklist DTO carries no TAT target (#19 does) */}
                <td>
                  <Button ref={(el) => { if (el) rowBtn.current.set(r.order_test_id, el); else rowBtn.current.delete(r.order_test_id); }} variant="ghost" size="sm" onPress={() => setChosen(r)}>
                    {`Enter results ${r.barcode ?? r.registration_no} ${r.test_code}`}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <aside aria-label="Result entry" ref={panel} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } }}>
          <Card title="Result entry">
            {chosen ? (
              <>
                <dl>
                  <dt>Reg no</dt><dd>{chosen.registration_no}</dd>
                  <dt>Patient</dt><dd>{chosen.patient_display.full_name} <span className="lims-muted">{chosen.patient_display.age_sex}</span></dd>
                  <dt>Test</dt><dd>{chosen.test_code}</dd>
                </dl>
                <p>{chosen.result_counts.resulted} of {chosen.result_counts.total} resulted</p>
                <Link href={`/lab/orders/${chosen.order_id}/results`}>Open result entry</Link>
                <Button variant="ghost" onPress={closePanel}>Close panel</Button>
              </>
            ) : <p className="lims-description">Select a sample to enter results</p>}
          </Card>
        </aside>
        </Grid>
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
