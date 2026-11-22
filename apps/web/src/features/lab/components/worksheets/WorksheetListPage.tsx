'use client';
// SCR worksheets list (04-UI-UX §1 nav "Worksheets | /lab/worksheets | lab.worklist.read"; PRD AC-07.4): #21 listWorksheets, keyset "Load more".
// Ids are never shown raw (D-14); each title links to the print view (#22).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import type { ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import { listWorksheetsAction } from '../../server/worklist.actions';
import type { ActionResult, WorksheetSummary } from '../../server/types';
import { ListTable, utc } from '../shared';

// T0D-UIX-3 (LD-442): kit DataTable columns; Rows is numeric (end aligned, tabular figures)
const COLUMNS: readonly ColumnDef<WorksheetSummary>[] = [
  { id: 'title', header: 'Title', isRowHeader: true, cell: (w) => <a href={`/lab/worksheets/${encodeURIComponent(w.id)}`}>{w.title}</a> },
  { id: 'created', header: 'Created', cell: (w) => utc(w.created_at) },
  { id: 'rows', header: 'Rows', numeric: true, cell: (w) => <>{' '}{w.row_count}</> }, // leading space keeps the count a separate word in the row's text (after "UTC")
];

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
      <ListTable caption="Worksheets" columns={COLUMNS} getRowId={(w) => w.id} empty="No worksheets."
        fail={load.s === 'fail' ? load.r : undefined} onRetry={retry}
        rows={load.s === 'ok' ? load.rows : undefined} />
      {load.s === 'ok' && load.next ? <Button variant="secondary" onPress={more}>Load more</Button> : null}
    </section>
  );
}
