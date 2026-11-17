// 04-UI-UX §3.11 (route /lab/status-board). Reference + first board read are best-effort: a refused centres read → no centre filter options,
// a refused board read → an empty board (the screen polls and shows its own error). The default range is the last 24 h onward (≤ 7 days, ISO UTC);
// the query carries only the range (REQ-SEC-098: no patient / order identifier in a URL).
import { getShellSession } from '@/core/session/server';
import { StatusBoard } from '@/features/lab/components/StatusBoard';
import { listCentres } from '@/features/frontdesk/server/read.server';
import { getStatusBoard } from '@/features/lab/server/read.server';

export const metadata = { title: 'Status board' };

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export default async function StatusBoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const from = new Date(Math.floor((Date.now() - 24 * HOUR_MS) / MINUTE_MS) * MINUTE_MS);
  const initialRange = { from: from.toISOString(), to: new Date(from.getTime() + 7 * 24 * HOUR_MS).toISOString() };
  const allowed = permissions.includes('lab.status_board.read');
  const [centres, first] = await Promise.all([
    allowed ? listCentres().catch(() => []) : [],
    allowed ? getStatusBoard({ registered_at_from: initialRange.from, registered_at_to: initialRange.to }).catch(() => undefined) : undefined,
  ]);
  return <StatusBoard centres={centres} initialRows={first?.data ?? []} {...(first?.page.next_cursor ? { initialNextCursor: first.page.next_cursor } : {})}initialRange={initialRange} permissions={permissions} />;
}
