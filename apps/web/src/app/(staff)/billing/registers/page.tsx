// 04-UI-UX §8.7 Registers (statutory; B.S. and A.D. always). Filters from the URL.
import { getShellSession } from '@/core/session/server';
import { RegistersView } from '@/features/billing/components/RegistersView';
import { getCancelledInvoiceRegister, getCreditNoteRegister, getSalesRegister } from '@/features/billing/server/read.server';
import { parseInvoiceQuery } from '@/features/billing/server/types';

export default async function RegistersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const q = parseInvoiceQuery(sp);
  const f = { ...(q.fiscalYearBs ? { fiscalYearBs: q.fiscalYearBs } : {}), ...(q.from && q.to ? { from: q.from, to: q.to } : {}), ...(q.centreId ? { centreId: q.centreId } : {}), limit: 200 };
  const [sales, cancelled, creditNotes] = await Promise.all([getSalesRegister(f), getCancelledInvoiceRegister(f), getCreditNoteRegister(f)]);
  return <RegistersView sales={sales.data} cancelled={cancelled.data} creditNotes={creditNotes.data} permissions={session?.actor.permissions ?? []} />;
}
