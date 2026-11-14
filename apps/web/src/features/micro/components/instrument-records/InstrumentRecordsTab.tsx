'use client';
// 04-UI-UX §3.5 culture tab "Instrument data": the records of this culture (every status, so applied / ignored history shows), the §4 columns without Barcode, actions Apply /
// Resolve conflict / Ignore (the culture is known, so no assigning). Loaded when the tab opens (AC-08.4–AC-08.6 UI side). LD-140 (2026-11-13): kit components only.
import { EmptyState } from '@lims/ui/components/EmptyState';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';
import { Stack } from '@lims/ui/components/Stack';
import { listCultureInstrumentRecordsAction } from '../../server/instrumentRecordActions';
import { useLoad } from '../settings/useLoad';
import { RecordTable } from './RecordTable';
import { useRecordFlow } from './RecordFlow';

export function InstrumentRecordsTab({ cultureId, canWork }: { cultureId: string; canWork: boolean }) {
  const list = useLoad(() => listCultureInstrumentRecordsAction(cultureId), cultureId);
  const flow = useRecordFlow(list.reload);
  if (!list.loaded) return <LoadingSkeleton variant="table" />;
  if (list.fail) return <ErrorState title="Instrument data could not be loaded." body="Try again. If it keeps happening, tell your administrator." onRetry={list.reload} />;
  if (list.rows.length === 0) return <EmptyState title="No instrument data for this culture." />;
  return (
    <Stack gap={3}>
      {flow.ui}
      <RecordTable rows={list.rows} caption="Instrument data of this culture" emptyTitle="No instrument data for this culture." inCulture canWork={canWork} onAction={flow.onAction} />
    </Stack>
  );
}
