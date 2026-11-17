'use client';
// SCR worksheets list (04-UI-UX §1 nav "Worksheets | /lab/worksheets | lab.worklist.read"; PRD AC-07.4): #21 listWorksheets, keyset "Load more".
// Ids are never shown raw (D-14); each title links to the print view (#22).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { listWorksheetsAction } from '../../server/worklist.actions';
import type { ActionResult, WorksheetSummary } from '../../server/types';
import { Failure, utc } from '../shared';

type Load = { s: 'loading' } | { s: 'ok'; rows: WorksheetSummary[]; next?: string } | { s: 'fail'; r: Extract<ActionResult<unknown>, { ok: false }> };

export function WorksheetListPage({ permissions: _permissions }: { permissions?: readonly string[] }) {
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoad({ s: 'loading' });
    void listWorksheetsAction().then((r) => { if (mine === seq.current) setLoad(r.ok ? { s: 'ok', rows: r.data.data, ...(r.data.page.next_cursor ? { next: r.data.page.next_cursor } : {}) } : { s: 'fail', r }); });
  }, [tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  const more = useCallback(() => {
    if (load.s !== 'ok' || !load.next) return;
    const mine = ++seq.current, prev = load.rows;
    void listWorksheetsAction({ cursor: load.next }).then((r) => {
      if (mine === seq.current) setLoad(r.ok ? { s: 'ok', rows: [...prev, ...r.data.data], ...(r.data.page.next_cursor ? { next: r.data.page.next_cursor } : {}) } : { s: 'fail', r });
    });
  }, [load]);

  return (
    <section aria-label="Worksheets">
      <h1>Worksheets</h1>
      {load.s === 'loading' ? <p role="status">Loading…</p> : null}
      {load.s === 'fail' ? <Failure r={load.r} onRetry={retry} /> : null}
      {load.s === 'ok' && load.rows.length === 0 ? <div className="lims-state"><p className="lims-state-title">No worksheets.</p></div> : null}
      {load.s === 'ok' && load.rows.length > 0 ? (
        <table className="lims-table" aria-label="Worksheets">
          <thead><tr><th scope="col">Title</th><th scope="col">Created</th><th scope="col">Rows</th></tr></thead>
          <tbody>
            {load.rows.map((w) => (
              <tr key={w.id}>
                <td><a href={`/lab/worksheets/${encodeURIComponent(w.id)}`}>{w.title}</a></td>
                <td>{utc(w.created_at)}</td>
                <td>{' '}{w.row_count}</td>{/* leading space keeps the count a separate word in the row's text (after "UTC") */}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {load.s === 'ok' && load.next ? <Button variant="secondary" onPress={more}>Load more</Button> : null}
    </section>
  );
}
