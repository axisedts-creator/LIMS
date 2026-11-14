// W3 New booking (C16 04-UI-UX W3; S3 needs engagement.booking.manage). The permission floor is checked before any API call; without it → 404.
import { requirePerm } from '@/features/engagement/server/queue.server';
import { bookingNewPage } from '@/features/engagement/server/booking-pages';

export default async function BookingNewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePerm('engagement.booking.manage');
  return bookingNewPage(searchParams);
}
