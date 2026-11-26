// PHLEBO-UI-FULL-1 Phlebo applications. Permission is checked before any API call.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { ApplicationsView } from '@/features/homecollection/components/ApplicationsView';
import { listApplications, listPhleboRoles } from '@/features/homecollection/server/applications.server';
import { listCentres } from '@/features/homecollection/server/read.server';

const STATUSES = ['submitted', 'approved', 'rejected'];

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('homecollection.application.manage')) notFound();
  const sp = await searchParams;
  const status = typeof sp['status'] === 'string' && STATUSES.includes(sp['status']) ? sp['status'] : 'submitted';
  try {
    // Roles and centres are only needed to approve: a reviewer who cannot read them still sees the list and can reject.
    const [list, roles, centres] = await Promise.allSettled([listApplications(status), listPhleboRoles(), listCentres()] as const);
    if (list.status === 'rejected') throw list.reason;
    return (
      <ApplicationsView
        applications={list.value.rows} waiting={list.value.submitted} status={status}
        roles={roles.status === 'fulfilled' ? roles.value : []}
        centres={centres.status === 'fulfilled' ? centres.value.map((c) => ({ id: c.id, name: c.name })) : []}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e;
  }
}
