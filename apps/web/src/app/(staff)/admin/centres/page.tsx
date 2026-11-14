// AD-7 Collection centres (C2 04-UI-UX §1, §6). View: identity.centre.read; edit: identity.centre.manage (08 A13 D-16).
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Branch, Centre } from '@/features/admin/lib';
import { OrgUnits } from '@/features/admin/components/OrgUnits';

export default async function CentresPage() {
  const perms = await gate('identity.centre.read');
  if (!perms) return <Denied />;
  const [centres, branches] = await Promise.all([
    call<{ data: Centre[] }>('GET', '/v1/identity/centres'),
    call<{ data: Branch[] }>('GET', '/v1/identity/branches'),
  ]);
  if (!centres.ok) return <LoadError fail={centres} what="collection centres" />;
  if (!branches.ok) return <LoadError fail={branches} what="branches" />;
  return <OrgUnits kind="centres" units={centres.data.data as never} branches={branches.data.data} canEdit={perms.has('identity.centre.manage')} />;
}
