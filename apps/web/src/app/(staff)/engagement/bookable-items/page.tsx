// W5 Bookable catalogue (C16 04-UI-UX W5; route staff.engagement.bookable). The permission floor is checked before any API call; without it → 404.
import { requirePerm } from '@/features/engagement/server/queue.server';
import { bookablePage } from '@/features/engagement/server/booking-pages';

export default async function BookablePage() {
  await requirePerm('engagement.bookable_item.manage');
  return bookablePage();
}
