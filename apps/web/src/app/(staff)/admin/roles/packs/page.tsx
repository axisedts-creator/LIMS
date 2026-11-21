// RM-T05 Apply a role pack (11-ROLE-MATRIX s8; LD-150 route staff.admin.role_packs). Gate identity.role.manage before any API call.
// LD-301: listRolePacks/applyRolePack are notImplemented in the API (500 common.internal), so the page says so plainly and makes no call.
// Restore the listRolePacks + RolePackApply wiring (features/admin/roles/RolePackApply) once the API exists.
import { NotAvailable } from '@lims/ui/components/NotAvailable';
import { Denied, gate } from '@/features/admin/server/page-kit';

export default async function RolePacksPage() {
  const perms = await gate('identity.role.manage');
  if (!perms) return <Denied />;
  return (
    // T0D-UIGUARD-1-ADMIN (LD-353 rule 6, LD-439): the kit NotAvailable state (calm, no error), with the page title row
    <main className="lims-page">
      <NotAvailable title="Role packs" helpKey="admin.roles" body="Role packs are not available yet." />
    </main>
  );
}
