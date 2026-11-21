// AD-9 Active sessions (C2 04-UI-UX §6). Gate identity.session.revoke; filter User → membership_id (wire name), "Support only" is local.
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { idParam, one, type Page, type SessionSummary, type SP } from '@/features/admin/lib';
import { SessionsGrid } from '@/features/admin/components/SessionsGrid';
import { UrlFilters } from '@/features/admin/components/UrlFilters';
import { revokeSession } from '@/features/admin/actions';
import { t } from '@/core/i18n/messages';

export default async function SessionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await gate('identity.session.revoke'))) return <Denied />;
  const sp = await searchParams;
  const membership = idParam(sp['membership_id']);
  const supportOnly = one(sp['support']) === '1';
  const r = await call<Page<SessionSummary>>('GET', '/v1/identity/sessions', { query: { membership_id: membership, state: 'active', limit: '50' } });
  return (
    <Frame title={t('admin.nav.sessions')} helpKey="admin.sessions" caption="Active sign-ins in your lab">
      {/* T0D-UIGUARD-1-ADMIN (LD-353 rule 2, LD-439): kit FilterBar; "support=1" and the kept membership_id are the same URL as the old form */}
      <UrlFilters filters={[{ id: 'support', label: 'Sessions', kind: 'select', options: [{ value: '1', label: 'Support only' }] }]}
        initial={{ support: supportOnly ? '1' : undefined }} keep={['membership_id']} />
      {r.ok ? <SessionsGrid sessions={r.data.data.filter((s) => !supportOnly || s.is_support)} variant="all" onRevoke={revokeSession} /> : <LoadError fail={r} what="sessions" />}
    </Frame>
  );
}
