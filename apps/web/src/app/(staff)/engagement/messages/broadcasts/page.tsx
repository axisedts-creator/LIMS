// T0D-MSGDESK-1 (LD-321; route staff.engagement.msg_broadcasts, permission engagement.broadcast.read): ElabAssist Messages, the broadcast log.
// ?status is passed on when it is a known status, ?cursor pages, ?broadcast=<uuid> adds the per recipient history (any other value is ignored).
// The signed-in user id (JWT sub of the token the server holds) drives the second person rule display; the API enforces it.
import { getShellSession } from '@/core/session/server';
import { t } from '@/core/i18n/messages';
import { Broadcasts } from '@/features/engagement/components/Broadcasts';
import { STATUSES, currentUserId, isUuid, listBroadcastRecipients, listBroadcastTemplates, listBroadcasts, one, type BroadcastStatus } from '@/features/engagement/server/broadcast.server';
import { settle } from '@/features/partners/server/sales.server';

export const metadata = { title: 'Messages' };

const failedText = (s: number) => t(s === 403 ? 'engagement.msg.load_forbidden' : 'engagement.msg.load_failed');

export default async function BroadcastsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp, me] = await Promise.all([getShellSession(), searchParams, currentUserId()]);
  const status = STATUSES.includes(one(sp['status']) as BroadcastStatus) ? one(sp['status']) : undefined;
  const historyId = one(sp['broadcast']);
  const [list, templates, recipients] = await Promise.all([
    settle(listBroadcasts({ status, cursor: one(sp['cursor']) })),
    settle(listBroadcastTemplates({}, 200)),
    isUuid(historyId) ? settle(listBroadcastRecipients(historyId)) : undefined,
  ]);
  const ok = typeof list === 'number' ? undefined : list;
  const history = isUuid(historyId) && recipients !== undefined
    ? { id: historyId, rows: typeof recipients === 'number' ? [] : recipients.data, ...(typeof recipients === 'number' ? { failed: failedText(recipients) } : {}) }
    : undefined;
  return (
    <Broadcasts rows={ok?.data ?? []} templates={typeof templates === 'number' ? [] : templates.data} me={me} permissions={session?.actor.permissions ?? []}
      status={status} nextCursor={ok?.page.next_cursor} failed={ok ? undefined : failedText(list as number)} history={history} />
  );
}
