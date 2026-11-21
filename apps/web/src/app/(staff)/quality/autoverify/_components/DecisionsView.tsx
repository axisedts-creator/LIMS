'use client';
// 04-UI-UX §2.9 decisions list (#46) + row drawer (#47). Read-only. The drawer reads #47 only when a row is opened, because that read writes the access-log
// entry autoverify_decision.view on the API side (07-SECURITY P3). Mode and decision are words with tone and icon; reasons use plain labels. LD-140: @lims/ui only.
import { useId, useRef, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { readDecisionAction } from '../_lib/actions';
import { DASH, DAY, DECISION, MODE, OVERVIEW_HREF, QC, RANGE_FLAG, REASONS, REASON_LABEL, isoMs, nptDate, nptMidnight, qcRunHref, reasonText } from '../_lib/format';
import type { Decision } from '../_lib/types';
import { NativeSelect } from './shared';

type Iso = DateTextProps['value'];
const chip = (map: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }>, v: string) => <StatusChip kind="generic" status={v} label={map[v]?.label ?? v} tone={map[v]?.tone ?? 'neutral'} />;
const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

interface Props {
  rows: Decision[];
  next?: string;
  hasPrevious: boolean;
  problem?: string;
  /** The sanitized URL state (period, filters). */
  sp: Record<string, string>;
}

