'use client';
// /lab/status-board (04-UI-UX §3.11, 03-APP-FLOW §3.11 + §1.5; PRD AC-18.1): one row per order, board status as StatusChip (generic), "Sample rejected" badge, urgent ★, released at.
// Auto-refresh every 30 s by polling through the server action (the JWT never reaches the browser, REQ-SEC-068) with "Updated {time}" and a pause toggle.
// No patient / order identifier is ever placed in a URL or in browser storage (REQ-SEC-098).
// [CONV] "(partial)" / "(preliminary)" chip variants and the "last change" column wait for a release-kind / change-time field in StatusBoardRow (CR-C5-T27-001, .orchestra/cr/C5.T-27.nonblocking.md).
// Paging (review C5.T-27 #1, AC-18.1 "per order"): page.next_cursor shows "Load more", which appends the next page; a poll or filter change restarts at page 1..
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { BarChart } from '@lims/ui/components/BarChart';
import { Button } from '@lims/ui/components/Button';
import { ChartCard } from '@lims/ui/components/ChartCard';
import { StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { getStatusBoardAction } from '../server/actions';
import { BOARD_STATUSES, type BoardStatus, type StatusBoardRow } from '../server/types';
import { call, FAILED } from './shared';
import { domAttrs } from './consoleParts';

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

const COLUMNS = (centreName: (id: string) => string): ColumnDef<StatusBoardRow>[] => [
  { id: 'reg', header: 'Reg no', isRowHeader: true, cell: (r) => r.registration_no },
  { id: 'patient', header: 'Patient', cell: (r) => <>{r.patient_display.full_name}{r.patient_display.age_sex ? <> <span>{r.patient_display.age_sex}</span></> : null}</> },
  { id: 'centre', header: 'Centre', cell: (r) => centreName(r.centre_id) },
  { id: 'status', header: 'Status', cell: (r) => (
    <>
      <StatusChip kind="generic" status={r.board_status} tone={TONE[r.board_status] ?? 'neutral'} label={LABEL[r.board_status] ?? r.board_status} />
      {r.rejected_specimens > 0 ? <> <Badge tone="danger">Sample rejected</Badge></> : null}
      {r.priority === 'urgent' ? <> <span role="img" aria-label="Urgent">★</span></> : null}
    </>
  ) },
  { id: 'released', header: 'Released at', cell: (r) => stamp(r.last_released_at) },
];

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
    // LD-240: no request while the tab is hidden.
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
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

  // T0D-UIDASH-1, LD-353 template 5: the tiles count the rows of the loaded page; each tile is the status filter (replaces the status chips).
  const count = (s: BoardStatus) => rows.filter((r) => r.board_status === s).length;
  // review item 1: the status filter runs on the server, so a status outside the filter is unknown ("—"), never a false 0; "+" while more pages exist.
  const inFilter = (s: BoardStatus) => statuses.length === 0 || statuses.includes(s);
  const shownCount = (s: BoardStatus) => (inFilter(s) ? String(count(s)) + (next ? '+' : '') : '—');

  return (
    <div>
      <PageHeader
        title={t('lab.nav.status_board')}
        helpKey="lab.status_board"
        status={<span aria-live="off">Updated {updated}</span>}
        actions={<Button size="sm" onPress={() => setPaused((p) => !p)}>{paused ? 'Resume updates' : 'Pause updates'}</Button>}
      />
      <StatTileRow>
        {BOARD_STATUSES.map((s) => (
          // the kit StatTile is a div or a link; a filter tile is a toggle button with the same parts (leading space keeps "Ready 1" readable).
          // T0D-UIX-3 (LD-442): the kit Button inside the tile; aria-pressed and the name go on through domAttrs (the kit Button has no aria props).
          <div key={s} className="lims-stat lims-stat-toggle">
            <Button variant="ghost" ref={domAttrs({ 'aria-pressed': String(statuses.includes(s)), 'aria-label': `${LABEL[s]} ${shownCount(s)}` })} onPress={() => toggleStatus(s)}>
              <span className="lims-stat-label">{LABEL[s]}</span>
              <span className="lims-stat-value"> {shownCount(s)}</span>
            </Button>
          </div>
        ))}
      </StatTileRow>
      {/* T0D-UILIST-1 (LD-353 rule 2); T0D-UIGUARD-1-LAB (LD-441): the kit FilterBar draws the search landmark around the screen's own controls */}
      <FilterBar aria-label="Filters">
        <label>From date <input type="date" className="lims-input" value={fromDay} onChange={(e) => changeDays(e.target.value, toDay)} aria-describedby={rangeErr ? 'board-range-err' : undefined} /></label>
        <label>To date <input type="date" className="lims-input" value={toDay} onChange={(e) => changeDays(fromDay, e.target.value)} aria-describedby={rangeErr ? 'board-range-err' : undefined} /></label>
        <label>Centre{' '}
          <select className="lims-input" value={centreId} onChange={(e) => chooseCentre(e.target.value)}>
            <option value="">All my centres</option>
            {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </FilterBar>
      {rangeErr ? <p id="board-range-err" role="alert" className="lims-error">{rangeErr}</p> : null}
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
      {/* T0D-UIX-3 (LD-442): the kit DataTable (header kept when empty, empty message in the body). */}
      <DataTable caption="Order status board" columns={COLUMNS(centreName)} rows={rows} getRowId={(r) => r.order_id} emptyState={{ title: 'No registrations in this period.' }} />
      {next ? <Button size="sm" onPress={() => { void refresh({}, next); }}>Load more</Button> : null}
      {/* merge of T0D-UILIST-1: the chart sits below the order table so the order table stays the page's first table */}
      <ChartCard title="Samples by status" isEmpty={rows.length === 0}>
        {/* [CONV] aria-hidden: the five tiles above carry the same counts to assistive tech, so the chart's hidden data table would only repeat them
            (and make the order table no longer the page's one table) */}
        <div aria-hidden="true">
        <BarChart title="Samples by status" valueFormat="integer" categories={BOARD_STATUSES.map((s) => LABEL[s])} series={[{ id: 'n', label: 'Orders', values: BOARD_STATUSES.map((s) => (inFilter(s) ? count(s) : 0)) }]} />
        </div>
      </ChartCard>
    </div>
  );
}
