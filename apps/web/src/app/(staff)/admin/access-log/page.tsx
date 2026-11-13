// AD-12 Access log + Sign-in events (C2 04-UI-UX §6, US-D3). Gate audit.log.read; range ≤31 days → inline error and no request on both tabs.
import { call } from '@/features/admin/server/api';
import { Denied, Frame, gate } from '@/features/admin/server/page-kit';
import { copyFor, idParam, one, pick, rangeFrom, type Page, type SP } from '@/features/admin/lib';
import { AccessLogTabs, type AccessRow } from '@/features/admin/components/AccessLogTabs';

export default async function AccessLogPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await gate('audit.log.read'))) return <Denied />;
  const sp = await searchParams;
  const range = rangeFrom(sp);
  const entityType = one(sp['entity_type']);
  const eventType = one(sp['event_type']);
  const membershipId = idParam(sp['membership_id']);
  const q = {
    entity_type: entityType && /^[a-z][a-z0-9_.]{0,39}$/.test(entityType) ? entityType : undefined, entity_id: idParam(sp['entity_id']), centre_id: idParam(sp['centre_id']),
    membership_id: membershipId, outcome: pick(sp['outcome'], ['allowed', 'denied']),
  };
  const r = range.error ? null : await call<Page<AccessRow>>('GET', '/v1/identity/access-log-entries', { query: { occurred_at_from: range.from, occurred_at_to: range.to, ...q, limit: '50' } });
  return (
    <Frame title="Access log">
      <form method="get" action="/admin/access-log" className="lims-filterbar" aria-label="Filters">
        {([['occurred_at_from', 'From (UTC)', range.from], ['occurred_at_to', 'To (UTC)', range.to], ['entity_type', 'Entity type', q.entity_type], ['entity_id', 'Entity id', q.entity_id],
          ['centre_id', 'Centre id', q.centre_id], ['membership_id', 'User id', q.membership_id], ['event_type', 'Sign-in event', eventType]] as const).map(([n, l, v]) => (
          <div key={n} className="lims-field">
            <label htmlFor={`l-${n}`} className="lims-label">{l}</label>
            <input id={`l-${n}`} name={n} defaultValue={v ?? ''} className="lims-input" maxLength={64} />
          </div>
        ))}
        <button type="submit" className="lims-btn">Apply</button>
      </form>
      {range.error ? <p role="alert" className="lims-error">{range.error}</p> : null}
      <AccessLogTabs
        access={r ? (r.ok ? { rows: r.data.data } : { rows: [], error: { text: copyFor(r.code), requestId: r.requestId } }) : null}
        range={range.error ? null : { from: range.from, to: range.to }}
        eventType={eventType && /^[a-z_]{1,30}$/.test(eventType) ? eventType : undefined}
        membershipId={membershipId}
      />
    </Frame>
  );
}
