'use client';
// SCR pending list (PRD AC-07.3; 03-APP-FLOW §3.5; 04-UI-UX §3.5): awaiting rows included; an age is never shown without its start point
// ("Age since registered" for awaiting rows, "Age since received" otherwise); "Over target" is a text badge. Read only: needs lab.worklist.read (API enforced).
// T0D-UIDASH-1 (LD-353 template 5, rules 5, 6, 10): one FilterBar (the Over target only switch), StatTiles Pending and Overdue, the table header always drawn,
// a "Pending by department" ChartCard that shows NotAvailable (PendingItem carries no department and this screen does not read getPendingTestsSummary).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { NotAvailable } from '@lims/ui/components/NotAvailable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import { listPendingAction } from '../../server/worklist.actions';
import type { ActionResult, PendingItem } from '../../server/types';
import { Failure, hhmm, statusLabel } from '../shared';

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
      <div role="search" className="lims-filter-bar">
        {/* a button switch, not the bare checkbox */}
        <button type="button" role="switch" aria-checked={overOnly} className="lims-btn lims-btn-ghost lims-btn-sm" onClick={() => setOverOnly((v) => !v)}>
          Over target only
        </button>
      </div>
      <StatTileRow>
        <StatTile label="Pending" value={` ${rows.length}`} />
        <StatTile label="Overdue" value={` ${rows.filter((r) => r.over_target).length}`} />
      </StatTileRow>
      <ChartCard title="Pending by department">
        <div className="lims-state">
          <p className="lims-state-title">Not available yet</p>
          <p className="lims-state-body">The pending count per department is not read on this screen yet.</p>
        </div>
      </ChartCard>
      {load.s === 'fail' ? <Failure r={load.r} onRetry={retry} /> : null}
      {/* T0D-EMPTYTBL-1 (LD-310): once loaded the table is always drawn; an empty list shows its message as a body row. LD-353 rule 5: scrolls in its own box. */}
      {load.s === 'ok' ? (
        <div className="lims-data-table"><div className="lims-table-scroll">
        <table className="lims-table" aria-label="Pending tests">
          <thead><tr>
            <th scope="col">Reg no</th><th scope="col">Patient</th><th scope="col">Test</th><th scope="col">Status</th><th scope="col">Priority</th>
            {hasRegistered ? <th scope="col">Age since registered</th> : null}
            {hasReceived ? <th scope="col">Age since received</th> : null}
            <th scope="col">TAT target</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={cols}><EmptyState title="Nothing pending." /></EmptyRow> : null}
            {rows.map((r) => (
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
            ))}
          </tbody>
          {rows.length === 0 ? <PlaceholderRows colSpan={cols} /> : null}
        </table>
        </div></div>
      ) : null}
    </section>
  );
}
