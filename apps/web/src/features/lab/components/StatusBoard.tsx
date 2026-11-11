'use client';
// /lab/status-board (04-UI-UX §3.11, 03-APP-FLOW §3.11 + §1.5; PRD AC-18.1): one row per order, board status as StatusChip (generic), "Sample rejected" badge, urgent ★, released at.
// Auto-refresh every 30 s by polling through the server action (the JWT never reaches the browser, REQ-SEC-068) with "Updated {time}" and a pause toggle.
// No patient / order identifier is ever placed in a URL or in browser storage (REQ-SEC-098).
// [CONV] "(partial)" / "(preliminary)" chip variants and the "last change" column wait for a release-kind / change-time field in StatusBoardRow (CR-C5-T27-001, .orchestra/cr/C5.T-27.nonblocking.md).
// Paging (review C5.T-27 #1, AC-18.1 "per order"): page.next_cursor shows "Load more", which appends the next page; a poll or filter change restarts at page 1..
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { getStatusBoardAction } from '../server/actions';
import { BOARD_STATUSES, type BoardStatus, type StatusBoardRow } from '../server/types';
import { call, FAILED } from './shared';

const POLL_MS = 30_000;
const MAX_SPAN_MS = 7 * 86_400_000;
const LABEL: Record<BoardStatus, string> = { waiting: 'Waiting', collected: 'Collected', in_lab: 'In lab', ready: 'Ready', printed: 'Printed' };
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const TONE: Record<BoardStatus, Tone> = { waiting: 'neutral', collected: 'info', in_lab: 'info', ready: 'warning', printed: 'success' };
const RANGE_ERROR = 'Choose a period of at most 7 days, ending on or after the start date.';

export interface StatusBoardProps {
  centres: readonly { id: string; name: string }[];
  initialRows: readonly StatusBoardRow[];
  initialNextCursor?: string;
  initialRange: { from: string; to: string };
  permissions: readonly string[];
}

const clock = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stamp = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const pad = (n: number) => String(n).padStart(2, '0');
const dayInput = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Local calendar day boundaries as ISO UTC (the date inputs speak local days; the API speaks instants). */
const startOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!, 0, 0, 0, 0).toISOString(); };
const endOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString(); };

export function StatusBoard(props: StatusBoardProps) {
  return props.permissions.includes('lab.status_board.read') ? <Board {...props} /> : <p role="alert">{"You don't have access to this screen."}</p>;
}

