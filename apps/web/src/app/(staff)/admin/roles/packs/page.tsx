// RM-T05 Apply a role pack (11-ROLE-MATRIX s8; LD-150 route staff.admin.role_packs). Gate identity.role.manage before any API call.
// LD-301: listRolePacks/applyRolePack are notImplemented in the API (500 common.internal), so the page says so plainly and makes no call.
// Restore the listRolePacks + RolePackApply wiring (features/admin/roles/RolePackApply) once the API exists.
import { Denied, Frame, gate } from '@/features/admin/server/page-kit';

export default async function RolePacksPage() {
  const perms = await gate('identity.role.manage');
  if (!perms) return <Denied />;
  return (
    <Frame title="Role packs">
      <p>Role packs are not available yet.</p>
    </Frame>
  );
}
