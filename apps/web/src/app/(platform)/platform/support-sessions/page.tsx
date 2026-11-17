// PL-5 Support sessions (platform.tenant.read; opening needs platform.support_session.open).
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { call, P, platformPermissions } from '@/features/platform/server';
import { PERM, type PageOf, type SupportSession, type Tenant } from '@/features/platform/shared';
import { SupportSessions } from '@/features/platform/SupportSessions';

export const dynamic = 'force-dynamic';

export default async function SupportSessionsPage() {
  const perms = await platformPermissions();
  if (!perms.has(PERM.read)) return <PermissionDenied />;
  const [tenants, sessions] = await Promise.all([
    call<PageOf<Tenant>>(`${P}/tenants?limit=200`),
    call<PageOf<SupportSession>>(`${P}/support-sessions?limit=200`),
  ]);
  const failed = !tenants.ok ? tenants : !sessions.ok ? sessions : undefined;
  return (
    <section aria-labelledby="pl5-title">
      <h1 id="pl5-title">Support sessions</h1>
      {failed || !tenants.ok || !sessions.ok ? (
        <ErrorState title="Could not load support sessions" {...(failed?.requestId ? { requestId: failed.requestId } : {})} />
      ) : (
        <SupportSessions
          sessions={sessions.data.data}
          tenants={tenants.data.data.filter((t) => t.status !== 'offboarded').map((t) => ({ tenant_id: t.tenant_id, code: t.code, display_name: t.display_name }))}
          canOpen={perms.has(PERM.supportOpen)}
          canAdminScope={perms.has(PERM.manage)}
        />
      )}
    </section>
  );
}
