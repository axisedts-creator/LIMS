// ME-1 My account (C2 04-UI-UX §5). Gate identity.self.manage before any API call.
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Page, Role, SessionSummary } from '@/features/admin/lib';
import { MyAccount, type Factor, type Me, type ReadFail } from '@/features/admin/components/MyAccount';

export default async function MyAccountPage() {
  const perms = await gate('identity.self.manage');
  if (!perms) return <Denied />;
  const [me, sessions, factors, roles] = await Promise.all([
    call<Me>('GET', '/v1/identity/me'),
    call<Page<SessionSummary>>('GET', '/v1/identity/me/sessions', { query: { limit: '50' } }),
    call<{ data: Factor[] }>('GET', '/v1/identity/me/mfa-factors'),
    perms.has('identity.user.read') ? call<{ data: Role[] }>('GET', '/v1/identity/roles') : null,
  ]);
  if (!me.ok) return <LoadError fail={me} what="your account" />;
  // [CONV] Me has no "MFA required" flag: derive it from the role catalogue when readable; otherwise protect the last factor (fail safe).
  const own = new Set(me.data.roles.map((r) => r.code));
  const mfaRequired = roles?.ok ? roles.data.data.some((r) => own.has(r.code) && r.mfa_required) : true;
  // T0D-ELABMENU-2 (LD-340): a failed read is passed on as a failure, never as an empty list (a 401 must not look like "no factors").
  const failOf = (f: { code: string; requestId?: string }): ReadFail => ({ code: f.code, ...(f.requestId ? { requestId: f.requestId } : {}) });
  return (
    <MyAccount
      me={me.data}
      sessions={sessions.ok ? sessions.data.data : failOf(sessions)}
      factors={factors.ok ? factors.data.data : failOf(factors)}
      mfaRequired={mfaRequired}
    />
  );
}
