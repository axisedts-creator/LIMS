import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { hasPermission, matchStaffRoute } from '@/core/permissions/routes';
import { getRequestPathname, getShellSession } from '@/core/session/server';
import { AppShell } from '@/core/shell/AppShell';

export const dynamic = 'force-dynamic';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const session = await getShellSession();
  // middleware resolves the session for every staff path; absent only on session-exempt paths (/auth, /queue-display)
  // that have no page of their own yet — never render the shell there.
  if (!session) notFound();
  const pathname = await getRequestPathname();
  const route = matchStaffRoute(pathname);
  const allowed = !route || hasPermission(session.actor.permissions, route.permission);
  return (
    <AppShell session={session} pathname={pathname}>
      {allowed ? children : <PermissionDenied />}
    </AppShell>
  );
}
