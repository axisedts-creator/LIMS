// RM-T05 Apply a role pack (11-ROLE-MATRIX s8; LD-150 route staff.admin.role_packs). Gate identity.role.manage before any API call.
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Permission, Role } from '@/features/admin/lib';
import { RolePackApply, type RolePack } from '@/features/admin/roles/RolePackApply';

export default async function RolePacksPage() {
  const perms = await gate('identity.role.manage');
  if (!perms) return <Denied />;
  const [packs, roles, catalog] = await Promise.all([
    call<{ data: RolePack[] }>('GET', '/v1/identity/role-packs'),
    call<{ data: Role[] }>('GET', '/v1/identity/roles'),
    call<{ data: Permission[] }>('GET', '/v1/identity/permissions'),
  ]);
  return (
    <Frame title="Role packs">
      {!packs.ok ? <LoadError fail={packs} what="role packs" />
        : !roles.ok ? <LoadError fail={roles} what="roles" />
        : !catalog.ok ? <LoadError fail={catalog} what="the permission list" />
        : <RolePackApply packs={packs.data.data} roles={roles.data.data} catalog={catalog.data.data} />}
    </Frame>
  );
}
