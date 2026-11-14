'use client';
// 04-UI-UX §2.1 W1 Dispatch board. Plain-JSON props from the server page; every write goes through a server action (the token stays on the server).
// LD-140 (2026-11-13): kit components and tokens only; one primary button per page (none here: the dialogs carry theirs); every status shows tone, icon and word.
// Route reorder is button-based (§2.7): no drag-and-drop, so it is keyboard-operable. Names only: no phone, coordinates or note is read on this board.
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { Grid } from '@lims/ui/components/Grid';
import { Icon } from '@lims/ui/components/Icon';
import { IconButton } from '@lims/ui/components/IconButton';
import { Inline } from '@lims/ui/components/Inline';
import type { MenuProps } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { shortcuts } from '@/core/shortcuts/registry';
import { failText, flagOf, hasPerm, kindLabel, time12, toneIcon, visitStatus } from '../labels';
import { VISIT_KINDS, VISIT_STATUSES } from '../query';
import { resequenceAction } from '../server/actions';
import type { BoardCodes, BoardFilter, Centre, RouteDto, VisitDto } from '../types';
import { AssignDialog } from './AssignDialog';
import { CancelVisitDialog } from './CancelVisitDialog';
import { ScheduleDialog } from './ScheduleDialog';
import { UnassignDialog } from './UnassignDialog';

type Iso = DateTextProps['value'];
type MenuItems = MenuProps['items'];
type DialogKind = 'schedule' | 'assign' | 'cancel' | 'unassign';
interface Dlg { kind: DialogKind; visit: VisitDto }

const BASE = '/homecollection/dispatch';
const ALL = 'all';
const ASSIGN = 'homecollection.visit.assign'; // dispatcher actions
const LABELS = 'lab.specimen.label_print'; // Print labels link (US-05-1)
const STATUS_OPTIONS = VISIT_STATUSES.map((s) => ({ value: s, label: visitStatus(s)[1] }));
const KIND_OPTIONS = [{ value: ALL, label: 'All kinds' }, ...VISIT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))];
const FILTERS: FilterDef[] = [
  { id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS },
  { id: 'kind', label: 'Kind', kind: 'select', options: KIND_OPTIONS },
];

export interface DispatchBoardProps {
  date: string;
  centreId?: string | undefined;
  centres: readonly Centre[];
  visits: readonly VisitDto[];
  routes: readonly RouteDto[];
  permissions: readonly string[];
  codes: BoardCodes;
  filter?: BoardFilter | undefined;
  nextCursor?: string | undefined;
}

const windowText = (v: VisitDto) =>
  v.window_start ? (
    <>
      <DateText value={v.window_start as Iso} withTime />
      {v.window_end ? ` – ${time12(v.window_end)}` : ''}
    </>
  ) : (
    'Not scheduled'
  );

/** Word + tone + icon for a status: never colour alone. */
function VisitStatusCell({ status }: { status: string }) {
  const [tone, label] = visitStatus(status);
  return (
    <Inline gap={1}>
      <Icon name={toneIcon(tone)} />
      <StatusChip kind="generic" status={status} tone={tone} label={label} />
    </Inline>
  );
}

function Flags({ kinds }: { kinds: readonly string[] }) {
  if (!kinds.length) return <>—</>;
  return (
    <Inline gap={1}>
      {kinds.map((k) => {
        const [tone, label] = flagOf(k);
        return (
          <Inline key={k} gap={1}>
            <Icon name={toneIcon(tone)} />
            <Badge tone={tone}>{label}</Badge>
          </Inline>
        );
      })}
    </Inline>
  );
}

/** "collected/expected"; "Tubes: preparing…" while an order exists but its tubes are not in the read model yet (US-05-2). */
function tubesText(v: VisitDto): string {
  const s = v.specimens_summary;
  if (s.expected === 0) return v.order_id ? 'Tubes: preparing…' : '—';
  return `${s.collected}/${s.expected}`;
}

