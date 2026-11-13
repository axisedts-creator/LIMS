// W4 Slot templates & blackouts (C16 04-UI-UX W4; route staff.engagement.slots). The permission floor is checked before any API call; without it → 404.
import { requirePerm } from '@/features/engagement/server/queue.server';
import { slotsPage } from '@/features/engagement/server/booking-pages';

export default async function SlotsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePerm('engagement.slot.manage');
  return slotsPage(searchParams);
}
