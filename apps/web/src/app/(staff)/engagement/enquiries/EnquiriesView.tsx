'use client';
// W11 Enquiries inbox (04-UI-UX §3 W11; US-EN-18.2). Status filter lives in the URL. EnquirySummary carries no phone, so there is no phone column.
// LD-140 (2026-11-13): packages/ui components and token classes only; no hex colours, pixel radii or inline styles; no primary button on this page.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { EnquirySummary } from './enquiries.server';

export interface EnquiriesViewProps {
  enquiries: readonly EnquirySummary[];
  categories: readonly { code: string; display: string }[];
  permissions: readonly string[];
  nextCursor?: string;
  hasPrevious?: boolean;
}

export const STATUS_LABEL: Record<string, [string, 'neutral' | 'info' | 'success' | 'warning' | 'danger']> = {
  open: ['Open', 'warning'], answered: ['Answered', 'success'], closed: ['Closed', 'neutral'],
};
const ALL = 'all';

export function EnquiriesView({ enquiries, categories, nextCursor, hasPrevious }: EnquiriesViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const topic = (c: string) => categories.find((x) => x.code === c)?.display ?? 'Other';
  const status = params.get('status') ?? ALL;

  const go = (v: string) => {
    const q = new URLSearchParams(params.toString());
    q.delete('cursor');
    if (v === ALL) q.delete('status'); else q.set('status', v);
    router.replace(`${pathname}${q.size ? `?${q.toString()}` : ''}`);
  };

  const columns: ColumnDef<EnquirySummary>[] = [
    { id: 'last', header: 'Last message', cell: (r) => <DateText value={r.last_message_at as DateTextProps['value']} withTime /> },
    { id: 'topic', header: 'Topic', cell: (r) => topic(r.category_code) },
    { id: 'subject', header: 'Subject', isRowHeader: true, cell: (r) => <a href={`/engagement/enquiries/${encodeURIComponent(r.id)}`}>{r.subject}</a> },
    { id: 'status', header: 'Status', cell: (r) => { const [label, tone] = STATUS_LABEL[r.status] ?? ['Unknown', 'neutral' as const]; return <StatusChip kind="generic" status={r.status} label={label} tone={tone} />; } },
  ];

  return (
    <section aria-label="Enquiries">
      <PageHeader title="Enquiries" helpKey="engagement.enquiries" />
      <div className="lims-inline" role="search" aria-label="Enquiry filters">
        <Select label="Status" name="status" value={status} onChange={go}
          options={[{ value: ALL, label: 'All' }, ...Object.entries(STATUS_LABEL).map(([value, [label]]) => ({ value, label }))]} />
      </div>
      <DataTable<EnquirySummary>
        columns={columns} rows={enquiries} getRowId={(r) => r.id} density="compact" caption="Enquiries"
        emptyState={{ title: 'No open enquiries', body: 'Patient questions from the app appear here.' }}
        {...(nextCursor || hasPrevious ? { page: { hasNext: !!nextCursor, hasPrevious: !!hasPrevious, limit: 50, onNext: () => nextCursor && router.push(`${pathname}?${new URLSearchParams([...params.entries()].filter(([k]) => k !== 'cursor').concat([['cursor', nextCursor]])).toString()}`), onPrevious: () => router.back() } } : {})}
      />
    </section>
  );
}
