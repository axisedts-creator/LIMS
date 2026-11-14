// SCR-09 Messages — server component; data via BFF server functions (02-CONVENTIONS §2.4). Filters live in the URL; the URL never carries a sample
// identifier, and nothing outside the documented filter names is read from it. Default range: last 24 h (AC-18.1).
import { getShellSession } from '@/core/session/server';
import { MessagesList } from '@/features/instruments/components/MessagesList';
import { listAgents } from '@/features/instruments/server/listAgents.server';
import { listInstrumentMessages } from '@/features/instruments/server/listInstrumentMessages.server';
import { listInstruments } from '@/features/instruments/server/listInstruments.server';
import { listMessageRejections } from '@/features/instruments/server/listMessageRejections.server';
import { parseMessageFilters, parseMessageRange } from '@/features/instruments/server/messages';

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const range = parseMessageRange(sp, new Date());
  const [messages, rejections, instruments, agents] = await Promise.all([
    listInstrumentMessages({ ...range, ...parseMessageFilters(sp), limit: 50 }), // ponytail: first 50 rows; cursor paging when a lab outgrows it
    listMessageRejections({ ...range, limit: 50 }).catch(() => ({ data: [] })), // [CONV] secondary data never blocks the list
    listInstruments({ limit: 200 }).catch(() => ({ data: [] })),
    listAgents({ limit: 200 }).catch(() => ({ data: [] })),
  ]);
  return <MessagesList messages={messages.data} rejections={rejections.data} instruments={instruments.data} agents={agents.data} permissions={session?.actor.permissions ?? []} />;
}
