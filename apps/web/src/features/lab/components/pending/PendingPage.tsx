'use client';
// SCR pending list (PRD AC-07.3; 03-APP-FLOW §3.5; 04-UI-UX §3.5): awaiting rows included; an age is never shown without its start point
// ("Age since registered" for awaiting rows, "Age since received" otherwise); "Over target" is a text badge. Read only: needs lab.worklist.read (API enforced).
import { useCallback, useEffect, useRef, useState } from 'react';
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
      <h1>Pending tests</h1>
      <label><input type="checkbox" checked={overOnly} onChange={(e) => setOverOnly(e.target.checked)} /> Over target only</label>
      {load.s === 'fail' ? <Failure r={load.r} onRetry={retry} /> : null}
      {load.s === 'ok' && rows.length === 0 ? <div className="lims-state"><p className="lims-state-title">Nothing pending.</p></div> : null}
      {load.s === 'ok' && rows.length > 0 ? (
        <table className="lims-table" aria-label="Pending tests">
          <thead><tr>
            <th scope="col">Reg no</th><th scope="col">Patient</th><th scope="col">Test</th><th scope="col">Status</th><th scope="col">Priority</th>
            {hasRegistered ? <th scope="col">Age since registered</th> : null}
            {hasReceived ? <th scope="col">Age since received</th> : null}
            <th scope="col">TAT target</th>
          </tr></thead>
          <tbody>
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
        </table>
      ) : null}
    </section>
  );
}
