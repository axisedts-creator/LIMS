'use client';
// 04-UI-UX §2 Micro worklist: PageHeader → scan bar → Tabs → FilterBar → DataTable. AC-02.1 (tabs, filters, columns), AC-02.2 (scan), AC-02.4 (overdue words + icon).
// LD-140 (2026-11-13): kit components and class names only; no hex colours, pixel radii or inline style objects; the worklist has no primary button.
// Server text (test names, codes) renders as text nodes only (REQ-SEC-088). Tab / filter / page state lives in the URL (tab id, filter values, opaque cursor):
// never a barcode or patient data (REQ-SEC-098). The scan runs through a server action; no token or API origin reaches this file.
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { shortcuts } from '@/core/shortcuts/registry';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput, useScanCapture } from '@lims/ui/components/BarcodeInput';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { Icon } from '@lims/ui/components/Icon';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { scanSpecimenAction } from '../../server/lookupSpecimenByBarcode.server';
import type { CentreLite, CultureSummaryDto, ScanResult, SpecimenLite, TabId } from '../../server/types';
import { When } from '../common';
import { ChooseCultureDialog } from './ChooseCultureDialog';
import { CultureStatusChip } from './CultureStatusChip';

const NO_CULTURE = 'No microbiology culture for this specimen.'; // one text for unknown barcode and no culture: no existence oracle (S-02)
const SCAN_FAILED = "We couldn't look that up. Try again.";
const RANGE_TOO_LONG = 'Choose a period of at most 31 days.'; // [CONV] 04-UI-UX §2 Received max 31 days (the kit FilterBar cannot enforce maxDays)

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'setup', label: 'Awaiting setup' },
  { id: 'incubating', label: 'Incubating' },
  { id: 'workup', label: 'Growth / work-up' },
  { id: 'amending', label: 'Amending' },
  { id: 'recent', label: 'Recently submitted' },
];
const DEFAULT_SORT: Record<TabId, string> = { setup: 'received_at', incubating: 'next_read_due_at', workup: 'next_read_due_at', amending: '-updated_at', recent: '-updated_at' };
const emptyTitle = (tab: TabId, days: number) =>
  ({
    setup: 'No specimens waiting for set-up.',
    incubating: 'No cultures incubating.',
    workup: 'No cultures with growth to work up.',
    amending: 'No amendments in progress.',
    recent: `Nothing submitted in the last ${days} days.`,
  })[tab];

const URL_KEYS = ['centre_id', 'received_at_from', 'received_at_to', 'read_overdue', 'has_open_instrument_records', 'sort'] as const;
const YES_NO = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] as const;
const SHORTCUT_PAGE = 'staff.micro.worklist';

export interface WorklistScreenProps {
  tab: TabId;
  cultures: readonly CultureSummaryDto[];
  counts: Partial<Record<TabId, number>>;
  /** null = the user may not list centres (403 / failure): the Centre filter is hidden. */
  centres: readonly CentreLite[] | null;
  specimens: Readonly<Record<string, SpecimenLite>>;
  nextCursor?: string;
  recentWindowDays: number;
  permissions: readonly string[];
}

