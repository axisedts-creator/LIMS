'use client';
// 04-UI-UX §2.10 TAT alerts. LD-140 (2026-11-13): @lims/ui components and tokens only; every level shows tone, icon and word. PageShell comes from the (staff) layout.
// AC-14.6 acknowledged by/at + "New level since acknowledgement"; AC-14.7 the rows are exactly what the API returned (centre scoping is RLS, never filtered here); AC-14.8 every row names its segment.
// Writes need quality.tat_alert.ack (the server decides; buttons are only hidden). Polls every 30 s while the tab is visible (04-UI-UX §1).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { Tooltip } from '@lims/ui/components/Tooltip';
import { usePolled } from '../components/polling';
import { ConnectionLost, UpdatedAt, qs } from '../components/Shared';
import { FormDialog, err, useSetupAction } from '../forms/fields';
import type { ListPage, TatAlert } from '../types';
import { acknowledgeTatAction, pollTatAction } from './actions';
import { SEGMENT_SHORT, TAT_LEVEL, buildRoute, isReRaised, outranksAck, tatDuration } from './format';

type Iso = DateTextProps['value'];
const POLL_MS = 30_000;
const BASE = '/quality/tat-alerts';
const LEVEL_OPTIONS = (['warning', 'breached', 'escalated'] as const).map((l) => ({ value: l, label: TAT_LEVEL[l].label }));
const SEGMENT_OPTIONS = (Object.keys(SEGMENT_SHORT) as TatAlert['segment'][]).map((s) => ({ value: s, label: SEGMENT_SHORT[s] }));
const PRIORITY_OPTIONS = [{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }];

