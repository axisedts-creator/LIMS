'use client';
// SCR-05 Instruments (04-UI-UX §3). T0D-UILIST-1 (LD-353): a table again, same data, filters, sort and routes. "New instrument" opens the SCR-06 form in a Dialog lg. Manage affordances are a UI hint; the API enforces.
import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { shortcuts } from '@/core/shortcuts/registry';
import { parseInstrumentQuery, type AgentSummary, type Driver, type InstrumentSummary } from '../server/types';
import { DriverStatusBadge, INSTRUMENT_STATE_OPTIONS, InstrumentStatePill, PROTOCOL_LABEL, PROTOCOL_OPTIONS, hasPerm } from './labels';
import type { Centre } from './AgentsList';
import { InstrumentForm } from './InstrumentForm';

export function InstrumentsList({ instruments, permissions, centres, agents, drivers, loadError }: { instruments: readonly InstrumentSummary[]; permissions: readonly string[]; centres: readonly Centre[]; agents: readonly Pick<AgentSummary, 'id' | 'agent_code' | 'display_name' | 'status'>[]; drivers: readonly Driver[]; loadError?: { requestId?: string } }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [creating, setCreating] = useState(false);
  const canManage = hasPerm(permissions, 'instruments.instrument.manage');
  const driverName = new Map(drivers.map((d) => [d.code, d.display_name]));
  // LD-79 (CR-C7-WEB-T03-a): SCR-05 "New instrument" is Alt+I; global Alt+N is never registered by a page.
  useEffect(() => (canManage ? shortcuts.register('staff.instruments.instruments', { key: 'Alt+I', description: 'New instrument', run: () => setCreating(true) }) : undefined), [canManage]);
  const q = parseInstrumentQuery(Object.fromEntries(searchParams.entries()));

  const navigate = (next: Record<string, string | readonly string[] | undefined>) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      const s = Array.isArray(v) ? v.join(',') : (v as string | undefined);
      if (s) p.set(k, s);
      else p.delete(k);
    }
    p.delete('cursor');
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const filterValue: FilterValue = {
    ...(q.centreId ? { centre_id: q.centreId } : {}),
    ...(q.agentId ? { agent_id: q.agentId } : {}),
    state: q.state,
    ...(q.protocol ? { protocol: q.protocol } : {}),
  };

  // T0D-UILIST-1 (LD-353 template 1, rules 5 and 8): the link-card grid is a table; the "Sort by" row is the sort of the column headers.
  const columns: ColumnDef<InstrumentSummary>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, sortKey: 'instrument_code', cell: (i) => <a className="lims-link" href={`/instruments/instruments/${i.id}`}>{i.instrument_code}</a> },
    { id: 'name', header: 'Name', cell: (i) => i.display_name },
    { id: 'vendor', header: 'Vendor / Model', hideBelow: 'xl', cell: (i) => [i.vendor, i.model].filter(Boolean).join(' ') || '—' },
    { id: 'protocol', header: 'Protocol', hideBelow: 'xl', cell: (i) => (i.protocol ? (PROTOCOL_LABEL[i.protocol] ?? i.protocol) : '—') },
    { id: 'agent', header: 'Agent', cell: (i) => i.agent_code ?? '—' },
    { id: 'driver', header: 'Driver', cell: (i) => (i.driver_code ? <>{driverName.get(i.driver_code) ?? i.driver_code} {i.driver_status ? <DriverStatusBadge status={i.driver_status} /> : null}</> : '—') },
    { id: 'link', header: 'Link state', hideBelow: 'xl', cell: (i) => i.link_state ?? '—' },
    { id: 'last_message', header: 'Last message', sortKey: 'last_message_at', cell: (i) => (i.last_message_at ? <DateText value={i.last_message_at as never} withTime /> : '—') },
    // 04-UI-UX SCR-05: unmapped codes are text ("3 unmapped"), never colour only; the link goes to SCR-08.
    { id: 'unmapped', header: 'Unmapped', align: 'end', cell: (i) => (i.unmapped_code_count === undefined ? '—' : <a className="lims-link" href={`/instruments/instruments/${i.id}/mappings`}>{`${i.unmapped_code_count} unmapped`}</a>) },
    { id: 'status', header: 'Status', cell: (i) => <InstrumentStatePill state={i.state} /> },
  ];

  return (
    <section aria-label="Instruments">
      <PageHeader title="Instruments" helpKey="instruments.instruments" actions={canManage ? <Button variant="primary" onPress={() => setCreating(true)}>New instrument</Button> : null} />
      <FilterBar
        filters={[
          { id: 'centre_id', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.name })) },
          { id: 'agent_id', label: 'Agent', kind: 'select', options: agents.map((a) => ({ value: a.id, label: a.agent_code })) },
          { id: 'state', label: 'State', kind: 'select', multiple: true, options: INSTRUMENT_STATE_OPTIONS },
          { id: 'protocol', label: 'Protocol', kind: 'select', options: PROTOCOL_OPTIONS },
        ]}
        value={filterValue}
        onChange={(v) => navigate({ centre_id: v.centre_id, agent_id: v.agent_id, state: v.state, protocol: v.protocol })}
        onReset={() => navigate({ centre_id: undefined, agent_id: undefined, state: undefined, protocol: undefined })}
      />
      <DataTable
        caption="Instruments"
        columns={columns}
        rows={instruments}
        getRowId={(i) => i.id}
        sort={{ value: q.sort, onChange: (v) => navigate({ sort: v.includes('last_message_at') ? '-last_message_at' : 'instrument_code' }) }}
        // the primary action lives in the header only, not again in the EmptyState
        emptyState={{ title: 'No instruments registered.' }}
        {...(loadError ? { error: { title: 'The instruments could not be loaded.', ...loadError, onRetry: () => router.refresh() } } : {})}
      />
      {canManage && creating ? (
        <Dialog title="New instrument" isOpen onClose={() => setCreating(false)} size="lg">
          <InstrumentForm mode="create" agents={agents} drivers={drivers} permissions={permissions} onDone={() => setCreating(false)} />
        </Dialog>
      ) : null}
    </section>
  );
}
