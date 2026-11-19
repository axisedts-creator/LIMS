// 04-UI-UX §8.7 Registers (statutory; B.S. and A.D. always). Filters from the URL.
// T0D-UILIST-2 (LD-353 rule 6): 501 = NotAvailable with the header row, 500 = ErrorState under the kept title and filters.
import { pendingOr } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { REGISTER_COLUMNS, RegistersView } from '@/features/billing/components/RegistersView';
import { readList } from '@/features/billing/components/listRead';
import { getCancelledInvoiceRegister, getCreditNoteRegister, getSalesRegister } from '@/features/billing/server/read.server';
import { parseInvoiceQuery } from '@/features/billing/server/types';

export default async function RegistersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const q = parseInvoiceQuery(sp);
  const f = { ...(q.fiscalYearBs ? { fiscalYearBs: q.fiscalYearBs } : {}), ...(q.from && q.to ? { from: q.from, to: q.to } : {}), ...(q.centreId ? { centreId: q.centreId } : {}), limit: 200 };
  return pendingOr('Registers', REGISTER_COLUMNS, async () => {
    const { value, failure } = await readList(() => Promise.all([getSalesRegister(f), getCancelledInvoiceRegister(f), getCreditNoteRegister(f)]));
    const [sales, cancelled, creditNotes] = value ?? [];
    return <RegistersView sales={sales?.data ?? []} cancelled={cancelled?.data ?? []} creditNotes={creditNotes?.data ?? []} permissions={session?.actor.permissions ?? []} {...(failure ? { failure } : {})} />;
  });
}
