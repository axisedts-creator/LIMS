'use client';
// 04-UI-UX §4 Micro instrument data (AC-08.4 manual matching while LabPort.lookupSpecimens is off, AC-08.5 apply, AC-08.6 resolve): PageHeader → persistent info banner while the
// specimen-lookup port is off → FilterBar → record table. LD-140 (2026-11-13): kit components only; this page has no page action, so no primary button; every status shows tone, icon and word.
// State lives in the URL as ids / codes / dates / the opaque cursor only (AC-08.10, REQ-SEC-098: never a barcode). The server tells this screen whether the port is on.
import { useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import type { InstrumentLite, InstrumentRecordRow } from '../../server/types';
import { OPEN_STATUSES, STATUS_FILTER } from './labels';
import { RecordTable } from './RecordTable';
import { useRecordFlow } from './RecordFlow';
import { t } from '@/core/i18n/messages';

const BANNER = 'Instrument results are matched to cultures manually until automatic matching is enabled.';
const RANGE_TOO_LONG = 'Choose a period of at most 31 days.'; // [CONV] 04-UI-UX §4 Received max 31 days (the kit FilterBar cannot enforce maxDays)
const URL_KEYS = ['match_status', 'instrument_id', 'received_at_from', 'received_at_to'] as const;
const PATH = '/micro/instrument-records';

export interface InstrumentRecordsScreenProps {
  rows: readonly InstrumentRecordRow[];
  /** null = the user may not list instruments (or C7 failed): the Instrument filter is hidden. */
  instruments: readonly InstrumentLite[] | null;
  nextCursor?: string;
  /** The specimen-lookup port flag, read by the page on the server (TRD §11). */
  lookupPortOn: boolean;
  permissions: readonly string[];
}

export function InstrumentRecordsScreen({ rows, instruments, nextCursor, lookupPortOn, permissions }: InstrumentRecordsScreenProps) {
  const router = useRouter();
  const search = useSearchParams();
  const flow = useRecordFlow();
  const cursor = search.get('cursor');

  const go = (patch: Record<string, string | undefined>, nextCursorValue?: string) => {
    const q = new URLSearchParams();
    for (const k of URL_KEYS) {
      const v = k in patch ? patch[k] : search.get(k) ?? undefined;
      if (v) q.set(k, v);
    }
    if (nextCursorValue) q.set('cursor', nextCursorValue);
    const qs = q.toString();
    router.push(qs ? `${PATH}?${qs}` : PATH);
  };

  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : undefined);
  const from = day(search.get('received_at_from'));
  const to = day(search.get('received_at_to'));
  const picked = search.get('match_status')?.split(',') ?? [...OPEN_STATUSES];
  const filterValue: FilterValue = {
    match_status: picked,
    ...(search.get('instrument_id') ? { instrument_id: search.get('instrument_id')! } : {}),
    ...(from && to ? { received: [from, to] } : {}),
  };
  const filters: FilterDef[] = [
    { id: 'match_status', label: 'Status', kind: 'select', multiple: true, options: STATUS_FILTER },
    ...(instruments ? [{ id: 'instrument_id', label: 'Instrument', kind: 'select' as const, options: instruments.map((i) => ({ value: i.id, label: i.code })) }] : []),
    { id: 'received', label: 'Received', kind: 'date_range' },
  ];
  const onFilters = (v: FilterValue) => {
    const range = Array.isArray(v['received']) ? (v['received'] as readonly string[]) : undefined;
    const [f, t] = range ?? [];
    const status = Array.isArray(v['match_status']) ? (v['match_status'] as readonly string[]) : [];
    const same = status.length === OPEN_STATUSES.length && OPEN_STATUSES.every((s) => status.includes(s));
    go({
      match_status: status.length === 0 || same ? undefined : status.join(','),
      instrument_id: typeof v['instrument_id'] === 'string' ? v['instrument_id'] : undefined,
      received_at_from: f ? `${f}T00:00:00.000Z` : undefined, // ponytail: UTC day bounds; tenant-timezone bounds when C2 exposes the zone to the BFF
      received_at_to: t ? `${t}T23:59:59.999Z` : undefined,
    });
  };
  const tooLong = from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > 31;

  return (
    <section aria-label="Micro instrument data">
      <Stack gap={3}>
        <PageHeader title={t('micro.nav.instrument_records')} helpKey="micro.instrument_records" />
        {lookupPortOn ? null : <Banner tone="info" title={BANNER} />}
        <FilterBar filters={filters} value={filterValue} onChange={onFilters} onReset={() => go({ match_status: undefined, instrument_id: undefined, received_at_from: undefined, received_at_to: undefined })} />
        {tooLong ? <Banner tone="warning" title={RANGE_TOO_LONG} /> : null}
        {flow.ui}
        <RecordTable
          rows={rows}
          caption="Microbiology instrument records"
          emptyTitle="No instrument data waiting."
          canWork={permissions.includes('micro.culture.work')}
          onAction={flow.onAction}
          {...(nextCursor || cursor
            ? { page: { hasNext: !!nextCursor, hasPrevious: !!cursor, onNext: () => go({}, nextCursor), onPrevious: () => router.back(), limit: 50 } }
            : {})}
        />
      </Stack>
    </section>
  );
}
