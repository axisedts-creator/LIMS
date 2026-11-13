// AD-6 Branches (C2 04-UI-UX §1, §6). View: identity.user.read; edit: identity.centre.manage (08 A13 D-16).
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Branch } from '@/features/admin/lib';
import { OrgUnits } from '@/features/admin/components/OrgUnits';

export default async function BranchesPage() {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const r = await call<{ data: Branch[] }>('GET', '/v1/identity/branches');
  if (!r.ok) return <LoadError fail={r} what="branches" />;
  return <OrgUnits kind="branches" units={r.data.data as never} branches={r.data.data} canEdit={perms.has('identity.centre.manage')} />;
}
