// AD-1 Users (C2 04-UI-UX §6). Gate identity.user.read before any API call; only whitelisted wire filters are forwarded (08 A6.1).
import Link from 'next/link';
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { idParam, one, pick, qs, type Page, type SP, type UserSummary } from '@/features/admin/lib';
import { UsersTable } from '@/features/admin/components/UsersTable';
import { UrlFilters } from '@/features/admin/components/UrlFilters';
import type { FilterDef } from '@lims/ui/components/FilterBar';
import { t } from '@/core/i18n/messages';

const STATUS = ['invited', 'active', 'deactivated'] as const;
const BOOL = ['true', 'false'] as const;
const SORT = ['display_name', '-last_login_at', 'created_at'] as const;

export default async function UsersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const sp = await searchParams;
  const f = {
    status: pick(sp['status'], STATUS), is_locked: pick(sp['is_locked'], BOOL), role_id: idParam(sp['role_id']), centre_id: idParam(sp['centre_id']),
    mfa_enrolled: pick(sp['mfa_enrolled'], BOOL), sort: pick(sp['sort'], SORT),
  };
  const cursor = one(sp['cursor']);
  const r = await call<Page<UserSummary>>('GET', '/v1/identity/users', { query: { ...f, ...(cursor && cursor.length <= 200 ? { cursor } : {}), limit: '50' } });
  const opts = (o: Array<[string, string]>) => o.map(([value, label]) => ({ value, label }));
  // T0D-UIGUARD-1-ADMIN (LD-353 rule 2, LD-439): the kit FilterBar replaces the hand built GET form; same parameter names, same whitelist above
  const filters: FilterDef[] = [
    { id: 'status', label: 'Status', kind: 'select', options: opts([['invited', 'Invited'], ['active', 'Active'], ['deactivated', 'Deactivated']]) },
    { id: 'is_locked', label: 'Locked', kind: 'select', options: opts([['true', 'Locked'], ['false', 'Not locked']]) },
    { id: 'mfa_enrolled', label: 'Two-step', kind: 'select', options: opts([['true', 'On'], ['false', 'Off']]) },
    { id: 'sort', label: 'Sort by', kind: 'select', options: opts([['display_name', 'Name'], ['-last_login_at', 'Last login'], ['created_at', 'Created']]) },
  ];
  return (
    <Frame title={t('admin.nav.users')} helpKey="admin.users" caption="Everyone with access to your lab"
      actions={perms.has('identity.user.manage') ? <Link href="/admin/users/new" className="lims-btn lims-btn-primary">Invite user</Link> : null}>
      <UrlFilters filters={filters} initial={{ status: f.status, is_locked: f.is_locked, mfa_enrolled: f.mfa_enrolled, sort: f.sort }} />
      {r.ok ? (
        <UsersTable
          rows={r.data.data}
          canManage={perms.has('identity.user.manage')}
          {...(r.data.page?.next_cursor ? { moreHref: `/admin/users${qs({ ...f, cursor: r.data.page.next_cursor })}` } : {})}
        />
      ) : (
        <LoadError fail={r} what="users" />
      )}
    </Frame>
  );
}