export function WorklistScreen({ tab, cultures, counts, centres, specimens, nextCursor, recentWindowDays }: WorklistScreenProps) {
  const router = useRouter();
  const search = useSearchParams();
  const wrap = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [notice, setNotice] = useState<'none' | 'error' | undefined>();
  const [choices, setChoices] = useState<Extract<ScanResult, { kind: 'choose' }>['cultures'] | undefined>();
  const [rangeError, setRangeError] = useState(false);

  // ---- URL state: only whitelisted keys are carried; the cursor is always dropped on a change.
  const go = (patch: Record<string, string | undefined>, nextTab: TabId = tab, cursor?: string) => {
    const q = new URLSearchParams({ tab: nextTab });
    for (const k of URL_KEYS) {
      const v = k in patch ? patch[k] : search.get(k) ?? undefined;
      if (v) q.set(k, v);
    }
    if (cursor) q.set('cursor', cursor);
    router.push(`/micro/worklist?${q.toString()}`);
  };

  // ---- scan (AC-02.2)
  const onScan = async (barcode: string) => {
    if (busy.current) return;
    busy.current = true;
    setNotice(undefined);
    setChoices(undefined);
    try {
      const r = await scanSpecimenAction(barcode);
      if (r.kind === 'open') router.push(`/micro/cultures/${r.cultureId}`);
      else if (r.kind === 'choose') setChoices(r.cultures);
      else setNotice(r.kind);
    } catch {
      setNotice('error');
    } finally {
      busy.current = false;
    }
  };
  useScanCapture({ onScan: (v) => void onScan(v), enabled: !choices });

  useEffect(
    () => shortcuts.register(SHORTCUT_PAGE, { key: 'Alt+B', description: 'Scan specimen barcode', run: () => wrap.current?.querySelector('input')?.focus() }),
    [],
  );

  // ---- filters
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : undefined);
  const from = day(search.get('received_at_from'));
  const to = day(search.get('received_at_to'));
  const filterValue: FilterValue = {
    ...(search.get('centre_id') ? { centre_id: search.get('centre_id')! } : {}),
    ...(from && to ? { received: [from, to] } : {}),
    ...(search.get('read_overdue') ? { read_overdue: search.get('read_overdue')! } : {}),
    ...(search.get('has_open_instrument_records') ? { has_open_instrument_records: search.get('has_open_instrument_records')! } : {}),
  };
  const filters: FilterDef[] = [
    ...(centres ? [{ id: 'centre_id', label: 'Centre', kind: 'select' as const, options: centres.map((c) => ({ value: c.centre_id, label: c.name })) }] : []),
    { id: 'received', label: 'Received', kind: 'date_range' },
    { id: 'read_overdue', label: 'Reads overdue', kind: 'select', options: YES_NO },
    { id: 'has_open_instrument_records', label: 'Instrument data waiting', kind: 'select', options: YES_NO },
  ];
  const onFilters = (v: FilterValue) => {
    const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
    const range = Array.isArray(v['received']) ? (v['received'] as readonly string[]) : undefined;
    const [f, t] = range ?? [];
    if (f && t && (Date.parse(t) - Date.parse(f)) / 86_400_000 + 1 > 31) {
      setRangeError(true);
      return;
    }
    setRangeError(false);
    go({
      centre_id: str('centre_id'),
      received_at_from: f ? `${f}T00:00:00.000Z` : undefined, // ponytail: UTC day bounds; tenant-timezone bounds when C2 exposes the zone to the BFF
      received_at_to: t ? `${t}T23:59:59.999Z` : undefined,
      read_overdue: str('read_overdue'),
      has_open_instrument_records: str('has_open_instrument_records'),
    });
  };
  const onReset = () => {
    setRangeError(false);
    go({ centre_id: undefined, received_at_from: undefined, received_at_to: undefined, read_overdue: undefined, has_open_instrument_records: undefined, sort: undefined });
  };

  // ---- table (empty copy per tab goes through DataTable's emptyState = the kit EmptyState)
  const barcodeOf = (c: CultureSummaryDto) => c.barcode ?? specimens[c.specimen_id]?.barcode;
  const columns: readonly ColumnDef<CultureSummaryDto>[] = [
    { id: 'barcode', header: 'Barcode', cell: (c) => (barcodeOf(c) ? <span className="lims-mono">{barcodeOf(c)}</span> : '—') },
    { id: 'reg', header: 'Reg no', hideBelow: 'md', cell: (c) => specimens[c.specimen_id]?.registration_no ?? '—' },
    {
      id: 'test',
      header: 'Test',
      isRowHeader: true,
      cell: (c) => <a className="lims-link" href={`/micro/cultures/${c.id}`}>{`${c.test_code} · ${c.test_name}`}</a>,
    },
    { id: 'specimen', header: 'Specimen', hideBelow: 'lg', cell: (c) => (c.specimen_site_code ? `${c.specimen_type_code} · ${c.specimen_site_code}` : c.specimen_type_code) },
    { id: 'received', header: 'Received', sortKey: 'received_at', cell: (c) => <When value={c.received_at} time /> },
    {
      id: 'next_read',
      header: 'Next read',
      cell: (c) => (
        <>
          <When value={c.next_read_due_at} time />
          {c.is_read_overdue ? (
            <>
              {' '}
              <Badge tone="warning">
                <Icon name="warning" /> Read overdue
              </Badge>
            </>
          ) : null}
        </>
      ),
    },
    { id: 'status', header: 'Status', cell: (c) => <CultureStatusChip status={c.status} /> },
    {
      id: 'reports',
      header: 'Reports',
      hideBelow: 'md',
      cell: (c) =>
        c.current_report_version_no > 0 ? (
          <StatusChip
            kind="generic"
            status={c.last_report_phase ?? 'version'}
            tone={c.last_report_phase === 'final' ? 'success' : 'info'}
            label={`${c.last_report_phase === 'final' ? 'F' : c.last_report_phase === 'preliminary' ? 'P' : 'v'}${c.current_report_version_no}`}
            size="sm"
          />
        ) : (
          '—'
        ),
    },
    {
      id: 'instrument',
      header: 'Instrument data',
      hideBelow: 'lg',
      cell: (c) => (c.open_instrument_record_count > 0 ? <Badge tone="warning">{`${c.open_instrument_record_count} open`}</Badge> : '—'),
    },
  ];
  const urlSort = search.get('sort');
  const sort = urlSort ?? DEFAULT_SORT[tab];
  const cursor = search.get('cursor');

  return (
    <section aria-label="Microbiology worklist">
      <Stack gap={3}>
        <PageHeader title="Microbiology" helpKey="micro.worklist" />
        <div ref={wrap}>
          <BarcodeInput label="Scan specimen barcode" name="scan_barcode" onScan={(v) => void onScan(v)} />
        </div>
        {notice === 'none' ? (
          <div role="status">
            <Banner tone="info" title={NO_CULTURE} />
          </div>
        ) : null}
        {notice === 'error' ? (
          <div role="alert">
            <Banner tone="danger" title={SCAN_FAILED} />
          </div>
        ) : null}
        <Tabs
          aria-label="Worklist"
          items={TABS.map((t) => ({ id: t.id, label: counts[t.id] === undefined || t.id === 'recent' ? t.label : `${t.label} (${counts[t.id]})` }))}
          selectedId={tab}
          onChange={(id) => id !== tab && go({}, id as TabId)}
        >
          <Stack gap={3}>
            <FilterBar filters={filters} value={filterValue} onChange={onFilters} onReset={onReset} />
            {rangeError ? <Banner tone="warning" title={RANGE_TOO_LONG} /> : null}
            <DataTable<CultureSummaryDto>
              caption="Microbiology cultures"
              density="compact"
              columns={columns}
              rows={cultures}
              getRowId={(c) => c.id}
              emptyState={{ title: emptyTitle(tab, recentWindowDays) }}
              sort={{ value: sort, onChange: (v) => go({ sort: v }) }}
              onRowAction={(c) => router.push(`/micro/cultures/${c.id}`)}
              {...(nextCursor || cursor
                ? { page: { hasNext: !!nextCursor, hasPrevious: !!cursor, onNext: () => go({}, tab, nextCursor), onPrevious: () => router.back(), limit: 50 } }
                : {})}
            />
          </Stack>
        </Tabs>
      </Stack>
      {choices ? <ChooseCultureDialog cultures={choices} onChoose={(id) => router.push(`/micro/cultures/${id}`)} onClose={() => setChoices(undefined)} /> : null}
    </section>
  );
}
