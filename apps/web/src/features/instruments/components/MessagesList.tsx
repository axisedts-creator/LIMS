'use client';
// SCR-09 Messages (04-UI-UX §3). Filters live in the URL; the sample-barcode search is a POST through a server action and its result
// lives only in component state — never in the URL, history or storage (REQ-SEC-098). Rows come from props (the page reads E33/E42).
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { shortcuts } from '@/core/shortcuts/registry';
import { searchInstrumentMessagesAction } from '../server/actions';
import { SAMPLE_BARCODE_RE, parseMessageFilters, type MessageRejection, type MessageSummary } from '../server/messages';
import type { AgentSummary, InstrumentSummary } from '../server/types';
import { KIND_LABEL, KIND_OPTIONS, OUTCOME_OPTIONS, OutcomeChip, sizeText } from './MessageLabels';

const TABS = [{ id: 'messages', label: 'Messages' }, { id: 'rejections', label: 'Rejected uploads' }] as const;
const localDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const startOfDay = (isoDate: string, plusDays = 0) => { const [y, m, d] = isoDate.split('-').map(Number); return new Date(y!, m! - 1, d! + plusDays).toISOString(); };

export function MessagesList({ messages, rejections, instruments, agents }: {
  messages: readonly MessageSummary[];
  rejections: readonly MessageRejection[];
  instruments: readonly Pick<InstrumentSummary, 'id' | 'instrument_code'>[];
  agents: readonly Pick<AgentSummary, 'id' | 'agent_code'>[];
  permissions?: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const url = useSearchParams();
  const [tab, setTab] = useState<string>('messages');
  const [found, setFound] = useState<readonly MessageSummary[]>();
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const field = useRef<HTMLDivElement>(null);
  const q = parseMessageFilters(Object.fromEntries(url.entries()));
  const from = url.get('received_at_from');
  const to = url.get('received_at_to');

  // 04-UI-UX §4: SCR-09 "/" focuses the search field.
  useEffect(() => shortcuts.register('staff.instruments.messages', { key: '/', description: 'Search by scanned barcode', run: () => field.current?.querySelector('input')?.focus() }), []);

  const navigate = (next: Record<string, string | readonly string[] | undefined>) => {
    const p = new URLSearchParams(url.toString());
    for (const [k, v] of Object.entries(next)) {
      const s = Array.isArray(v) ? v.join(',') : (v as string | undefined);
      if (s) p.set(k, s);
      else p.delete(k);
    }
    p.delete('cursor');
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const scan = async (value: string) => {
    if (busy.current || !SAMPLE_BARCODE_RE.test(value)) return;
    busy.current = true;
    setFailed(false);
    try {
      const r = await searchInstrumentMessagesAction({ sampleBarcode: value });
      if (r.ok) setFound(r.data.data);
      else setFailed(true); // the failure text never carries the scanned value
    } finally {
      busy.current = false;
    }
  };

  const filterValue: FilterValue = {
    ...(from && to ? { received: [localDate(from), localDate(to)] } : {}),
    ...(q.instrumentId ? { instrument_id: q.instrumentId } : {}),
    ...(q.agentId ? { agent_id: q.agentId } : {}),
    message_kind: q.messageKind,
    latest_outcome: q.latestOutcome,
  };
  const reset = { received_at_from: undefined, received_at_to: undefined, instrument_id: undefined, agent_id: undefined, message_kind: undefined, latest_outcome: undefined, has_qc: undefined, has_unmapped: undefined };

  const columns: ColumnDef<MessageSummary>[] = [
    { id: 'received', header: 'Received', cell: (m) => <a className="lims-link" href={`/instruments/messages/${m.id}`}><DateText value={m.received_at as never} withTime /></a> },
    { id: 'instrument', header: 'Instrument', isRowHeader: true, cell: (m) => m.instrument_code },
    // RS-C7 (LD-140): Kind is a second row header so each grid row is named "<instrument> <kind>" for screen readers; a11y markup only.
    { id: 'kind', header: 'Kind', isRowHeader: true, cell: (m) => KIND_LABEL[m.message_kind] ?? m.message_kind },
    { id: 'records', header: 'Records (patient / QC)', align: 'end', cell: (m) => (m.latest_run ? `${m.latest_run.patient_records} / ${m.latest_run.qc_records}` : '—') },
    { id: 'unmapped', header: 'Unmapped', align: 'end', cell: (m) => m.latest_run?.unmapped_records ?? '—' },
    { id: 'events', header: 'Events', align: 'end', cell: (m) => m.latest_run?.emitted_events ?? '—' },
    { id: 'outcome', header: 'Outcome', cell: (m) => <OutcomeChip outcome={m.latest_run?.outcome} /> },
    { id: 'size', header: 'Size', align: 'end', cell: (m) => sizeText(m.size_bytes) },
  ];
  const agentCode = new Map(agents.map((a) => [a.id, a.agent_code]));
  const instrumentCode = new Map(instruments.map((i) => [i.id, i.instrument_code]));
  const rejectionColumns: ColumnDef<MessageRejection>[] = [
    { id: 'received', header: 'Received', cell: (r) => <DateText value={r.received_at as never} withTime /> },
    { id: 'agent', header: 'Agent', cell: (r) => agentCode.get(r.agent_id) ?? <IdText value={r.agent_id} /> },
    { id: 'instrument', header: 'Claimed instrument', cell: (r) => instrumentCode.get(r.claimed_instrument_id) ?? <IdText value={r.claimed_instrument_id} /> },
    { id: 'reason', header: 'Reason', isRowHeader: true, cell: (r) => r.reason_code },
    { id: 'size', header: 'Size', align: 'end', cell: (r) => sizeText(r.size_bytes) },
  ];

  return (
    <section aria-label="Messages">
      <PageHeader title="Messages" helpKey="instruments.messages" breadcrumbs={[{ label: 'Instruments', href: '/instruments/instruments' }, { label: 'Messages' }]} />
      <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Message sections">
        {tab === 'messages' ? (
          <>
            <FilterBar
              filters={[
                { id: 'received', label: 'Received', kind: 'date_range' },
                { id: 'instrument_id', label: 'Instrument', kind: 'select', options: instruments.map((i) => ({ value: i.id, label: i.instrument_code })) },
                { id: 'agent_id', label: 'Agent', kind: 'select', options: agents.map((a) => ({ value: a.id, label: a.agent_code })) },
                { id: 'message_kind', label: 'Kind', kind: 'select', multiple: true, options: KIND_OPTIONS },
                { id: 'latest_outcome', label: 'Latest outcome', kind: 'select', multiple: true, options: OUTCOME_OPTIONS },
              ]}
              value={filterValue}
              onChange={(v) => {
                const r = Array.isArray(v['received']) ? (v['received'] as readonly string[]) : undefined;
                navigate({
                  received_at_from: r?.[0] ? startOfDay(r[0]) : undefined,
                  received_at_to: r?.[1] ? startOfDay(r[1], 1) : undefined,
                  instrument_id: v['instrument_id'],
                  agent_id: v['agent_id'],
                  message_kind: v['message_kind'],
                  latest_outcome: v['latest_outcome'],
                });
              }}
              onReset={() => navigate(reset)}
            />
            <Switch label="Has QC records" isSelected={q.hasQc === true} onChange={(on) => navigate({ has_qc: on ? 'true' : undefined })} />
            <Switch label="Has unmapped codes" isSelected={q.hasUnmapped === true} onChange={(on) => navigate({ has_unmapped: on ? 'true' : undefined })} />
            <div ref={field}>
              <BarcodeInput label="Barcode" name="search" autoFocus={false} pattern={SAMPLE_BARCODE_RE} onScan={(v) => void scan(v)} />
            </div>
            {failed ? (
              <div role="alert">
                <Banner tone="danger" title="The search failed. Try again." />
              </div>
            ) : null}
            {found ? (
              <p>
                <span className="lims-chip">Search results for scanned barcode</span>{' '}
                <Button variant="ghost" onPress={() => { setFound(undefined); setFailed(false); }}>Clear</Button>
              </p>
            ) : null}
            <DataTable
              caption="Messages"
              columns={columns}
              rows={found ?? messages}
              getRowId={(m) => m.id}
              emptyState={{ title: found ? 'No messages found for this search.' : 'No messages in this period.' }}
            />
          </>
        ) : (
          <DataTable caption="Rejected uploads" columns={rejectionColumns} rows={rejections} getRowId={(r) => r.id} emptyState={{ title: 'No rejected uploads in this period.' }} />
        )}
      </Tabs>
    </section>
  );
}
