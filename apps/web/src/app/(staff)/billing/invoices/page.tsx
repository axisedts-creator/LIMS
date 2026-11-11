// 04-UI-UX §8.1 — server component; data via BFF server functions (02-CONVENTIONS §2.4). Filters/sort live in the URL.
import { getShellSession } from '@/core/session/server';
import { InvoicesList } from '@/features/billing/components/InvoicesList';
import { listInvoices } from '@/features/billing/server/read.server';
import { parseInvoiceQuery } from '@/features/billing/server/types';

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const { data } = await listInvoices({ ...parseInvoiceQuery(sp), limit: 50 });
  // Centres in scope: no core API in apps/web yet (CR .orchestra/cr/BL-T20.md); the Centre filter has no options until then.
  return <InvoicesList invoices={data} permissions={session?.actor.permissions ?? []} centres={[]} />;
}
