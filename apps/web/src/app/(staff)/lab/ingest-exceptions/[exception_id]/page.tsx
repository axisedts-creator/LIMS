// 04-UI-UX §3.10, route staff.lab.ingest_exception. A malformed id never reaches the API (read.server validates it) → notFound(); an unknown / foreign-tenant id (404) → notFound(); other errors → error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { IngestExceptionDetail } from '@/features/lab/components/IngestExceptionDetail';
import { getIngestException, listDiscardReasons } from '@/features/lab/server/read.server';

export const metadata = { title: 'Instrument exception' };

export default async function IngestExceptionPage({ params }: { params: Promise<{ exception_id: string }> }) {
  const { exception_id } = await params;
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  const exception = await getIngestException(exception_id).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  // the discard reasons are only needed by someone who can act on an open exception
  const discardReasons = exception.status === 'open' && permissions.includes('lab.result.enter') ? await listDiscardReasons() : [];
  return <IngestExceptionDetail exception={exception} permissions={permissions} discardReasons={discardReasons} />;
}
