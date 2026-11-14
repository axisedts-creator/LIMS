// 04-UI-UX §8.8 Audit trail (billing.data.export).
import { getShellSession } from '@/core/session/server';
import { AuditTrail } from '@/features/billing/components/AuditTrail';
import { getAuditTrail } from '@/features/billing/server/read.server';
import { parseInvoiceQuery } from '@/features/billing/server/types';

export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const q = parseInvoiceQuery(sp);
  const { data } = await getAuditTrail({ ...(q.from && q.to ? { from: q.from, to: q.to } : {}), limit: 100 });
  return <AuditTrail rows={data} permissions={session?.actor.permissions ?? []} />;
}
