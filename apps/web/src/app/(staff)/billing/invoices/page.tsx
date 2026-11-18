// 04-UI-UX §8.1 — server component; data via BFF server functions (02-CONVENTIONS §2.4). Filters/sort live in the URL.
// T0D-UILIST-2 (LD-353 rule 6): 501 operation_pending = NotAvailable with the header row; a 500 keeps the title and the FilterBar with an ErrorState.
import { pendingOr } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { INVOICE_COLUMNS, InvoicesList } from '@/features/billing/components/InvoicesList';
import { readList } from '@/features/billing/components/listRead';
import { listInvoices } from '@/features/billing/server/read.server';
import { parseInvoiceQuery } from '@/features/billing/server/types';

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  return pendingOr('Invoices', INVOICE_COLUMNS, async () => {
    const { value, failure } = await readList(() => listInvoices({ ...parseInvoiceQuery(sp), limit: 50 }));
    // Centres in scope: no core API in apps/web yet (CR .orchestra/cr/BL-T20.md); the Centre filter has no options until then.
    return <InvoicesList invoices={value?.data ?? []} permissions={session?.actor.permissions ?? []} centres={[]} {...(failure ? { failure } : {})} />;
  });
}
