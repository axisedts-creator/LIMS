// SK-1 Partner pickups (04-UI-UX §4): open requests (requested, scheduled) by default.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { listPickups } from '@/features/partners/server/read.server';
import { PickupQueue } from '@/features/partners/components/PickupQueue';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partner pickups' };

export default async function PickupsPage({ searchParams }: { searchParams?: Promise<{ state?: string }> } = {}) {
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('partners.pickup.manage')) return <PermissionNotice />;
  // T0D-UILIST-3: the FilterBar state goes to the existing `state` query of listPickups; default stays the open requests.
  const state = (await searchParams)?.state;
  const list = await listPickups({ state: state || 'requested,scheduled' }).catch((e: unknown) => { if (e instanceof ApiError) return null; throw e; });
  return <PickupQueue rows={list?.data ?? []} failed={list === null} filters={{ state }} />;
}
