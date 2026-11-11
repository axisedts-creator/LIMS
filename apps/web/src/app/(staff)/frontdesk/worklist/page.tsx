// 04-UI-UX §6 (route /frontdesk/worklist). Each list loads independently: a failing list shows a banner in its tab (03-APP-FLOW §4: Error = banner),
// never a stale "Nothing pending". Possible duplicates (F26) are only fetched for frontdesk.registration.create.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { FrontdeskWorklist } from '@/features/frontdesk/components/FrontdeskWorklist';
import { listCodedSet, listOpenFlags, listOrders, listPossibleDuplicates } from '@/features/frontdesk/server/read.server';

export const metadata = { title: 'Front-desk worklist' };

/** An API failure becomes null (shown as a banner); anything else is a bug and rethrows to error.tsx. */
const settle = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError) return null;
    throw e;
  }
};

export default async function WorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  const dupes = perms.includes('frontdesk.registration.create');
  const [flags, orders, pre, duplicates, resolutions] = await Promise.all([
    settle(listOpenFlags()),
    settle(listOrders()),
    settle(listOrders('pre_registered')),
    dupes ? settle(listPossibleDuplicates()) : null,
    perms.includes('frontdesk.order.edit') ? settle(listCodedSet('flag_resolutions')) : [],
  ]);
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
