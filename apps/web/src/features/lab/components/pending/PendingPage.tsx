'use client';
// SCR pending list (PRD AC-07.3; 03-APP-FLOW §3.5; 04-UI-UX §3.5): awaiting rows included; an age is never shown without its start point
// ("Age since registered" for awaiting rows, "Age since received" otherwise); "Over target" is a text badge. Read only: needs lab.worklist.read (API enforced).
// T0D-UIDASH-1 (LD-353 template 5, rules 5, 6, 10): one FilterBar (the Over target only switch), StatTiles Pending and Overdue, the table header always drawn,
// a "Pending by department" ChartCard that shows NotAvailable (PendingItem carries no department and this screen does not read getPendingTestsSummary).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { NotAvailable } from '@lims/ui/components/NotAvailable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import { listPendingAction } from '../../server/worklist.actions';
import type { ActionResult, PendingItem } from '../../server/types';
import { ListTable, hhmm, statusLabel } from '../shared';

type Load = { s: 'loading' } | { s: 'ok'; rows: PendingItem[] } | { s: 'fail'; r: Extract<ActionResult<unknown>, { ok: false }> };
const COLUMNS = ['Reg no', 'Patient', 'Test', 'Status', 'Priority', 'TAT target'] as const;

export function PendingPage({ permissions: _permissions }: { permissions?: readonly string[] }) {
  const [overOnly, setOverOnly] = useState(false);
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoad({ s: 'loading' });
    void listPendingAction({ overTarget: overOnly }).then((r) => { if (mine === seq.current) setLoad(r.ok ? { s: 'ok', rows: r.data.data } : { s: 'fail', r }); });
  }, [overOnly, tick]);
  const retry = useCallback(() => setTick((n) => n + 1), []);

  // LD-353 rule 6: an operation that is not built yet is the calm NotAvailable state (keeps the title and the table header), never the red error
  if (load.s === 'fail' && load.r.status === 501) return <NotAvailable title={t('lab.nav.pending')} helpKey="lab.pending" columns={COLUMNS} />;

  const rows = load.s === 'ok' ? load.rows : [];
  const hasRegistered = rows.some((r) => r.age_anchor === 'registered'), hasReceived = rows.some((r) => r.age_anchor === 'received');
  const cols = 6 + (hasRegistered ? 1 : 0) + (hasReceived ? 1 : 0);

  return (
    <section aria-label="Pending tests">
      {/* T0D-ELABMENU-3 (LD-340): heading = ElabAssist menu label, drawn by the shared PageHeader */}
      <PageHeader title={t('lab.nav.pending')} helpKey="lab.pending" />
      {/* T0D-UILIST-1 (LD-353 rule 2): the one filter sits in the filter row */}
      {/* T0D-UIGUARD-1-LAB (LD-353 rule 2, LD-441): the kit FilterBar draws the same role=search row around the screen's own control */}
      <FilterBar>
        {/* a button switch, not the bare checkbox */}
        <button type="button" role="switch" aria-checked={overOnly} className="lims-btn lims-btn-ghost lims-btn-sm" onClick={() => setOverOnly((v) => !v)}>
          Over target only
        </button>
      </FilterBar>
      <StatTileRow>
        <StatTile label="Pending" value={` ${rows.length}`} />
        <StatTile label="Overdue" value={` ${rows.filter((r) => r.over_target).length}`} />
      </StatTileRow>
      <ChartCard title="Pending by department">
        {/* plain text, not the .lims-state EmptyState: the table body holds the page's one EmptyState (T0D-UILIST-1) */}
        <p><strong>Not available yet</strong></p>
        <p className="lims-muted">The pending count per department is not read on this screen yet.</p>
      </ChartCard>
      {/* T0D-UILIST-1 (LD-353 template 1, rules 5 and 6): the header row is always drawn; empty, failure and not-available sit in the table body */}
      <ListTable caption="Pending tests" cols={cols} empty="Nothing pending."
        head={<>
          <th scope="col">Reg no</th><th scope="col">Patient</th><th scope="col">Test</th><th scope="col">Status</th><th scope="col">Priority</th>
          {hasRegistered ? <th scope="col">Age since registered</th> : null}
          {hasReceived ? <th scope="col">Age since received</th> : null}
          <th scope="col">TAT target</th>
        </>}
        fail={load.s === 'fail' ? load.r : undefined} onRetry={retry}
        rows={load.s === 'ok' ? rows.map((r) => (
          <tr key={r.order_test_id}>
            <td>{r.registration_no}</td>
            <td>{r.patient_display.full_name} <span className="lims-muted">{r.patient_display.age_sex}</span></td>
            <td>{r.test_code}</td>
            <td>{statusLabel(r.item_status)}</td>
            <td>{r.priority === 'urgent' ? '★ Urgent' : ''}</td>
            {hasRegistered ? <td>{r.age_anchor === 'registered' ? hhmm(r.age_seconds) : '—'}</td> : null}
            {hasReceived ? <td>{r.age_anchor === 'received' ? hhmm(r.age_seconds) : '—'}</td> : null}
            <td>{hhmm(r.tat_target_seconds)}{r.over_target ? <> <span className="lims-badge lims-tone-danger">Over target</span></> : null}</td>
          </tr>
        )) : undefined} />
    </section>
  );
}
