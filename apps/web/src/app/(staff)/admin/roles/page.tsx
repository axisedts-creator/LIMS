// AD-4 Roles (C2 04-UI-UX §6). Gate identity.user.read; [New role] only with identity.role.manage.
import Link from 'next/link';
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { Badge, Grid } from '@/features/admin/Grid';
import type { Role } from '@/features/admin/lib';

export default async function RolesPage() {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const r = await call<{ data: Role[] }>('GET', '/v1/identity/roles');
  return (
    <Frame title="Roles" actions={perms.has('identity.role.manage') ? <Link href="/admin/roles/new" className="lims-btn lims-btn-primary">New role</Link> : null}>
      {r.ok ? (
        <Grid
          label="Roles"
          columns={['Name', 'Code', 'Default', 'MFA required', 'Members', 'Status']}
          rows={r.data.data.map((x) => ({
            key: x.role_id,
            cells: [
              <Link key="n" href={`/admin/roles/${encodeURIComponent(x.role_id)}`}>{x.name}</Link>,
              <code key="c">{x.code}</code>,
              x.is_default ? <Badge text="Default" /> : '',
              x.mfa_required ? 'Yes' : 'No',
              String(x.member_count),
              x.is_active ? 'Active' : 'Inactive',
            ],
          }))}
        />
      ) : (
        <LoadError fail={r} what="roles" />
      )}
    </Frame>
  );
}
