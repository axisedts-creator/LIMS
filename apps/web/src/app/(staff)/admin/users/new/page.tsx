// AD-2 Invite user (C2 04-UI-UX §6). Gate identity.user.manage before any API call.
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Branch, Centre, Role } from '@/features/admin/lib';
import { InviteForm } from '@/features/admin/components/InviteForm';

export default async function InviteUserPage() {
  if (!(await gate('identity.user.manage'))) return <Denied />;
  const [roles, centres, branches] = await Promise.all([
    call<{ data: Role[] }>('GET', '/v1/identity/roles'),
    call<{ data: Centre[] }>('GET', '/v1/identity/centres'),
    call<{ data: Branch[] }>('GET', '/v1/identity/branches'),
  ]);
  const failed = [roles, centres, branches].find((r) => !r.ok);
  return (
    <Frame title="Invite user">
      {failed && !failed.ok ? <LoadError fail={failed} what="the invitation form" /> : roles.ok && centres.ok && branches.ok ? (
        <InviteForm roles={roles.data.data} centres={centres.data.data} branches={branches.data.data} />
      ) : null}
    </Frame>
  );
}
