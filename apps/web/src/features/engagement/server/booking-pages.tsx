import 'server-only';
// C16.T-B6 page loaders for W1–W5. The app/(staff)/engagement page files check the permission floor first (notFound() without it); then reads.
import { notFound } from 'next/navigation';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { BookableCatalogueHost, BookingDetailHost, BookingNewHost, BookingsHost, SlotsHost } from '../components/BookingHosts';
import { UUID_RE, has, listQueues, resolveCentre } from './queue.server';
import * as api from './booking.server';
import { PERM } from './booking.server';
import { ApiError } from '@/core/api/server-fetch';
import { dayStartUtc, addDays } from '../components/booking-model';
import { t } from '@/core/i18n/messages';
import { pendingOr } from '@/core/shell/NotAvailable';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const noCentre = <EmptyState title="No centre is available for this account." />;

// T0D-ENGBOOK-1 (LD-310): root cause of "Something went wrong" — with an engagement feature switched off the API answers
// 403 common.feature_disabled and the unguarded list loaders threw into error.tsx. Only that code becomes a plain message;
// every other error still throws so real faults show the error page with a reference. Read-only: no setting is changed here.
const isFeatureOff = (e: unknown) => e instanceof ApiError && e.status === 403 && e.problem?.code === 'common.feature_disabled';
const OFF = Symbol('feature-off');
const orOff = <T,>(p: Promise<T>): Promise<T | typeof OFF> => p.catch((e) => { if (isFeatureOff(e)) return OFF; throw e; });
async function switchedOff(title: string, what: string, helpKey: string) {
  const canManage = await has('engagement.settings.manage').catch(() => false);
  return (
    <>
      <PageHeader title={title} helpKey={helpKey} />
      <EmptyState title={`${what} are switched off for this lab`} />
      {canManage ? <p><a href="/engagement/settings">Open Engagement settings</a></p> : null}
    </>
  );
}
/** Queues for the check-in dialog; staff without engagement.queue.operate get none and can still check in without a token. */
const queuesFor = (centreId: string) => (has('engagement.queue.operate').then((ok) => (ok ? listQueues(centreId) : [])).catch(() => []));

// T0D-UNSLOP-1 / LD-353 rule 6: a read that answers 501 operation_pending shows NotAvailable (title + header row), never error.tsx.
export const bookingsPage = (searchParams: SearchParams) =>
  pendingOr('Bookings', ['Time', 'Booking no.', 'Patient', 'Type', 'Tests', 'Source', 'Status', 'Order'], () => bookingsBody(searchParams));

async function bookingsBody(searchParams: SearchParams) {
  const centreId = await resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return noCentre;
  const today = api.todayKathmandu();
  const [centres, rows, queues, cancelReasons] = await Promise.all([
    api.listCentres(),
    orOff(api.listBookings({ centre_id: centreId, status: ['confirmed', 'checked_in'], slot_start_from: dayStartUtc(today), slot_start_to: dayStartUtc(addDays(today, 1)), sort: 'slot_start' })),
    queuesFor(centreId),
    api.listCancelReasons(),
  ]);
  if (rows === OFF) return switchedOff('Bookings', 'Bookings', 'engagement.bookings');
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

export const bookingNewPage = (searchParams: SearchParams) => pendingOr('New booking', undefined, () => bookingNewBody(searchParams));

async function bookingNewBody(searchParams: SearchParams) {
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

export const slotsPage = (searchParams: SearchParams) => pendingOr(t('engagement.nav.slots'), undefined, () => slotsBody(searchParams));

async function slotsBody(searchParams: SearchParams) {
  const centreId = await resolveCentre(first((await searchParams)['centre_id']));
  if (!centreId) return noCentre;
  const [centres, templates, blackouts] = await Promise.all([api.listCentres(), orOff(api.listTemplates()), orOff(api.listBlackouts())]);
  if (templates === OFF || blackouts === OFF) return switchedOff('Slot templates and blackouts', 'Bookings', 'engagement.slots');
  return (
    <>
      <PageHeader title={t('engagement.nav.slots')} helpKey="engagement.slots" />
      <SlotsHost centres={centres} workingCentreId={centreId} today={api.todayKathmandu()} templates={templates} blackouts={blackouts} />
    </>
  );
}

export async function bookablePage() {
  const items = await orOff(api.listBookableItems());
  if (items === OFF) return switchedOff('Bookable catalogue', 'Bookings', 'engagement.bookable');
  return (
    <>
      <PageHeader title={t('engagement.nav.bookable')} helpKey="engagement.bookable" />
      <BookableCatalogueHost items={items} />
    </>
  );
}
