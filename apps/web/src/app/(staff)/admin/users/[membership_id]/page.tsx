// AD-3 User detail (C2 04-UI-UX §6). Gate identity.user.read; unknown / other-tenant id → 404 → not-found (no data leak).
import { notFound } from 'next/navigation';
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import { SEG_RE, type Branch, type Centre, type Page, type Role, type SessionSummary, type UserDetail } from '@/features/admin/lib';
import { UserDetailView } from '@/features/admin/components/UserDetailView';

export default async function UserDetailPage({ params }: { params: Promise<{ membership_id: string }> }) {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const { membership_id: id } = await params;
  if (!SEG_RE.test(id)) notFound();
  const user = await call<UserDetail>('GET', `/v1/identity/users/${encodeURIComponent(id)}`);
  if (!user.ok && user.status === 404) notFound();
  if (!user.ok) return <LoadError fail={user} what="this user" />;
  const [roles, centres, branches, sessions] = await Promise.all([
    call<{ data: Role[] }>('GET', '/v1/identity/roles'),
    perms.has('identity.centre.read') || perms.has('identity.user.manage') ? call<{ data: Centre[] }>('GET', '/v1/identity/centres') : null,
    call<{ data: Branch[] }>('GET', '/v1/identity/branches'),
    perms.has('identity.session.revoke') ? call<Page<SessionSummary>>('GET', '/v1/identity/sessions', { query: { membership_id: id, limit: '50' } }) : null,
  ]);
  return (
    <UserDetailView
      user={user.data}
      perms={[...perms]}
      roles={roles.ok ? roles.data.data : []}
      centres={centres?.ok ? centres.data.data : []}
      branches={branches.ok ? branches.data.data : []}
      sessions={sessions?.ok ? sessions.data.data : []}
    />
  );
}
