// 04-UI-UX §3.10, route staff.lab.ingest_exceptions (/lab/ingest-exceptions, CR-C7-014). A failed read throws → error.tsx (an empty list would say "No open instrument exceptions." while exceptions wait).
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { IngestExceptionList } from '@/features/lab/components/IngestExceptionList';
import { listIngestExceptions } from '@/features/lab/server/read.server';

export const metadata = { title: 'Instrument exceptions' };

export default async function IngestExceptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  // T0D-UILIST-1, T0D-UICONSOLE-1 (LD-353 rule 6): 501 operation_pending keeps the title and the console header row; every other failure still throws
  return pendingOr('Instrument exceptions', ['Age', 'Barcode', 'Reason', 'Instrument code', 'Status'], async () => {
    const page = await listIngestExceptions(sp);
    const status = typeof sp['status'] === 'string' && ['open', 'resolved', 'discarded'].includes(sp['status']) ? sp['status'] : 'open';
    return <IngestExceptionList items={page.items} status={status} permissions={session?.actor.permissions ?? []} {...(page.nextCursor ? { nextCursor: page.nextCursor } : {})} />;
  });
}