export function TatView({ page, generatedAt, sp, canAck }: { page: ListPage<TatAlert>; generatedAt: string; sp: Record<string, string>; canAck: boolean }) {
  const router = useRouter();
  const { data, updatedAt, lost } = usePolled(page, generatedAt, () => pollTatAction(sp), JSON.stringify(sp), POLL_MS);
  const [ackFor, setAckFor] = useState<TatAlert>();
  const rows = data.rows;
  const escalated = rows.filter((r) => r.alert_level === 'escalated').length;

  // Live region: announces only a change of the escalated count, never a plain refresh (04-UI-UX §4).
  const [announce, setAnnounce] = useState('');
  const seen = useRef(escalated);
  useEffect(() => {
    if (escalated === seen.current) return;
    seen.current = escalated;
    setAnnounce(`${escalated} escalated TAT alerts`);
  }, [escalated]);

  const go = (patch: Record<string, string | undefined>) => router.push(`${BASE}${qs({ ...sp, cursor: undefined, ...patch })}`); // a changed filter starts again at the first page
  const filter: FilterValue = { level: sp['level']?.split(','), segment: sp['segment'], priority: sp['priority'] };
  const one = (v: FilterValue[string]) => (typeof v === 'string' ? v : undefined);

  // Row shortcut A (02-TRD §14 keyboard-only): only while a row (not a field or button) has focus.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canAck || e.key.toLowerCase() !== 'a' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input,textarea,select,button,a')) return;
    const id = t.closest('[data-row-id]')?.getAttribute('data-row-id');
    const row = rows.find((r) => r.tat_item_id === id);
    if (row && outranksAck(row)) {
      e.preventDefault();
      setAckFor(row);
    }
  };

  const columns: ColumnDef<TatAlert>[] = [
    {
      id: 'level', header: 'Level',
      cell: (r) => (
        <>
          <StatusChip kind="generic" status={r.alert_level} label={TAT_LEVEL[r.alert_level].label} tone={TAT_LEVEL[r.alert_level].tone} />
          {isReRaised(r) ? <Badge tone="warning">New level since acknowledgement</Badge> : null}
        </>
      ),
    },
    { id: 'test', header: 'Test', isRowHeader: true, cell: (r) => r.test_code },
    { id: 'department', header: 'Department', hideBelow: 'lg', cell: (r) => <IdText value={r.department_id} /> },
    { id: 'priority', header: 'Priority', cell: (r) => (r.priority === 'urgent' ? <Badge tone="danger">Urgent</Badge> : 'Routine') },
    { id: 'centre', header: 'Centre', hideBelow: 'lg', cell: (r) => <IdText value={r.centre_id} /> },
    {
      id: 'segment', header: 'Segment',
      cell: (r) => (
        <Tooltip content={r.segment_label}>
          {/* title: the full definition also reaches touch and text-only readers; the kit tooltip is the keyboard/mouse path */}
          <span tabIndex={0} title={r.segment_label}>{SEGMENT_SHORT[r.segment]}</span>
        </Tooltip>
      ),
    },
    { id: 'started', header: 'Started', hideBelow: 'xl', cell: (r) => (r.started_at ? <DateText value={r.started_at as Iso} withTime /> : '—') },
    { id: 'elapsed', header: 'Elapsed / target', cell: (r) => ` ${tatDuration(r.elapsed_seconds)} / ${tatDuration(r.target_seconds)} ` },
    { id: 'pct', header: '% of target', align: 'end', cell: (r) => ` ${r.pct_of_target} % ` },
    {
      id: 'ack', header: 'Acknowledged',
      cell: (r) => (r.acknowledged_at ? <>{`${r.acknowledged_by_display ?? ''} · `}<DateText value={r.acknowledged_at as Iso} withTime /></> : '—'),
    },
    {
      id: 'actions', header: 'Actions',
      cell: (r) => {
        const href = r.specimen_id ? buildRoute('staff.lab.specimen', { specimen_id: r.specimen_id }) : undefined;
        return (
          <>
            {canAck && outranksAck(r) ? <Button size="sm" variant="secondary" onPress={() => setAckFor(r)}>Acknowledge</Button> : null}
            {href ? <a href={href}>Open specimen</a> : null}
          </>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="TAT alerts" helpKey="quality.tat_alerts" status={<UpdatedAt at={updatedAt} />} />
      <div aria-live="polite" className="lims-visually-hidden">{announce}</div>
      {lost ? <ConnectionLost since={updatedAt} /> : null}
      <FilterBar
        filters={[
          { id: 'level', label: 'Level', kind: 'select', multiple: true, options: LEVEL_OPTIONS },
          { id: 'segment', label: 'Segment', kind: 'select', options: SEGMENT_OPTIONS },
          { id: 'priority', label: 'Priority', kind: 'select', options: PRIORITY_OPTIONS },
        ]}
        value={filter}
        onChange={(v) => go({ level: Array.isArray(v['level']) ? v['level'].join(',') : undefined, segment: one(v['segment']), priority: one(v['priority']) })}
        onReset={() => router.push(BASE)}
      />
      <Checkbox label="Acknowledged only" isSelected={sp['acknowledged'] === 'true'} onChange={(on) => go({ acknowledged: on ? 'true' : undefined })} />
      <div onKeyDown={onKeyDown}>
        <DataTable<TatAlert>
          columns={columns} rows={rows} getRowId={(r) => r.tat_item_id} density="compact" caption="TAT alerts"
          page={{ hasNext: !!data.next, hasPrevious: !!sp['cursor'], onNext: () => go({ cursor: data.next }), onPrevious: () => router.back(), limit: 50 }}
          emptyState={{ title: 'No open TAT alerts.' }}
        />
      </div>
      {ackFor ? <AckDialog row={ackFor} onClose={() => setAckFor(undefined)} /> : null}
    </>
  );
}

/** #50: optional note (≤500). Enter in the note sends it (Shift+Enter is a new line): the keyboard-only path "focus row, A, Enter". */
function AckDialog({ row, onClose }: { row: TatAlert; onClose: () => void }) {
  const act = useSetupAction();
  const [note, setNote] = useState('');
  const submit = async () => {
    const n = note.trim();
    // a record that can no longer be changed (clock stopped meanwhile) is explained in the dialog; the next poll brings the fresh list
    await act.run(`${row.tat_item_id}|${row.version}|${n}`, (k) => acknowledgeTatAction(row.tat_item_id, row.version, n, k), { ok: 'Alert acknowledged', onOk: onClose, refreshOnImmutable: false });
  };
  const enterSends = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || (e.target as HTMLElement).tagName !== 'TEXTAREA') return;
    e.preventDefault();
    e.currentTarget.closest('form')?.requestSubmit();
  };
  return (
    <FormDialog title={`Acknowledge ${row.test_code} alert`} size="sm" submitLabel="Acknowledge" onClose={onClose} onSubmit={submit} general={act.general}>
      <div onKeyDown={enterSends}>
        <TextArea label="Note" name="note" maxLength={500} value={note} onChange={setNote} {...err(act.errors['note'])} />
      </div>
    </FormDialog>
  );
}
