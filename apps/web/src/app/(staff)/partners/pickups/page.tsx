// SK-1 Partner pickups (04-UI-UX §4): open requests (requested, scheduled) by default.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { listPickups } from '@/features/partners/server/read.server';
import { PickupQueue } from '@/features/partners/components/PickupQueue';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partner pickups' };

export default async function PickupsPage() {
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('partners.pickup.manage')) return <PermissionNotice />;
  const list = await listPickups({ state: 'requested,scheduled' }).catch((e: unknown) => { if (e instanceof ApiError) return null; throw e; });
  return <PickupQueue rows={list?.data ?? []} failed={list === null} />;
}
