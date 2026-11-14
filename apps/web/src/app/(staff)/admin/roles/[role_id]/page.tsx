// AD-5 Role editor (C2 04-UI-UX §6). Gate identity.user.read (view); editing needs identity.role.manage.
import { notFound } from 'next/navigation';
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import { SEG_RE, type Permission, type Role } from '@/features/admin/lib';
import { RoleEditor } from '@/features/admin/components/RoleEditor';

export default async function RolePage({ params }: { params: Promise<{ role_id: string }> }) {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const { role_id: id } = await params;
  if (!SEG_RE.test(id)) notFound();
  const [role, catalog] = await Promise.all([
    call<Role>('GET', `/v1/identity/roles/${encodeURIComponent(id)}`),
    call<{ data: Permission[] }>('GET', '/v1/identity/permissions'),
  ]);
  if (!role.ok && role.status === 404) notFound();
  if (!role.ok) return <LoadError fail={role} what="this role" />;
  if (!catalog.ok) return <LoadError fail={catalog} what="the permission list" />;
  return <RoleEditor role={role.data} catalog={catalog.data.data} canEdit={perms.has('identity.role.manage')} />;
}
