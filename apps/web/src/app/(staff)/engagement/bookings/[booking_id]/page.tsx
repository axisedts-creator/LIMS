// W2 Booking detail (C16 04-UI-UX W2; route staff.engagement.booking). The permission floor is checked before any API call; without it → 404.
import { requirePerm } from '@/features/engagement/server/queue.server';
import { bookingDetailPage } from '@/features/engagement/server/booking-pages';

export default async function BookingDetailPage({ params }: { params: Promise<{ booking_id: string }> }) {
  await requirePerm('engagement.booking.read');
  return bookingDetailPage((await params).booking_id);
}
