// 04-UI-UX §8.8 Audit trail (billing.data.export).
// T0D-UILIST-2 (LD-353 rule 6): 501 = NotAvailable with the header row, 500 = ErrorState under the kept title and filters.
import { pendingOr } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { AUDIT_COLUMNS, AuditTrail } from '@/features/billing/components/AuditTrail';
import { readList } from '@/features/billing/components/listRead';
import { getAuditTrail } from '@/features/billing/server/read.server';
import { parseInvoiceQuery } from '@/features/billing/server/types';

export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const q = parseInvoiceQuery(sp);
  return pendingOr('Audit trail', AUDIT_COLUMNS, async () => {
    const { value, failure } = await readList(() => getAuditTrail({ ...(q.from && q.to ? { from: q.from, to: q.to } : {}), limit: 100 }));
    return <AuditTrail rows={value?.data ?? []} permissions={session?.actor.permissions ?? []} {...(failure ? { failure } : {})} />;
  });
}
