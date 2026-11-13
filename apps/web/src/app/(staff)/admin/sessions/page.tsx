// AD-9 Active sessions (C2 04-UI-UX §6). Gate identity.session.revoke; filter User → membership_id (wire name), "Support only" is local.
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { idParam, one, type Page, type SessionSummary, type SP } from '@/features/admin/lib';
import { SessionsGrid } from '@/features/admin/components/SessionsGrid';
import { revokeSession } from '@/features/admin/actions';

export default async function SessionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await gate('identity.session.revoke'))) return <Denied />;
  const sp = await searchParams;
  const membership = idParam(sp['membership_id']);
  const supportOnly = one(sp['support']) === '1';
  const r = await call<Page<SessionSummary>>('GET', '/v1/identity/sessions', { query: { membership_id: membership, state: 'active', limit: '50' } });
  return (
    <Frame title="Active sessions">
      <form method="get" action="/admin/sessions" className="lims-filterbar" aria-label="Filters">
        {membership ? <input type="hidden" name="membership_id" value={membership} /> : null}
        <label className="lims-check"><input type="checkbox" name="support" value="1" defaultChecked={supportOnly} /> Support only</label>
        <button type="submit" className="lims-btn">Apply</button>
      </form>
      {r.ok ? <SessionsGrid sessions={r.data.data.filter((s) => !supportOnly || s.is_support)} variant="all" onRevoke={revokeSession} /> : <LoadError fail={r} what="sessions" />}
    </Frame>
  );
}
