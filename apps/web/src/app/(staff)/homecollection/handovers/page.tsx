// W3 Tube handovers (C17 04-UI-UX §2.3). Permission is checked before any API call; the URL is reduced to a whitelisted H13 query; every row is rebuilt
// from an allow-list in read.server.ts (no items, no visit ids). A 403 from the API renders PermissionDenied; anything else reaches error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { HandoversView } from '@/features/homecollection/components/HandoversView';
import { handoverQuery } from '@/features/homecollection/query';
import { listCentres, listHandovers } from '@/features/homecollection/server/read.server';

export default async function HandoversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('homecollection.handover.receive')) notFound();
  const sp = await searchParams;
  const centres = await listCentres().catch(() => []); // a centre list that cannot be read must not break the page
  const { status, centreId, q } = handoverQuery(sp, centres);
  try {
    const list = await listHandovers(q);
    return <HandoversView handovers={list.rows} centres={centres} centreId={centreId} status={status} permissions={permissions} nextCursor={list.next} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e;
  }
}
