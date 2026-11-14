// W4 Phlebotomy phones (C17 04-UI-UX §2.4). Permission is checked before any API call. The wipe reasons (H20) and the minimum app version (H18) are
// optional extras: a device manager need not hold settings.manage, so a refusal there leaves the table and only drops the extra.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { DevicesView } from '@/features/homecollection/components/DevicesView';
import { deviceQuery } from '@/features/homecollection/query';
import { getSettings, listDevices, listReasons } from '@/features/homecollection/server/read.server';

export default async function DevicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('homecollection.device.manage')) notFound();
  const sp = await searchParams;
  const { q } = deviceQuery(sp);
  try {
    // allSettled: every request finishes before the page answers; only the H16 failure matters.
    const [devices, reasons, settings] = await Promise.allSettled([listDevices(q), listReasons('wipe_reasons'), getSettings()] as const);
    if (devices.status === 'rejected') throw devices.reason;
    return (
      <DevicesView
        devices={devices.value.rows} codes={{ wipe_reasons: reasons.status === 'fulfilled' ? reasons.value : [] }}
        minAppVersion={settings.status === 'fulfilled' ? settings.value.min_app_version : undefined} permissions={permissions} nextCursor={devices.value.next}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e;
  }
}
