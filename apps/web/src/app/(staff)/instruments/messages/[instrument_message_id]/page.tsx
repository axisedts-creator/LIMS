// SCR-10 Message detail — server component. Malformed id / 404 (incl. another centre's message) → notFound(); other errors → error.tsx.
// The raw message is NOT read here: "Show raw" fetches it on demand (every view is access-logged).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { MessageDetail } from '@/features/instruments/components/MessageDetail';
import { getInstrumentMessage } from '@/features/instruments/server/getInstrumentMessage.server';
import { UUID_RE } from '@/features/instruments/server/types';

export default async function MessageDetailPage({ params }: { params: Promise<{ instrument_message_id: string }> }) {
  const { instrument_message_id } = await params;
  if (!UUID_RE.test(instrument_message_id)) notFound(); // never forwarded to the API
  const [session, message] = await Promise.all([
    getShellSession(),
    getInstrumentMessage(instrument_message_id).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
  ]);
  return <MessageDetail message={message} permissions={session?.actor.permissions ?? []} />;
}
