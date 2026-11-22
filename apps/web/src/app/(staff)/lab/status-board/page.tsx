// 04-UI-UX §3.11 (route /lab/status-board). Reference + first board read are best-effort: a refused centres read → no centre filter options,
// T0D-FIX-11 (LD-455 rule 3): a failed first board read is the kit inline error with the reference under the title, never an empty board. The default range is the last 24 h onward (≤ 7 days, ISO UTC);
// the query carries only the range (REQ-SEC-098: no patient / order identifier in a URL).
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { LoadError } from '@/core/shell/LoadError';
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
    allowed ? getStatusBoard({ registered_at_from: initialRange.from, registered_at_to: initialRange.to }).catch((e: unknown) => { if (e instanceof ApiError) return e; throw e; }) : undefined,
  ]);
  if (first instanceof ApiError) return <LoadError title={t('lab.nav.status_board')} {...(first.problem.request_id ? { requestId: first.problem.request_id } : {})} />;
  return <StatusBoard centres={centres} initialRows={first?.data ?? []} {...(first?.page.next_cursor ? { initialNextCursor: first.page.next_cursor } : {})}initialRange={initialRange} permissions={permissions} />;
}
