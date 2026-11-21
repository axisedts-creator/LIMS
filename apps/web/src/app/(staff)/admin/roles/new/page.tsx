// AD-5 New role (C2 04-UI-UX §6). Gate identity.role.manage before any API call.
import { call } from '@/features/admin/server/api';
import { Denied, FailedPage, gate } from '@/features/admin/server/page-kit';
import type { Permission } from '@/features/admin/lib';
import { RoleEditor } from '@/features/admin/components/RoleEditor';

export default async function NewRolePage() {
  if (!(await gate('identity.role.manage'))) return <Denied />;
  const catalog = await call<{ data: Permission[] }>('GET', '/v1/identity/permissions');
  if (!catalog.ok) return <FailedPage title="New role" helpKey="admin.role-editor" fail={catalog} what="the permission list" />;
  return <RoleEditor catalog={catalog.data.data} canEdit />;
}
