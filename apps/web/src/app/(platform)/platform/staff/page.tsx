// PL-7 Platform staff + sessions (platform.staff.manage; 07-SECURITY E-6).
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { call, P, platformPermissions } from '@/features/platform/server';
import { PERM, type StaffMember } from '@/features/platform/shared';
import { StaffConsole } from '@/features/platform/StaffConsole';

export const dynamic = 'force-dynamic';

export default async function StaffPage() {
  if (!(await platformPermissions()).has(PERM.staff)) return <PermissionDenied />;
  const r = await call<{ data: StaffMember[] }>(`${P}/staff`);
  return (
    <section aria-labelledby="pl7-title">
      <h1 id="pl7-title">Platform staff</h1>
      {r.ok ? <StaffConsole staff={r.data.data} /> : <ErrorState title="Could not load platform staff" {...(r.requestId ? { requestId: r.requestId } : {})} />}
    </section>
  );
}
