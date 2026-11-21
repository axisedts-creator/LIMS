// 04-UI-UX §6 (route /frontdesk/worklist). Each list loads independently: a failing list shows an ErrorState in its tab's table (T0D-UILIST-2, LD-353 rule 6),
// never a stale "Nothing pending". Possible duplicates (F26) are only fetched for frontdesk.registration.create.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { NotAvailable, isPending } from '@/core/shell/NotAvailable';
import { FrontdeskWorklist } from '@/features/frontdesk/components/FrontdeskWorklist';
import { listCodedSet, listOpenFlags, listOrders, listPossibleDuplicates } from '@/features/frontdesk/server/read.server';

export const metadata = { title: 'Front-desk worklist' };

/** An API failure becomes null (an ErrorState in that tab's table); 501 operation_pending becomes 'pending'; anything else is a bug and rethrows to error.tsx. */
const settle = async <T,>(p: Promise<T>): Promise<T | null | 'pending'> => {
  try {
    return await p;
  } catch (e) {
    if (isPending(e)) return 'pending';
    if (e instanceof ApiError) return null;
    throw e;
  }
};
const got = <T,>(v: T | null | 'pending'): T | null => (v === 'pending' ? null : v);

export default async function WorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  const dupes = perms.includes('frontdesk.registration.create');
  const [flagsR, ordersR, preR, duplicatesR, resolutionsR] = await Promise.all([
    settle(listOpenFlags()),
    settle(listOrders()),
    settle(listOrders('pre_registered')),
    dupes ? settle(listPossibleDuplicates()) : null,
    perms.includes('frontdesk.order.edit') ? settle(listCodedSet('flag_resolutions')) : [],
  ]);
  // T0D-UILIST-2 (LD-353 rule 6): the flag list (first tab) not built yet = NotAvailable with its header row; other lists that are pending show their tab's ErrorState
  if (flagsR === 'pending') return <NotAvailable title="Front-desk worklist" columns={['Accession no.', 'Patient', 'Tests', 'Registered', 'Time elapsed', 'Status', 'Actions']} />;
  const [flags, orders, pre, duplicates, resolutions] = [got(flagsR), got(ordersR), got(preR), got(duplicatesR), got(resolutionsR)];
  const failed = [...(flags ? [] : ['flags' as const]), ...(pre ? [] : ['preRegistered' as const]), ...(dupes && !duplicates ? ['duplicates' as const] : [])];
  return (
    <FrontdeskWorklist
      flags={flags?.data ?? []}
      orders={orders?.data ?? []}
      preRegistered={(pre?.data ?? []).filter((o) => o.status === 'pre_registered')}
      duplicates={duplicates?.data ?? []}
      resolutions={resolutions ?? []}
      permissions={perms}
      failed={failed}
    />
  );
}
