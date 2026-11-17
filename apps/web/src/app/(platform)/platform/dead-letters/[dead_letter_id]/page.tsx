// PL-6 Dead letter detail (route staff.platform.dead_letter, platform.dead_letter.manage). A malformed id never reaches the API.
import { notFound } from 'next/navigation';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { DeadLetterDetail } from '@/features/platform/DeadLetters';
import { call, P, platformPermissions } from '@/features/platform/server';
import { PERM, isUuid, type DeadLetter, type Tenant } from '@/features/platform/shared';

export const dynamic = 'force-dynamic';

export default async function DeadLetterPage({ params }: { params: Promise<{ dead_letter_id: string }> }) {
  if (!(await platformPermissions()).has(PERM.deadLetters)) return <PermissionDenied />;
  const { dead_letter_id } = await params;
  if (!isUuid(dead_letter_id)) notFound();
  const r = await call<DeadLetter>(`${P}/dead-letters/${dead_letter_id}`);
  if (!r.ok && r.status === 404) notFound();
  if (!r.ok) return <ErrorState title="Could not load the dead letter" {...(r.requestId ? { requestId: r.requestId } : {})} />;
  let tenantCode = 'Platform (no tenant)';
  if (r.data.tenant_id && isUuid(r.data.tenant_id)) {
    const t = await call<Tenant>(`${P}/tenants/${r.data.tenant_id}`);
    tenantCode = t.ok ? t.data.code : r.data.tenant_id;
  }
  return (
    <section aria-labelledby="pl6-detail-title">
      <h1 id="pl6-detail-title">Dead letter</h1>
      <p><a href="/platform/dead-letters">Back to dead letters</a></p>
      <DeadLetterDetail row={r.data} tenantCode={tenantCode} />
    </section>
  );
}
