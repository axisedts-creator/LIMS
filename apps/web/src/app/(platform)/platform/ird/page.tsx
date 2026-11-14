// PL-4 IRD Annex tracker (all tenants). Query filters are validated before they reach the API.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { IrdTracker } from '@/features/platform/IrdTracker';
import { call, one, P, platformPermissions, qs, type SP } from '@/features/platform/server';
import { ANNEX_CODES, ANNEX_STATUSES, PERM, isUuid, type AnnexRecord, type PageOf, type Tenant } from '@/features/platform/shared';

export const dynamic = 'force-dynamic';

export default async function IrdPage({ searchParams }: { searchParams?: SP }) {
  const perms = await platformPermissions();
  if (!perms.has(PERM.read)) return <PermissionDenied />;
  const sp = (await searchParams) ?? {};
  const tenantId = one(sp['tenant_id']);
  const annex = one(sp['annex_code']);
  const status = one(sp['status']);
  const filter = {
    tenant_id: isUuid(tenantId) ? tenantId : undefined,
    annex_code: annex && (ANNEX_CODES as readonly string[]).includes(annex) ? annex : undefined,
    status: status && (ANNEX_STATUSES as readonly string[]).includes(status) ? status : undefined,
  };
  const [tenants, annexes] = await Promise.all([
    call<PageOf<Tenant>>(`${P}/tenants?limit=200`),
    call<{ data: AnnexRecord[] }>(`${P}/ird-annexes${qs(filter)}`),
  ]);
  const failed = !tenants.ok ? tenants : !annexes.ok ? annexes : undefined;
  return (
    <section aria-labelledby="pl4-title">
      <h1 id="pl4-title">IRD annexes</h1>
      {failed || !tenants.ok || !annexes.ok ? (
        <ErrorState title="Could not load the IRD annexes" {...(failed?.requestId ? { requestId: failed.requestId } : {})} />
      ) : (
        <IrdTracker
          tenants={tenants.data.data.filter((t) => !filter.tenant_id || t.tenant_id === filter.tenant_id).map((t) => ({ tenant_id: t.tenant_id, code: t.code }))}
          records={annexes.data.data}
          canManage={perms.has(PERM.manage)}
        />
      )}
    </section>
  );
}
