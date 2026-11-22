'use client';
// C9 T-21 shared view pieces. LD-140: composed only from @lims/ui components; no colours, sizes or inline styles here.
import { useRef } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { clockHm, clockHms } from '../format';

export const NOT_SWITCHED_ON = 'The QC module is not switched on for your lab yet.';
export const NO_ACCESS = "You don't have access to this page";

/** Honest page states that replace the whole screen: no permission (no API call was made) and module switched off (API said common.feature_disabled). */
export function QualityNotice({ kind, title, helpKey, message }: { kind: 'denied' | 'disabled' | 'missing'; title: string; helpKey: string; message?: string }) {
  return (
    <>
      <PageHeader title={title} helpKey={helpKey} />
      <EmptyState
        title={kind === 'missing' ? (message ?? 'Not found') : kind === 'denied' ? NO_ACCESS : NOT_SWITCHED_ON}
        {...(kind === 'denied' ? { body: 'Ask your lab administrator for QC access.' } : {})}
      />
    </>
  );
}

/** T0D-BUILD-5 (LD-455, UIX-1): the data of a ChartCard as the kit DataTable (left aligned label column, right aligned count). Replaces the
 *  kit BarChart, whose hidden raw <table> with centred headers the sweep flagged. One row per category; counts are never empty. */
export function ChartTable({ title, label, valueHeader, rows }: { title: string; label: string; valueHeader: string; rows: readonly { label: string; value: number }[] }) {
  const columns: ColumnDef<{ label: string; value: number }>[] = [
    { id: 'label', header: label, isRowHeader: true, cell: (r) => r.label },
    { id: 'value', header: valueHeader, numeric: true, cell: (r) => String(r.value) },
  ];
  return <DataTable columns={columns} rows={rows} getRowId={(r) => r.label} density="compact" stickyHeader={false} caption={title} emptyState={{ title: 'No data yet' }} />;
}

/** "Updated hh:mm:ss" next to the page title (04-UI-UX §1 Polling). */
export const UpdatedAt = ({ at }: { at: Date }) => <span>Updated {clockHms(at)}</span>;

/** E20: the last data stays on screen; this says how old it is. */
export const ConnectionLost = ({ since }: { since: Date }) => <Banner tone="warning" title={`Connection lost — showing data from ${clockHm(since)}`} />;

/** One Idempotency-Key per distinct request body: a retry of the same attempt re-sends the key, a changed body gets a new one (IC idempotency). */
export function useAttemptKey() {
  const cur = useRef<{ sig: string; key: string }>(null);
  return {
    keyFor: (sig: string) => {
      if (cur.current?.sig !== sig) cur.current = { sig, key: crypto.randomUUID() };
      return cur.current.key;
    },
    done: () => {
      cur.current = null;
    },
  };
}

/** Query string from a plain object, dropping empty values. */
export const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
