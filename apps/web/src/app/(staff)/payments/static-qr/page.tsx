// Fonepay QR worksheet (C15 04-UI-UX §2.5; US-PG-12). Permission is checked before any API call; only well-formed list filters reach P17.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { StaticQrView } from '@/features/payments/components/StaticQrView';
import { staticQrQuery } from '@/features/payments/query';
import { listStaticQrWorksheets } from '@/features/payments/server/read.server';

export default async function StaticQrPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  const query = staticQrQuery(await searchParams);
  try {
    const list = await listStaticQrWorksheets(query);
    return <StaticQrView worksheets={list.rows.slice(0, 50)} permissions={permissions} centres={[]} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
