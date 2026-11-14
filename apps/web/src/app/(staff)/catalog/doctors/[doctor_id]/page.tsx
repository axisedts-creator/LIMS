// SCR-11 doctor detail. Contact fields are whatever the API sent (it omits them without catalog.referrer.manage).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { DoctorDetail } from '@/features/catalog/components/DoctorDetail';
import { getDoctor } from '@/features/catalog/server/getDoctor.server';
import { listDoctors } from '@/features/catalog/server/listDoctors.server';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';

export default async function DoctorPage({ params }: { params: Promise<{ doctor_id: string }> }) {
  const [{ doctor_id }, session] = await Promise.all([params, getShellSession()]);
  const r = await orForbidden(async () => {
    const doctor = await orMissing(() => getDoctor(doctor_id));
    if (!doctor) return undefined;
    const targets = await listDoctors({ isVerified: true, isActive: true, limit: 200, sort: 'doctor_code' });
    return { doctor, targets: targets.data };
  });
  if (r === null) return <CatalogForbidden />;
  if (!r) notFound();
  return <DoctorDetail doctor={r.doctor} mergeTargets={r.targets} permissions={session?.actor.permissions ?? []} />;
}
