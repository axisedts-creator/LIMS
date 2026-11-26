import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { hasPermission, matchStaffRoute } from '@/core/permissions/routes';
import { getRequestPathname, getShellSession } from '@/core/session/server';
import { AppShell } from '@/core/shell/AppShell';
import { bellNotices } from './_lib/bell';
import { OfflineProvider } from '@/core/offline/ui/OfflineProvider';
import { getTatAlertBadge } from './quality/_lib/nav-badge';

export const dynamic = 'force-dynamic';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const session = await getShellSession();
  // middleware resolves the session for every staff path; absent only on session-exempt paths (/auth, /queue-display)
  // that have no page of their own yet — never render the shell there.
  if (!session) notFound();
  const pathname = await getRequestPathname();
  const route = matchStaffRoute(pathname);
  const allowed = !route || hasPermission(session.actor.permissions, route.permission);
  // T0D-BUILD-5 (LD-455): one TAT badge call per request; it never throws (failures are logged and give no badge).
  const tat = await getTatAlertBadge().catch(() => undefined);
  // PHLEBO-UI-FULL-1 bell: new phlebotomist applications for people who may review them. A failed read never breaks the page.
  const notifications = await bellNotices(session.actor.permissions);
  const counts = tat || notifications?.length
    ? { ...(tat ? { 'quality.tat_alerts': tat } : {}), ...(notifications?.length ? { 'homecollection.applications': notifications.length } : {}) }
    : undefined;
  // T0D-OFFLINE-2 (LD-322): the provider starts the offline layer in the browser for roles with sync.use; the shell shows its chip,
  // banner and unlock overlay only once it runs. Without IndexedDB or sync.use nothing changes.
  return (
    <OfflineProvider live={{ userId: session.actor.membershipId ?? '', permissions: session.actor.permissions }}>
      <AppShell session={session} pathname={pathname} menu="elab" {...(counts ? { counts } : {})} {...(notifications ? { notifications } : {})}>
        {allowed ? children : <PermissionDenied />}
      </AppShell>
    </OfflineProvider>
  );
}