function Board({ centres, initialRows, initialNextCursor, initialRange }: StatusBoardProps) {
  const [rows, setRows] = useState<readonly StatusBoardRow[]>(initialRows);
  const [next, setNext] = useState<string | undefined>(initialNextCursor);
  const [centreId, setCentreId] = useState('');
  const [statuses, setStatuses] = useState<readonly BoardStatus[]>([]);
  const [range, setRange] = useState(initialRange);
  const [fromDay, setFromDay] = useState(() => dayInput(initialRange.from));
  const [toDay, setToDay] = useState(() => dayInput(initialRange.to));
  const [rangeErr, setRangeErr] = useState('');
  const [paused, setPaused] = useState(false);
  const [updated, setUpdated] = useState('—');
  const [error, setError] = useState('');
  const seq = useRef(0);
  const live = useRef({ centreId, statuses, range });
  live.current = { centreId, statuses, range };

  /** One refresh with the given (or current) filters; only the newest answer is applied. A failure keeps the rows on screen. */
  /** With a cursor the page is appended ("Load more"); without one the board restarts at page 1. */
  const refresh = useCallback(async (over: Partial<{ centreId: string; statuses: readonly BoardStatus[]; range: { from: string; to: string } }> = {}, cursor?: string) => {
    const f = { ...live.current, ...over };
    const n = ++seq.current;
    const r = await call(getStatusBoardAction({
      registered_at_from: f.range.from, registered_at_to: f.range.to,
      ...(f.centreId ? { centre_id: f.centreId } : {}), ...(f.statuses.length ? { board_status: f.statuses.join(',') } : {}),
      ...(cursor ? { cursor } : {}),
    }));
    if (n !== seq.current) return;
    if (r.ok) {
      const got = r.data.data;
      setRows((prev) => (cursor ? [...prev, ...got.filter((g) => !prev.some((p) => p.order_id === g.order_id))] : got));
      setNext(r.data.page?.next_cursor); setError(''); setUpdated(clock(new Date()));
    } else setError(r.title ?? FAILED);
  }, []);

  useEffect(() => { setUpdated(clock(new Date())); }, []);
  useEffect(() => {
    if (paused) return undefined;
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [paused, refresh]);

  const toggleStatus = (s: BoardStatus) => {
    const next = statuses.includes(s) ? statuses.filter((x) => x !== s) : BOARD_STATUSES.filter((x) => x === s || statuses.includes(x));
    setStatuses(next);
    void refresh({ statuses: next });
  };
  const chooseCentre = (id: string) => { setCentreId(id); void refresh({ centreId: id }); };
  const changeDays = (from: string, to: string) => {
    setFromDay(from); setToDay(to);
    if (!from || !to) return;
    const r = { from: startOf(from), to: endOf(to) };
    const span = Date.parse(r.to) - Date.parse(r.from);
    if (!(span >= 0 && span <= MAX_SPAN_MS)) { setRangeErr(RANGE_ERROR); return; }
    setRangeErr(''); setRange(r); void refresh({ range: r });
  };
  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? '—';

  return (
    <div>
      <PageHeader title="Status board" helpKey="lab.status_board" />
      <div className="lims-filter-bar" role="group" aria-label="Filters">
        <label>From date <input type="date" className="lims-input" value={fromDay} onChange={(e) => changeDays(e.target.value, toDay)} aria-describedby={rangeErr ? 'board-range-err' : undefined} /></label>
        <label>To date <input type="date" className="lims-input" value={toDay} onChange={(e) => changeDays(fromDay, e.target.value)} aria-describedby={rangeErr ? 'board-range-err' : undefined} /></label>
        <label>Centre{' '}
          <select className="lims-input" value={centreId} onChange={(e) => chooseCentre(e.target.value)}>
            <option value="">All my centres</option>
            {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div role="group" aria-label="Status">
          {BOARD_STATUSES.map((s) => (
            <button key={s} type="button" className="lims-btn lims-btn-ghost lims-btn-sm" aria-pressed={statuses.includes(s)} onClick={() => toggleStatus(s)}>{LABEL[s]}</button>
          ))}
        </div>
        <span aria-live="off">Updated {updated}</span>
        <Button size="sm" onPress={() => setPaused((p) => !p)}>{paused ? 'Resume updates' : 'Pause updates'}</Button>
      </div>
      {rangeErr ? <p id="board-range-err" role="alert" className="lims-error">{rangeErr}</p> : null}
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
      {rows.length === 0 ? <EmptyState title="No registrations in this period." /> : (
        <table className="lims-table" aria-label="Order status board">
          <thead>
            <tr>
              <th scope="col">Reg no</th><th scope="col">Patient</th><th scope="col">Centre</th><th scope="col">Status</th><th scope="col">Released at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.order_id}>
                <th scope="row">{r.registration_no}</th>
                <td>{r.patient_display.full_name}{r.patient_display.age_sex ? <> <span>{r.patient_display.age_sex}</span></> : null}</td>
                <td>{centreName(r.centre_id)}</td>
                <td>
                  <StatusChip kind="generic" status={r.board_status} tone={TONE[r.board_status] ?? 'neutral'} label={LABEL[r.board_status] ?? r.board_status} />
                  {r.rejected_specimens > 0 ? <> <Badge tone="danger">Sample rejected</Badge></> : null}
                  {r.priority === 'urgent' ? <> <span role="img" aria-label="Urgent">★</span></> : null}
                </td>
                <td>{stamp(r.last_released_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next ? <Button size="sm" onPress={() => { void refresh({}, next); }}>Load more</Button> : null}
    </div>
  );
}
