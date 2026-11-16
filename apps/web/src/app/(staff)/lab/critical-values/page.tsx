// C5 04-UI-UX §1 / §3.9 (route /lab/critical-values, lab.critical_value.read). LD-255 (FOUNDER): the administrator and lab staff reach the critical value list from the menu.
// Permission first (the API is never called without it); a 403 from the API is the permission-denied page, any other failure (including 400) throws to error.tsx.
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { CriticalValueList } from '@/features/lab/components/CriticalValueList';
import { CRITICAL_STATUSES, listCriticalValues } from '@/features/lab/server/adminpages.server';

export const metadata = { title: 'Critical values' };

export default async function CriticalValuesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp = {}] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('lab.critical_value.read')) return <PermissionDenied />;
  try {
    const page = await listCriticalValues(sp);
    const status = typeof sp['status'] === 'string' && (CRITICAL_STATUSES as readonly string[]).includes(sp['status']) ? sp['status'] : undefined;
    return <CriticalValueList items={page.items} status={status} nextCursor={page.nextCursor} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e;
  }
}
