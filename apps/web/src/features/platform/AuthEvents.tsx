'use client';
// PL-8 Sign-in events: filters (Date range ≤31 d, Tenant incl. "No tenant", Event) and the table. IPs are masked in the list.
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { AUTH_EVENT_TYPES, maskIp, type AuthEvent } from './shared';
import { SelectInput, TextInput, fmtDateTime } from './ui';

type TenantRef = { tenant_id: string; code: string };
export interface AuthEventFilter { from: string; to: string; tenant: string; event_type: string }

const REASON: Record<string, string> = { 'identity.platform_ip_denied': 'Not allowed from this network' };
const day = (iso: string) => iso.slice(0, 10);

export function AuthEventFilters({ initial, tenants }: { initial: AuthEventFilter; tenants: readonly TenantRef[] }) {
  const router = useRouter();
  const [from, setFrom] = useState(day(initial.from));
  const [to, setTo] = useState(day(initial.to));
  const [tenant, setTenant] = useState(initial.tenant);
  const [eventType, setEventType] = useState(initial.event_type);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const q = new URLSearchParams();
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q.set('occurred_at_from', `${from}T00:00:00.000Z`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q.set('occurred_at_to', `${to}T23:59:59.999Z`);
    if (tenant) q.set('tenant_id', tenant);
    if (eventType) q.set('event_type', eventType);
    router.push(`/platform/auth-events?${q.toString()}`);
  };
  return (
    <form onSubmit={apply} aria-label="Sign-in event filters" className="lims-filter-bar">
      <TextInput label="From" type="date" value={from} onChange={setFrom} />
      <TextInput label="To" type="date" value={to} onChange={setTo} hint="At most 31 days." />
      <SelectInput label="Tenant" value={tenant} onChange={setTenant} placeholder="All tenants"
        options={[{ value: 'none', label: 'No tenant' }, ...tenants.map((t) => ({ value: t.tenant_id, label: t.code }))]} />
      <SelectInput label="Event" value={eventType} onChange={setEventType} placeholder="All events" options={AUTH_EVENT_TYPES.map((e) => ({ value: e, label: e }))} />
      <Button type="submit">Apply filters</Button>
    </form>
  );
}

export function AuthEventTable({ rows, tenants }: { rows: readonly AuthEvent[]; tenants: readonly TenantRef[] }) {
  const codeOf = (id: string | undefined) => (id ? tenants.find((t) => t.tenant_id === id)?.code ?? id : 'No tenant');
  const columns: readonly ColumnDef<AuthEvent>[] = [
    { id: 'time', header: 'Time', isRowHeader: true, cell: (e) => fmtDateTime(e.occurred_at) },
    { id: 'tenant', header: 'Tenant', cell: (e) => codeOf(e.tenant_id) },
    { id: 'user', header: 'User', cell: (e) => (e.platform_staff_id ? `Platform staff ${e.platform_staff_id.slice(-6)}` : e.membership_id ?? e.user_id ?? '—') },
    { id: 'event', header: 'Event', cell: (e) => e.event_type },
    { id: 'reason', header: 'Reason', cell: (e) => (e.reason_code ? `${e.reason_code}${REASON[e.reason_code] ? ` — ${REASON[e.reason_code]}` : ''}` : '') },
    { id: 'ip', header: 'IP', cell: (e) => maskIp(e.client_ip) },
    { id: 'browser', header: 'Browser', cell: (e) => e.user_agent ?? '' },
  ];
  return <DataTable caption="Sign-in events" columns={columns} rows={rows} getRowId={(e) => e.auth_event_id} emptyState={{ title: 'No entries in this period' }} />;
}
