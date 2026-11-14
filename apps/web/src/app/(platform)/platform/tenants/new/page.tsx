// PL-2 Provision tenant (needs platform.tenant.manage).
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { ProvisionForm } from '@/features/platform/ProvisionForm';
import { platformPermissions } from '@/features/platform/server';
import { PERM } from '@/features/platform/shared';

export const dynamic = 'force-dynamic';

export default async function ProvisionTenantPage() {
  if (!(await platformPermissions()).has(PERM.manage)) return <PermissionDenied />;
  return (
    <section aria-labelledby="pl2-new-title">
      <h1 id="pl2-new-title">Provision a new tenant</h1>
      <ProvisionForm />
    </section>
  );
}
