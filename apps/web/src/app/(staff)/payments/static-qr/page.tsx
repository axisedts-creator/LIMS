// Fonepay QR worksheet (C15 04-UI-UX §2.5; US-PG-12). Permission is checked before any API call; only well-formed list filters reach P17.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { NotAvailable, isPending } from '@/core/shell/NotAvailable';
import { StaticQrView } from '@/features/payments/components/StaticQrView';
import { staticQrQuery } from '@/features/payments/query';
import { listStaticQrWorksheets } from '@/features/payments/server/read.server';

export default async function StaticQrPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  const query = staticQrQuery(await searchParams);
  const filter = Object.fromEntries(query);
  try {
    const list = await listStaticQrWorksheets(query);
    return <StaticQrView worksheets={list.rows.slice(0, 50)} permissions={permissions} centres={[]} query={filter} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    // T0D-UILIST-2 (LD-353 rule 6): 501 operation_pending = NotAvailable with the header row; 500+ keeps title, filters and header row with an ErrorState in the table
    if (isPending(e)) return <NotAvailable title="Fonepay QR worksheet" columns={['Date', 'Centre', 'System (NPR)', 'Statement (NPR)', 'Difference (NPR)', 'Status', 'By', 'Reference']} />;
    if (e instanceof ApiError && e.status >= 500) return <StaticQrView worksheets={[]} permissions={permissions} centres={[]} query={filter} failure={e.problem.request_id ? { requestId: e.problem.request_id } : {}} />;
    throw e; // 4xx render error.tsx
  }
}
