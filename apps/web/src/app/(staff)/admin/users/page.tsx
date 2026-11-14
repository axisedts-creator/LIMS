// AD-1 Users (C2 04-UI-UX §6). Gate identity.user.read before any API call; only whitelisted wire filters are forwarded (08 A6.1).
import Link from 'next/link';
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { idParam, one, pick, qs, type Page, type SP, type UserSummary } from '@/features/admin/lib';
import { UsersTable } from '@/features/admin/components/UsersTable';

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
  const select = (name: keyof typeof f, label: string, opts: Array<[string, string]>) => (
    <div className="lims-field">
      <label htmlFor={`f-${name}`} className="lims-label">{label}</label>
      <select id={`f-${name}`} name={name} defaultValue={f[name] ?? ''} className="lims-input">
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  return (
    <Frame title="Users" actions={perms.has('identity.user.manage') ? <Link href="/admin/users/new" className="lims-btn lims-btn-primary">Invite user</Link> : null}>
      <form method="get" action="/admin/users" className="lims-filterbar" aria-label="Filters">
        {select('status', 'Status', [['', 'All'], ['invited', 'Invited'], ['active', 'Active'], ['deactivated', 'Deactivated']])}
        {select('is_locked', 'Locked', [['', 'Any'], ['true', 'Locked'], ['false', 'Not locked']])}
        {select('mfa_enrolled', 'Two-step', [['', 'Any'], ['true', 'On'], ['false', 'Off']])}
        {select('sort', 'Sort by', [['', 'Name'], ['-last_login_at', 'Last login'], ['created_at', 'Created']])}
        <button type="submit" className="lims-btn">Apply</button>
      </form>
      {r.ok ? (
        <UsersTable
          rows={r.data.data}
          {...(r.data.page?.next_cursor ? { moreHref: `/admin/users${qs({ ...f, cursor: r.data.page.next_cursor })}` } : {})}
        />
      ) : (
        <LoadError fail={r} what="users" />
      )}
    </Frame>
  );
}
