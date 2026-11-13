// W1 Bookings (C16 04-UI-UX W1; route staff.engagement.bookings). The permission floor is checked before any API call; without it → 404.
import { requirePerm } from '@/features/engagement/server/queue.server';
import { bookingsPage } from '@/features/engagement/server/booking-pages';

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePerm('engagement.booking.read');
  return bookingsPage(searchParams);
}
