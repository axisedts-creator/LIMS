// 04-UI-UX §3.8 (route /lab/approval). A failed read throws → error.tsx (an empty list would say "Nothing waiting" while results wait).
// T0D-UICONSOLE-2 (LD-353 rule 6): 501 operation_pending keeps the console (title, filter, queue header row) and shows Not available yet; every other failure still throws.
import { isPending } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { ApprovalQueue } from '@/features/lab/components/ApprovalQueue';
import { listVerificationQueue } from '@/features/lab/server/read.server';

export const metadata = { title: 'Approve' };

export default async function ApprovalPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  try {
    return <ApprovalQueue items={await listVerificationQueue('approve', sp)} permissions={permissions} />;
  } catch (e) {
    if (isPending(e)) return <ApprovalQueue items={[]} permissions={permissions} pending />;
    throw e;
  }
}
