// T0D-MSGDESK-1 (LD-321; route staff.engagement.msg_templates, permission engagement.broadcast.read): ElabAssist Messages > Create New Template.
// ?channel (sms, whatsapp, email) and ?is_active (true, false) are passed on when known; ?cursor pages. The API decides access: a refused read keeps the page.
import { getShellSession } from '@/core/session/server';
import { t } from '@/core/i18n/messages';
import { MessageTemplates } from '@/features/engagement/components/MessageTemplates';
import { CHANNELS, listBroadcastTemplates, one, type Channel } from '@/features/engagement/server/broadcast.server';
import { settle } from '@/features/partners/server/sales.server';

export const metadata = { title: 'Message Templates' };

export default async function MessageTemplatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const channel = CHANNELS.includes(one(sp['channel']) as Channel) ? one(sp['channel']) : undefined;
  const isActive = one(sp['is_active']);
  const filter = { channel, is_active: isActive === 'true' || isActive === 'false' ? isActive : undefined };
  const list = await settle(listBroadcastTemplates({ ...filter, cursor: one(sp['cursor']) }));
  const ok = typeof list === 'number' ? undefined : list;
  return (
    <MessageTemplates rows={ok?.data ?? []} permissions={session?.actor.permissions ?? []} filter={filter} nextCursor={ok?.page.next_cursor}
      failed={ok ? undefined : t(list === 403 ? 'engagement.msg.load_forbidden' : 'engagement.msg.load_failed')} />
  );
}
