// 04-UI-UX §8.2 (route staff.billing.invoice) — fiscal layout + side panel.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { InvoiceDetailView } from '@/features/billing/components/InvoiceDetailView';
import { getInvoice, listCreditNotesForInvoice, listInvoicePrints } from '@/features/billing/server/read.server';

export default async function InvoicePage({ params }: { params: Promise<{ invoice_id: string }> }) {
  const [session, { invoice_id }] = await Promise.all([getShellSession(), params]);
  try {
    const [invoice, prints, creditNotes] = await Promise.all([getInvoice(invoice_id), listInvoicePrints(invoice_id), listCreditNotesForInvoice(invoice_id)]);
    return <InvoiceDetailView invoice={invoice} prints={prints.data} creditNotes={creditNotes.data} permissions={session?.actor.permissions ?? []} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
