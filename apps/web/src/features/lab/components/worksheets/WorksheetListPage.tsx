'use client';
// SCR worksheets list (04-UI-UX §1 nav "Worksheets | /lab/worksheets | lab.worklist.read"; PRD AC-07.4): #21 listWorksheets, keyset "Load more".
// Ids are never shown raw (D-14); each title links to the print view (#22).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import { listWorksheetsAction } from '../../server/worklist.actions';
import type { ActionResult, WorksheetSummary } from '../../server/types';
import { ListTable, NUM, utc } from '../shared';

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
      {/* T0D-ELABMENU-3 (LD-340): heading = ElabAssist menu label, drawn by the shared PageHeader */}
      <PageHeader title={t('lab.nav.worksheets')} helpKey="lab.worklists" />
      {load.s === 'loading' ? <p role="status">Loading…</p> : null}
      {/* T0D-UILIST-1 (LD-353 template 1, rules 5 and 6): the header row is always drawn; empty, failure and not-available sit in the table body */}
      <ListTable caption="Worksheets" cols={3} empty="No worksheets."
        head={<><th scope="col">Title</th><th scope="col">Created</th><th scope="col" className={NUM}>Rows</th></>}
        fail={load.s === 'fail' ? load.r : undefined} onRetry={retry}
        rows={load.s === 'ok' ? load.rows.map((w) => (
          <tr key={w.id}>
            <td><a href={`/lab/worksheets/${encodeURIComponent(w.id)}`}>{w.title}</a></td>
            <td>{utc(w.created_at)}</td>
            <td className={NUM}>{' '}{w.row_count}</td>{/* leading space keeps the count a separate word in the row's text (after "UTC") */}
          </tr>
        )) : undefined} />
      {load.s === 'ok' && load.next ? <Button variant="secondary" onPress={more}>Load more</Button> : null}
    </section>
  );
}
