// SCR-11 verify queue: unverified, active doctors newest first. Possible duplicates [CONV]: one POST /doctors/search per row (name in
// the body, D-C3-06) for the first 50 rows; a failed lookup just shows no duplicates for that row.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { DoctorVerifyQueue } from '@/features/catalog/components/DoctorVerifyQueue';
import { listDoctors } from '@/features/catalog/server/listDoctors.server';
import { searchDoctors } from '@/features/catalog/server/searchDoctors.server';
import { orForbidden } from '@/features/catalog/server/shared';
import type { DoctorSummary } from '@/features/catalog/server/types';

export default async function DoctorVerifyPage() {
  const session = await getShellSession();
  const r = await orForbidden(async () => {
    const [queue, targets] = await Promise.all([
      listDoctors({ isVerified: false, isActive: true, limit: 200, sort: '-created_at' }),
      listDoctors({ isVerified: true, isActive: true, limit: 200, sort: 'doctor_code' }),
    ]);
    const dupes: Record<string, DoctorSummary[]> = {};
    await Promise.all(
      queue.data.slice(0, 50).map(async (d) => {
        const hit = await searchDoctors({ q: d.display_name.slice(0, 64), includeUnverified: true, limit: 10 }).catch(() => undefined);
        const others = (hit?.data ?? []).filter((x) => x.id !== d.id);
        if (others.length) dupes[d.id] = others;
      }),
    );
    return { queue: queue.data, targets: targets.data, dupes };
  });
  if (!r) return <CatalogForbidden />;
  return <DoctorVerifyQueue doctors={r.queue} possibleDuplicates={r.dupes} mergeTargets={r.targets} permissions={session?.actor.permissions ?? []} />;
}
