// AD-10 Audit log (C2 04-UI-UX §6, US-D1): metadata only; date range required (default 24 h, ≤31 days → inline error, no request);
// UUID filters validated before forwarding; [Export…] only with audit.log.export.
import Link from 'next/link';
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { Badge, Grid, Time } from '@/features/admin/Grid';
import { CopyButton } from '@/features/admin/components/CopyButton';
import { UrlFilters } from '@/features/admin/components/UrlFilters';
import type { FilterDef } from '@lims/ui/components/FilterBar';
import { NavButton } from '@/features/admin/ui';
import { fmt, idParam, one, pick, qs, rangeFrom, shortId, type Page, type SP } from '@/features/admin/lib';
import { t } from '@/core/i18n/messages';

interface Entry { audit_id: string; occurred_at: string; table: string; action: string; row_id?: string; actor?: { type?: string; display_name?: string; membership_id?: string }; centre_id?: string; changed_columns: string[]; support_session_id?: string }
const ACTION_LABEL: Record<string, string> = { insert: 'Insert', update: 'Update', delete: 'Delete' };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const perms = await gate('audit.log.read');
  if (!perms) return <Denied />;
  const sp = await searchParams;
  const range = rangeFrom(sp);
  const tableParam = one(sp['table']);
  const f = {
    table: tableParam && /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(tableParam) && tableParam.length <= 127 ? tableParam : undefined,
    action: pick(sp['action'], ['insert', 'update', 'delete']),
    membership_id: idParam(sp['membership_id']), centre_id: idParam(sp['centre_id']), row_id: idParam(sp['row_id']),
    request_id: idParam(sp['request_id']), support_session_id: idParam(sp['support_session_id']),
  };
  const cursor = one(sp['cursor']);
  const r = range.error ? null : await call<Page<Entry>>('GET', '/v1/identity/audit-entries', {
    query: { occurred_at_from: range.from, occurred_at_to: range.to, ...f, ...(cursor && cursor.length <= 200 ? { cursor } : {}), limit: '50' },
  });
  const text = (id: string, label: string): FilterDef => ({ id, label, kind: 'text', maxLength: 127 });
  // T0D-UIGUARD-1-ADMIN (LD-353 rule 2, LD-439): kit FilterBar instead of the hand built GET form; same parameter names, same checks above
  const filters: FilterDef[] = [
    text('occurred_at_from', 'From (UTC)'), text('occurred_at_to', 'To (UTC)'), text('table', 'Table'),
    { id: 'action', label: 'Action', kind: 'select', options: [{ value: 'insert', label: 'Insert' }, { value: 'update', label: 'Update' }, { value: 'delete', label: 'Delete' }] },
    text('membership_id', 'User id'), text('centre_id', 'Centre id'), text('row_id', 'Record id'), text('request_id', 'Request id'), text('support_session_id', 'Support session'),
  ];
  const initial = Object.fromEntries(filters.map((d) => [d.id, (d.id === 'occurred_at_from' ? range.from : d.id === 'occurred_at_to' ? range.to : (f as Record<string, string | undefined>)[d.id]) ?? one(sp[d.id])]));
  return (
    <Frame title={t('admin.nav.audit')} helpKey="admin.audit" caption="Who changed what, metadata only (UTC)"
      actions={perms.has('audit.log.export') ? <Link href="/admin/exports" className="lims-btn">Export…</Link> : null}>
      <UrlFilters filters={filters} initial={initial} />
      {range.error ? <p role="alert" className="lims-error">{range.error}</p> : null}
      {r && !r.ok ? <LoadError fail={r} what="the audit log" /> : null}
      {r?.ok ? (
          <Grid
            label="Audit log"
            empty="No audit entries in this range."
            columns={['Time', 'User', 'Action', 'Table', 'Record id', 'Centre', 'Changed fields', 'Support']}
            rows={r.data.data.map((e) => ({
              key: e.audit_id,
              cells: [
                <Link key="t" href={`/admin/audit/${encodeURIComponent(e.audit_id)}`}><Time iso={e.occurred_at} label={fmt(e.occurred_at)} /></Link>,
                e.actor?.display_name ?? (e.actor?.type === 'system' ? 'System' : '—'),
                ACTION_LABEL[e.action] ?? e.action,
                e.table,
                e.row_id ? <span key="r"><code title={e.row_id}>{shortId(e.row_id)}</code> <CopyButton value={e.row_id} label="record id" /></span> : '—',
                e.centre_id ? <code title={e.centre_id}>{shortId(e.centre_id)}</code> : '—',
                <span key="c" title={e.changed_columns.join(', ')}>{e.changed_columns.length} ({e.changed_columns.join(', ')})</span>,
                e.support_session_id ? <Badge text="Support" /> : '',
              ],
            }))}
          />
      ) : null}
      {r?.ok && r.data.page?.next_cursor ? <NavButton href={`/admin/audit${qs({ occurred_at_from: range.from, occurred_at_to: range.to, ...f, cursor: r.data.page.next_cursor })}`}>Load more</NavButton> : null}
    </Frame>
  );
}
