import 'server-only';
// C16.T-B6 page loaders for W1–W5. The app/(staff)/engagement page files check the permission floor first (notFound() without it); then reads.
import { notFound } from 'next/navigation';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { BookableCatalogueHost, BookingDetailHost, BookingNewHost, BookingsHost, SlotsHost } from '../components/BookingHosts';
import { UUID_RE, has, listQueues, resolveCentre } from './queue.server';
import * as api from './booking.server';
import { PERM } from './booking.server';
import { dayStartUtc, addDays } from '../components/booking-model';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const noCentre = <EmptyState title="No centre is available for this account." />;
/** Queues for the check-in dialog; staff without engagement.queue.operate get none and can still check in without a token. */
const queuesFor = (centreId: string) => (has('engagement.queue.operate').then((ok) => (ok ? listQueues(centreId) : [])).catch(() => []));

export async function bookingsPage(searchParams: SearchParams) {
  const centreId = await resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return noCentre;
  const today = api.todayKathmandu();
  const [centres, rows, queues, cancelReasons] = await Promise.all([
    api.listCentres(),
    api.listBookings({ centre_id: centreId, status: ['confirmed', 'checked_in'], slot_start_from: dayStartUtc(today), slot_start_to: dayStartUtc(addDays(today, 1)), sort: 'slot_start' }),
    queuesFor(centreId),
    api.listCancelReasons(),
  ]);
  return (
    <>
      <PageHeader title="Bookings" helpKey="engagement.bookings" />
      <BookingsHost centres={centres} workingCentreId={centreId} today={today} rows={rows} queues={queues} cancelReasons={cancelReasons} />
    </>
  );
}

export async function bookingDetailPage(bookingId: string) {
  if (!UUID_RE.test(bookingId)) notFound();
  const detail = await api.getBooking(bookingId).catch(() => undefined);
  if (!detail) notFound();
  const { transitions = [], ...booking } = detail;
  const [[named], queues, cancelReasons] = await Promise.all([api.withPatientNames([booking]), queuesFor(booking.centre_id), api.listCancelReasons()]);
  return (
    <>
      <PageHeader title={`Booking ${booking.booking_no}`} helpKey="engagement.bookings" />
      <BookingDetailHost booking={named!} timeline={transitions} queues={queues} cancelReasons={cancelReasons} />
    </>
  );
}

export async function bookingNewPage(searchParams: SearchParams) {
  const centreId = await resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return noCentre;
  // S12 needs engagement.bookable_item.manage; without it the Tests list is empty (open point in T-B6-impl.md).
  const [centres, items] = await Promise.all([api.listCentres(), (await has(PERM.bookableManage)) ? api.listBookableItems().catch(() => []) : Promise.resolve([])]);
  return (
    <>
      <PageHeader title="New booking" helpKey="engagement.bookings" />
      <BookingNewHost centres={centres} workingCentreId={centreId} today={api.todayKathmandu()} bookableItems={items.filter((i) => i.is_active)} />
    </>
  );
}

export async function slotsPage(searchParams: SearchParams) {
  const centreId = await resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return noCentre;
  const [centres, templates, blackouts] = await Promise.all([api.listCentres(), api.listTemplates(), api.listBlackouts()]);
  return (
    <>
      <PageHeader title="Slot templates and blackouts" helpKey="engagement.slots" />
      <SlotsHost centres={centres} workingCentreId={centreId} today={api.todayKathmandu()} templates={templates} blackouts={blackouts} />
    </>
  );
}

export async function bookablePage() {
  const items = await api.listBookableItems();
  return (
    <>
      <PageHeader title="Bookable catalogue" helpKey="engagement.bookable" />
      <BookableCatalogueHost items={items} />
    </>
  );
}