export function DispatchBoard({ date, centreId, centres, visits, routes, permissions, codes, filter, nextCursor }: DispatchBoardProps) {
  const router = useRouter();
  const hasCursor = useSearchParams().has('cursor');
  const canAssign = hasPerm(permissions, ASSIGN);
  const canLabels = hasPerm(permissions, LABELS);
  const f: BoardFilter = filter ?? { status: [] };
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const unassignedBox = useRef<HTMLDivElement>(null);

  const unassigned = visits.filter((v) => v.status === 'unassigned');
  const byId = new Map(visits.map((v) => [v.id, v]));
  const close = () => setDlg(null);
  const open = (v: VisitDto) => router.push(`/homecollection/visits/${v.id}`);

  const go = (o: { date?: string; centreId?: string; filter?: BoardFilter; cursor?: string }) => {
    const nf = o.filter ?? f;
    const p = new URLSearchParams();
    p.set('date', o.date ?? date);
    const c = o.centreId ?? centreId;
    if (c) p.set('centre_id', c);
    if (nf.status.length) p.set('status', nf.status.join(','));
    if (nf.kind) p.set('kind', nf.kind);
    if (nf.has_open_flags) p.set('has_open_flags', 'true');
    if (o.cursor) p.set('cursor', o.cursor);
    return `${BASE}?${p.toString()}`;
  };

  // Page shortcuts (§2.1 Keyboard). Registered once; the handlers read the latest props through a ref.
  const latest = useRef({ unassigned, setDlg, refresh: () => router.refresh() });
  latest.current = { unassigned, setDlg, refresh: () => router.refresh() };
  useEffect(() => {
    const focused = () => {
      const el = document.activeElement;
      if (!el || !unassignedBox.current?.contains(el)) return undefined;
      const id = el.closest('[data-row-id]')?.getAttribute('data-row-id');
      return latest.current.unassigned.find((v) => v.id === id);
    };
    const onRow = (kind: DialogKind) => () => { const v = focused(); if (v) latest.current.setDlg({ kind, visit: v }); };
    return shortcuts.register(
      'homecollection.dispatch',
      { key: 'Alt+D', description: 'Focus the date field', run: () => root.current?.querySelector<HTMLInputElement>('input[name="date"]')?.focus() },
      { key: 'Alt+R', description: 'Refresh the board', run: () => latest.current.refresh() },
      ...(canAssign
        ? [
            { key: 'Alt+A', description: 'Assign the selected unassigned visit', run: onRow('assign') },
            { key: 'Alt+S', description: 'Schedule the selected unassigned visit', run: onRow('schedule') },
          ]
        : []),
    );
  }, [canAssign]);

  const onFilter = (v: FilterValue) => {
    const status = Array.isArray(v['status']) ? (v['status'] as string[]) : [];
    const kind = typeof v['kind'] === 'string' && v['kind'] !== ALL ? (v['kind'] as string) : undefined;
    router.replace(go({ filter: { status, ...(kind ? { kind } : {}), ...(f.has_open_flags ? { has_open_flags: true } : {}) } }));
  };
  const fv: FilterValue = { status: f.status, kind: f.kind ?? ALL };

  const rowItems = (): MenuItems =>
    canAssign
      ? [{ id: 'schedule', label: 'Schedule' }, { id: 'assign', label: 'Assign' }, { id: 'cancel', label: 'Cancel', isDanger: true }, { id: 'open', label: 'Open' }]
      : [{ id: 'open', label: 'Open' }];
  const onMenu = (v: VisitDto, id: string) => {
    if (id === 'open') open(v);
    else if (id === 'schedule' || id === 'assign' || id === 'cancel') setDlg({ kind: id, visit: v });
  };

  const columns: ColumnDef<VisitDto>[] = [
    { id: 'window', header: 'Window', cell: windowText },
    { id: 'patient', header: 'Patient', isRowHeader: true, cell: (v) => v.patient_display_name },
    { id: 'area', header: 'Area', cell: (v) => (v.area_hint ? v.area_hint.slice(0, 60) : '—') },
    { id: 'kind', header: 'Kind', cell: (v) => <StatusChip kind="generic" status={v.kind} tone="neutral" label={kindLabel(v.kind)} /> },
    { id: 'tubes', header: 'Tubes', align: 'end', cell: (v) => (v.specimens_summary.expected ? String(v.specimens_summary.expected) : '—') },
    { id: 'flags', header: 'Flags', cell: (v) => <Flags kinds={v.open_flag_kinds} /> },
  ];

  const visibleRoutes = routes.filter((r) => r.active_visits > 0 || r.visit_ids_in_order.length > 0);
  return (
    <div ref={root}>
      <PageHeader
        title="Home visits" helpKey="homecollection.dispatch"
        actions={
          <Inline gap={2} align="end">
            <DatePicker label="Date" name="date" value={date as IsoDate} onChange={(d) => { if (d && d !== date) router.replace(go({ date: d })); }} />
            {centres.length ? <Select label="Centre" name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(centreId ? { value: centreId } : {})} onChange={(c) => router.replace(go({ centreId: c }))} /> : null}
            <Button onPress={() => router.refresh()}>Refresh</Button>
          </Inline>
        }
      />
      <Inline gap={4} align="end">
        <FilterBar filters={FILTERS} value={fv} onChange={onFilter} onReset={() => router.replace(go({ filter: { status: [] } }))} />
        <Switch label="Needs attention" isSelected={!!f.has_open_flags} onChange={(on) => router.replace(go({ filter: { ...f, ...(on ? { has_open_flags: true } : { has_open_flags: false }) } }))} />
      </Inline>
      <Grid columns={2}>
        <Card title="Unassigned">
          <div ref={unassignedBox}>
            <DataTable<VisitDto>
              caption="Unassigned" columns={columns} rows={unassigned} getRowId={(v) => v.id} density="compact"
              emptyState={{ title: 'No unassigned visits for this date.' }}
              rowActions={() => rowItems()} onRowActionMenu={onMenu}
              onRowAction={(v) => (canAssign ? setDlg({ kind: v.window_start ? 'assign' : 'schedule', visit: v }) : open(v))}
              {...(nextCursor || hasCursor ? { page: { hasNext: !!nextCursor, hasPrevious: hasCursor, onNext: () => nextCursor && router.push(go({ cursor: nextCursor })), onPrevious: () => router.back(), limit: 100 } } : {})}
            />
          </div>
        </Card>
        <section aria-label="Routes">
          <Stack>
            {visibleRoutes.length ? (
              visibleRoutes.map((r) => (
                <RouteCard
                  key={`${r.id}:${r.version}`} route={r} byId={byId} canAssign={canAssign} canLabels={canLabels}
                  onOpen={open} onUnassign={(v) => setDlg({ kind: 'unassign', visit: v })}
                />
              ))
            ) : (
              <EmptyState title="No routes for this date." body="Assigned visits appear here, one card per phlebotomist." />
            )}
          </Stack>
        </section>
      </Grid>
      {dlg?.kind === 'schedule' ? <ScheduleDialog key={`${dlg.visit.id}:${dlg.visit.version}`} visit={dlg.visit} boardDate={date} isOpen onClose={close} /> : null}
      {dlg?.kind === 'assign' ? <AssignDialog key={`${dlg.visit.id}:${dlg.visit.version}`} visit={dlg.visit} centreId={centreId ?? dlg.visit.centre_id} boardDate={date} isOpen onClose={close} /> : null}
      {dlg?.kind === 'cancel' ? <CancelVisitDialog key={`${dlg.visit.id}:${dlg.visit.version}`} visit={dlg.visit} reasons={codes.visit_cancel_reasons} isOpen onClose={close} /> : null}
      {dlg?.kind === 'unassign' ? <UnassignDialog key={`${dlg.visit.id}:${dlg.visit.version}`} visit={dlg.visit} reasons={codes.unassign_reasons} isOpen onClose={close} /> : null}
    </div>
  );
}