export function DecisionsView({ rows, next, hasPrevious, problem, sp }: Props) {
  const router = useRouter();
  const [from, setFrom] = useState(nptDate(sp['decided_at_from'] ?? isoMs(Date.now())));
  // the stored "to" is exclusive (the start of the next day), the date control shows the last day included
  const [to, setTo] = useState(nptDate(isoMs(Date.parse(sp['decided_at_to'] ?? isoMs(Date.now() + DAY)) - 1)));
  const [filters, setFilters] = useState({ mode: sp['mode'] ?? '', decision: sp['decision'] ?? '', reason: sp['reason'] ?? '' });
  const [shown, setShown] = useState<Decision>();
  const [detail, setDetail] = useState<{ state: 'loading' } | { state: 'failed' } | { state: 'ready'; row: Decision }>();
  const [gone, setGone] = useState(false);
  const opened = useRef<string | undefined>(undefined);
  const dateId = useId();

  const go = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const put = (k: string, v: string | undefined) => { if (v) q.set(k, v); };
    for (const k of ['analyte_id', 'instrument_id']) put(k, sp[k]); // kept: no control for them yet, but a bookmarked filter must survive
    put('mode', filters.mode); put('decision', filters.decision); put('reason', filters.reason);
    if (from && to) {
      q.set('decided_at_from', isoMs(nptMidnight(from)));
      q.set('decided_at_to', isoMs(nptMidnight(to) + DAY));
    }
    for (const [k, v] of Object.entries(extra)) put(k, v);
    router.push(`${OVERVIEW_HREF}/decisions?${q.toString()}`);
  };

  const open = async (row: Decision) => {
    if (opened.current === row.id) return;
    opened.current = row.id;
    setGone(false);
    setShown(row);
    setDetail({ state: 'loading' });
    const r = await readDecisionAction(row.id);
    if (opened.current !== row.id) return; // another row was opened meanwhile
    if (!r.ok && r.status === 404) { close(); setGone(true); return; } // the row is stale: close the drawer so the page behind it stays usable, and say so on the page
    setDetail(r.ok ? { state: 'ready', row: r.data } : { state: 'failed' });
  };
  const close = () => { opened.current = undefined; setShown(undefined); setDetail(undefined); };
  const onClick = (e: MouseEvent) => {
    const id = (e.target as HTMLElement).closest('[data-row-id]')?.getAttribute('data-row-id');
    const row = rows.find((r) => r.id === id);
    if (row) void open(row);
  };

  const columns: ColumnDef<Decision>[] = [
    { id: 'at', header: 'Decided at', isRowHeader: true, cell: (d) => <DateText value={d.decided_at as Iso} withTime /> },
    { id: 'mode', header: 'Mode', cell: (d) => chip(MODE, d.mode) },
    { id: 'decision', header: 'Decision', cell: (d) => chip(DECISION, d.decision) },
    { id: 'reasons', header: 'Reasons', cell: (d) => reasonText(d.reasons) },
    { id: 'analyte', header: 'Analyte', cell: (d) => <IdText value={d.analyte_id} /> },
    { id: 'instrument', header: 'Instrument', cell: (d) => (d.instrument_id ? <IdText value={d.instrument_id} /> : DASH) },
    { id: 'version', header: 'Version', cell: (d) => (d.version_id ? <IdText value={d.version_id} /> : DASH) },
  ];

  const d = detail?.state === 'ready' ? detail.row : undefined;
  const i = d?.inputs;
  return (
    <>
      <PageHeader title="Auto-verification decisions" helpKey="quality.autoverify_decisions" />
      <div role="search" className="lims-filter-bar">
        <div className="lims-field">
          <label className="lims-label" htmlFor={`${dateId}-from`}>Period from</label>
          <input id={`${dateId}-from`} className="lims-input" type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        </div>
        <div className="lims-field">
          <label className="lims-label" htmlFor={`${dateId}-to`}>Period to</label>
          <input id={`${dateId}-to`} className="lims-input" type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </div>
        <NativeSelect label="Mode" value={filters.mode} onChange={(v) => setFilters((f) => ({ ...f, mode: v }))} placeholder="All modes" options={Object.entries(MODE).map(([value, x]) => ({ value, label: x.label }))} />
        <NativeSelect label="Decision" value={filters.decision} onChange={(v) => setFilters((f) => ({ ...f, decision: v }))} placeholder="All decisions" options={Object.entries(DECISION).map(([value, x]) => ({ value, label: x.label }))} />
        <NativeSelect label="Reason" value={filters.reason} onChange={(v) => setFilters((f) => ({ ...f, reason: v }))} placeholder="All reasons" options={REASONS.map((value) => ({ value, label: REASON_LABEL[value] }))} />
        <Button variant="primary" onPress={() => go({})}>Apply filters</Button>
      </div>
      {problem ? <p role="alert" className="lims-error">{problem}</p> : null}
      {gone ? <Banner tone="warning" title="This decision doesn't exist or isn't in your lab." /> : null}
      {/* the kit table opens a row on Enter and double click; a single click is handled here, so the whole row works like the spec's "Row → Drawer" */}
      <div role="presentation" onClick={onClick}>
        <DataTable<Decision>
          columns={columns} rows={problem ? [] : rows} getRowId={(r) => r.id} density="compact" caption="Decisions" onRowAction={(r) => void open(r)}
          emptyState={{ title: problem ? 'Choose a valid period to see decisions.' : 'No decisions in this period.' }}
          page={{ hasNext: !!next, hasPrevious, limit: 50, onNext: () => go({ cursor: next }), onPrevious: () => go({}) }}
        />
      </div>

      <Drawer title="Decision" isOpen={!!shown} onClose={close} width="md">
        {detail?.state === 'loading' ? <p role="status">Loading…</p> : null}
        {detail?.state === 'failed' ? <ErrorState title="We couldn't load this decision." body="Close the drawer and try again." /> : null}
        {d ? (
          <>
            <DescriptionList items={[
              { term: 'Decided at', value: <DateText value={d.decided_at as Iso} withTime /> },
              { term: 'Mode', value: chip(MODE, d.mode) },
              { term: 'Decision', value: chip(DECISION, d.decision) },
              { term: 'Reasons', value: reasonText(d.reasons) },
              { term: 'Matched rule', value: d.matched_rule_key ?? DASH },
              { term: 'QC status', value: QC[d.qc_status] ?? DASH },
            ]} />
            <h3>Inputs</h3>
            <DescriptionList items={[
              { term: 'Value', value: i?.value_numeric ?? DASH },
              { term: 'Range flag', value: i?.range_flag ? (RANGE_FLAG[i.range_flag] ?? i.range_flag) : DASH },
              { term: 'Delta check failed', value: i ? yesNo(i.delta_check_failed) : DASH },
              { term: 'Critical', value: i ? yesNo(i.is_critical) : DASH },
              { term: 'Instrument flags', value: i?.instrument_flags.length ? i.instrument_flags.join(', ') : DASH },
              { term: 'Resulted at', value: i ? <DateText value={i.resulted_at as Iso} withTime /> : DASH },
            ]} />
            {d.qc_run_id ? <a className="lims-btn lims-btn-secondary" href={qcRunHref(d.qc_run_id)}>Open QC run</a> : null}
          </>
        ) : null}
      </Drawer>
    </>
  );
}
