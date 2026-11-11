// PL-3 Tenant detail (route staff.platform.tenant, platform.tenant.read). A malformed id never reaches the API.
import { notFound } from 'next/navigation';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { call, P, platformPermissions } from '@/features/platform/server';
import { PERM, isUuid, type TenantDetail } from '@/features/platform/shared';
import { TenantDetailView } from '@/features/platform/TenantDetail';

export const dynamic = 'force-dynamic';

export default async function TenantDetailPage({ params }: { params: Promise<{ tenant_id: string }> }) {
  const perms = await platformPermissions();
  if (!perms.has(PERM.read)) return <PermissionDenied />;
  const { tenant_id } = await params;
  if (!isUuid(tenant_id)) notFound();
  const r = await call<TenantDetail>(`${P}/tenants/${tenant_id}`);
  if (!r.ok && r.status === 404) notFound();
  if (!r.ok) return <ErrorState title="Could not load the tenant" {...(r.requestId ? { requestId: r.requestId } : {})} />;
  return (
    <section aria-label="Tenant">
      <TenantDetailView tenant={r.data} canManage={perms.has(PERM.manage)} />
    </section>
  );
}
