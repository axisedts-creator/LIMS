// PL-2 Tenants list (04-UI-UX §7). [Provision tenant] only with platform.tenant.manage.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { call, one, P, platformPermissions, qs, type SP } from '@/features/platform/server';
import { PERM, type PageOf, type Tenant } from '@/features/platform/shared';
import { TenantsTable } from '@/features/platform/TenantsTable';

export const dynamic = 'force-dynamic';
const STATUSES = ['provisioning', 'active', 'suspended', 'offboarded'];

export default async function TenantsPage({ searchParams }: { searchParams?: SP }) {
  const perms = await platformPermissions();
  if (!perms.has(PERM.read)) return <PermissionDenied />;
  const status = one((await searchParams)?.['status']);
  const r = await call<PageOf<Tenant>>(`${P}/tenants${qs({ limit: '50', status: status && STATUSES.includes(status) ? status : undefined })}`);
  return (
    <section aria-labelledby="pl2-title">
      <div className="lims-page-header">
        <h1 id="pl2-title">Tenants</h1>
        {perms.has(PERM.manage) ? <a className="lims-btn lims-btn-primary" href="/platform/tenants/new">Provision tenant</a> : null}
      </div>
      {r.ok ? <TenantsTable initial={r.data} /> : <ErrorState title="Could not load tenants" {...(r.requestId ? { requestId: r.requestId } : {})} />}
    </section>
  );
}
