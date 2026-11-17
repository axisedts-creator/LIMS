// AD-10 Audit log (C2 04-UI-UX §6, US-D1): metadata only; date range required (default 24 h, ≤31 days → inline error, no request);
// UUID filters validated before forwarding; [Export…] only with audit.log.export.
import Link from 'next/link';
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { Badge, Grid, Time } from '@/features/admin/Grid';
import { CopyButton } from '@/features/admin/components/CopyButton';
import { NavButton } from '@/features/admin/ui';
import { fmt, idParam, one, pick, qs, rangeFrom, shortId, type Page, type SP } from '@/features/admin/lib';

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
  const text = (name: string, label: string, value: string | undefined) => (
    <div className="lims-field">
      <label htmlFor={`a-${name}`} className="lims-label">{label}</label>
      <input id={`a-${name}`} name={name} defaultValue={value ?? one(sp[name]) ?? ''} className="lims-input" maxLength={127} />
    </div>
  );
  return (
    <Frame title="Audit log" actions={perms.has('audit.log.export') ? <Link href="/admin/exports" className="lims-btn">Export…</Link> : null}>
      <form method="get" action="/admin/audit" className="lims-filterbar" aria-label="Filters">
        {text('occurred_at_from', 'From (UTC)', range.from)}
        {text('occurred_at_to', 'To (UTC)', range.to)}
        {text('table', 'Table', f.table)}
        <div className="lims-field">
          <label htmlFor="a-action" className="lims-label">Action</label>
          <select id="a-action" name="action" defaultValue={f.action ?? ''} className="lims-input">
            <option value="">Any</option><option value="insert">Insert</option><option value="update">Update</option><option value="delete">Delete</option>
          </select>
        </div>
        {text('membership_id', 'User id', f.membership_id)}
        {text('centre_id', 'Centre id', f.centre_id)}
        {text('row_id', 'Record id', f.row_id)}
        {text('request_id', 'Request id', f.request_id)}
        {text('support_session_id', 'Support session', f.support_session_id)}
        <button type="submit" className="lims-btn">Apply</button>
      </form>
      {range.error ? <p role="alert" className="lims-error">{range.error}</p> : null}
      {r && !r.ok ? <LoadError fail={r} what="the audit log" /> : null}
      {r?.ok ? (
        r.data.data.length ? (
          <Grid
            label="Audit log"
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
        ) : <p>No audit entries in this range.</p>
      ) : null}
      {r?.ok && r.data.page?.next_cursor ? <NavButton href={`/admin/audit${qs({ occurred_at_from: range.from, occurred_at_to: range.to, ...f, cursor: r.data.page.next_cursor })}`}>Load more</NavButton> : null}
    </Frame>
  );
}
