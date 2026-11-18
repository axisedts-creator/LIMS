'use client';
// SCR pending list (PRD AC-07.3; 03-APP-FLOW §3.5; 04-UI-UX §3.5): awaiting rows included; an age is never shown without its start point
// ("Age since registered" for awaiting rows, "Age since received" otherwise); "Over target" is a text badge. Read only: needs lab.worklist.read (API enforced).
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import { listPendingAction } from '../../server/worklist.actions';
import type { ActionResult, PendingItem } from '../../server/types';
import { Failure, hhmm, statusLabel } from '../shared';

type Load = { s: 'loading' } | { s: 'ok'; rows: PendingItem[] } | { s: 'fail'; r: Extract<ActionResult<unknown>, { ok: false }> };

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
  const retry = useCallback(() => setTick((t) => t + 1), []);

  const rows = load.s === 'ok' ? load.rows : [];
  const hasRegistered = rows.some((r) => r.age_anchor === 'registered'), hasReceived = rows.some((r) => r.age_anchor === 'received');

  return (
    <section aria-label="Pending tests">
      {/* T0D-ELABMENU-3 (LD-340): heading = ElabAssist menu label, drawn by the shared PageHeader */}
      <PageHeader title={t('lab.nav.pending')} helpKey="lab.pending" />
      <label><input type="checkbox" checked={overOnly} onChange={(e) => setOverOnly(e.target.checked)} /> Over target only</label>
      {load.s === 'fail' ? <Failure r={load.r} onRetry={retry} /> : null}
      {/* T0D-EMPTYTBL-1 (LD-310): once loaded the table is always drawn; an empty list shows its message as a body row. Loading / failure unchanged. */}
      {load.s === 'ok' ? (
        <table className="lims-table" aria-label="Pending tests">
          <thead><tr>
            <th scope="col">Reg no</th><th scope="col">Patient</th><th scope="col">Test</th><th scope="col">Status</th><th scope="col">Priority</th>
            {hasRegistered ? <th scope="col">Age since registered</th> : null}
            {hasReceived ? <th scope="col">Age since received</th> : null}
            <th scope="col">TAT target</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={6}><EmptyState title="Nothing pending." /></EmptyRow> : null}
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
          {rows.length === 0 ? <PlaceholderRows colSpan={6} /> : null}
        </table>
      ) : null}
    </section>
  );
}
