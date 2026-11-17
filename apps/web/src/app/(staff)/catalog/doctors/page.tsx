// SCR-11 Doctors — list. Filters arrive as URL params (is_verified, is_active, source); anything else is ignored. 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { DoctorsList } from '@/features/catalog/components/DoctorsList';
import { listDoctors } from '@/features/catalog/server/listDoctors.server';
import { orForbidden } from '@/features/catalog/server/shared';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export default async function DoctorsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const verified = one(sp['is_verified']);
  const active = one(sp['is_active']);
  const source = one(sp['source']);
  const r = await orForbidden(() =>
    listDoctors({
      isActive: active === 'true' ? true : active === 'false' ? false : 'all',
      limit: 200,
      sort: 'doctor_code',
      ...(verified === 'true' || verified === 'false' ? { isVerified: verified === 'true' } : {}),
      ...(source === 'back_office' || source === 'quick_add' || source === 'import' ? { source } : {}),
    }),
  );
  if (!r) return <CatalogForbidden />;
  return <DoctorsList doctors={r.data} permissions={session?.actor.permissions ?? []} />;
}