interface RouteCardProps {
  route: RouteDto;
  byId: ReadonlyMap<string, VisitDto>;
  canAssign: boolean;
  canLabels: boolean;
  onOpen: (v: VisitDto) => void;
  onUnassign: (v: VisitDto) => void;
}

/** One phlebotomist's route. The order is the server's; moves are local until "Save order" (H11, If-Match = route version). */
function RouteCard({ route, byId, canAssign, canLabels, onOpen, onUnassign }: RouteCardProps) {
  const router = useRouter();
  const toast = useToast();
  const card = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const focusAfter = useRef<{ id: string; dir: 'Move up' | 'Move down' } | undefined>(undefined);
  const [base, setBase] = useState<readonly string[]>(route.visit_ids_in_order);
  const [order, setOrder] = useState<readonly string[]>(route.visit_ids_in_order);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const rows = order.map((id) => byId.get(id)).filter((v): v is VisitDto => !!v);
  const dirty = order.join() !== base.join();

  useEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    focusAfter.current = undefined;
    const row = card.current?.querySelector(`[data-row-id="${want.id}"]`);
    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    const named = (n: string) => buttons.find((b) => b.textContent?.trim() === n && !b.disabled);
    (named(want.dir) ?? named(want.dir === 'Move up' ? 'Move down' : 'Move up'))?.focus();
  }, [order]);

  const move = (v: VisitDto, delta: -1 | 1) => {
    const shown = rows.map((r) => r.id);
    const i = shown.indexOf(v.id);
    const other = shown[i + delta];
    if (other === undefined) return;
    const next = [...order];
    const a = next.indexOf(v.id);
    const b = next.indexOf(other);
    [next[a], next[b]] = [next[b]!, next[a]!];
    focusAfter.current = { id: v.id, dir: delta < 0 ? 'Move up' : 'Move down' };
    setOrder(next);
    setError('');
    setAnnounce(`Moved ${v.patient_display_name} to position ${i + delta + 1} of ${shown.length}.`);
  };

  const save = async () => {
    if (busy.current || !dirty) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const res = await resequenceAction(route.id, route.version, [...order]);
      if (res.ok) {
        setBase(order);
        toast.show({ tone: 'success', title: 'Route order saved.' });
        router.refresh();
      } else {
        setError(res.code === 'common.validation_failed' ? 'The route changed while you were editing. Refresh the board, then set the order again.' : failText(res));
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const columns: ColumnDef<VisitDto>[] = [
    { id: 'seq', header: '#', align: 'end', cell: (v) => String(rows.indexOf(v) + 1) },
    { id: 'window', header: 'Window', cell: windowText },
    { id: 'patient', header: 'Patient', isRowHeader: true, cell: (v) => v.patient_display_name },
    { id: 'status', header: 'Status', cell: (v) => <VisitStatusCell status={v.status} /> },
    { id: 'tubes', header: 'Tubes', align: 'end', cell: tubesText },
    { id: 'flags', header: 'Flags', cell: (v) => <Flags kinds={v.open_flag_kinds} /> },
    {
      id: 'actions', header: 'Actions',
      cell: (v) => (
        <Inline gap={1}>
          {canAssign ? <Button size="sm" variant="ghost" isDisabled={rows[0] === v} onPress={() => move(v, -1)}>Move up</Button> : null}
          {canAssign ? <Button size="sm" variant="ghost" isDisabled={rows[rows.length - 1] === v} onPress={() => move(v, 1)}>Move down</Button> : null}
          {canLabels && v.order_id ? <a className="lims-btn lims-btn-ghost lims-btn-sm" href={`/lab/orders/${v.order_id}/labels`}>Print labels</a> : null}
          {canAssign && (v.status === 'assigned' || v.status === 'in_progress') ? <IconButton label="Unassign" icon="close" onPress={() => onUnassign(v)} /> : null}
          <IconButton label="Open" icon="menu" onPress={() => onOpen(v)} />
        </Inline>
      ),
    },
  ];

  const n = route.active_visits;
  return (
    <div ref={card}>
      <Card title={route.phlebotomist.display_name}>
        <p>
          {`${n} ${n === 1 ? 'visit' : 'visits'} · Phone updated `}
          {route.last_ack_at ? <DateText value={route.last_ack_at as Iso} withTime /> : 'never'}
        </p>
        <DataTable<VisitDto>
          caption={`${route.phlebotomist.display_name} route`} columns={columns} rows={rows} getRowId={(v) => v.id} density="compact"
          emptyState={{ title: 'No visits on this route.' }}
        />
        {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
        <div role="status"><VisuallyHidden>{announce}</VisuallyHidden></div>
        {canAssign ? (
          <Inline justify="end">
            <Button isDisabled={!dirty || saving} onPress={() => void save()}>Save order</Button>
          </Inline>
        ) : null}
      </Card>
    </div>
  );
}
