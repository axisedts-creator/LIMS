'use client';
// C16.T-B6 client hosts: bind the W1–W5 components to the server actions. Nothing here holds a token; every call goes through the BFF.
import { useMemo, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { ToastProvider } from '@lims/ui/components/Toast';
import * as act from '../server/booking-actions';
import { BookableCatalogue, type BookableCatalogueActions } from './BookableCatalogue';
import type { BookingRowActions } from './BookingDialogs';
import { BookingDetail } from './BookingDetail';
import { BookingNew, type BookingNewActions } from './BookingNew';
import { BookingsList, type BookingsListActions } from './BookingsList';
import { SlotsAdmin, type SlotsAdminActions } from './SlotsAdmin';

const key = () => crypto.randomUUID();
/** Server action result → value, or an Error carrying `problem` so the components can map the code to a message. */
function unwrap<T>(r: act.ActionResult<T>): T {
  if (r.ok) return r.data;
  throw Object.assign(new Error(r.code), { problem: { code: r.code } });
}
const rowActions = (): BookingRowActions => ({
  checkIn: async (b, body) => unwrap(await act.checkInAction(b.id, b.version, body, key())),
  cancel: async (b, body) => unwrap(await act.cancelAction(b.id, b.version, body, key())),
});

type Without<P> = Omit<P, 'actions'>;

export function BookingsHost(props: Without<ComponentProps<typeof BookingsList>>) {
  const actions = useMemo<BookingsListActions>(() => ({ ...rowActions(), listBookings: async (q) => unwrap(await act.listBookingsAction(q)) }), []);
  return <ToastProvider><BookingsList {...props} actions={actions} /></ToastProvider>;
}

export function BookingDetailHost(props: Without<ComponentProps<typeof BookingDetail>>) {
  const actions = useMemo(rowActions, []);
  return <ToastProvider><BookingDetail {...props} actions={actions} /></ToastProvider>;
}

export function BookingNewHost(props: Without<ComponentProps<typeof BookingNew>>) {
  const actions = useMemo<BookingNewActions>(() => ({
    searchPatients: async (q) => unwrap(await act.searchPatientsAction(q)),
    listSlots: async (q) => unwrap(await act.listSlotsAction(q)),
    create: async (body) => unwrap(await act.createBookingAction(body, key())),
  }), []);
  return <ToastProvider><BookingNew {...props} actions={actions} /></ToastProvider>;
}

export function SlotsHost(props: Without<ComponentProps<typeof SlotsAdmin>>) {
  const router = useRouter();
  const actions = useMemo<SlotsAdminActions>(() => {
    const after = <T,>(v: T) => { router.refresh(); return v; };
    return {
      createTemplate: async (b) => after(unwrap(await act.createTemplateAction(b, key()))),
      updateTemplate: async (t, b) => after(unwrap(await act.updateTemplateAction(t.id, t.version, b))),
      deactivateTemplate: async (t) => after(unwrap(await act.deactivateTemplateAction(t.id, t.version))),
      createBlackout: async (b) => after(unwrap(await act.createBlackoutAction(b, key()))),
      deactivateBlackout: async (b) => after(unwrap(await act.deactivateBlackoutAction(b.id, b.version))),
    };
  }, [router]);
  return <ToastProvider><SlotsAdmin {...props} actions={actions} /></ToastProvider>;
}

export function BookableCatalogueHost(props: Without<ComponentProps<typeof BookableCatalogue>>) {
  const router = useRouter();
  const actions = useMemo<BookableCatalogueActions>(() => ({
    setActive: async (i, is_active) => {
      unwrap(await act.upsertBookableAction(i.orderable_id, { orderable_kind: i.kind, booking_kinds: i.booking_kinds, sort_order: i.sort_order ?? 0, is_active }, key(), i.version));
      router.refresh();
    },
    searchCatalog: async (q) => unwrap(await act.searchCatalogAction(q)),
    add: async (b) => {
      unwrap(await act.upsertBookableAction(b.orderable_id, { orderable_kind: b.orderable_kind, booking_kinds: b.booking_kinds, sort_order: 0, is_active: b.is_active }, key()));
      router.refresh();
    },
    refresh: async () => { unwrap(await act.syncBookableAction()); },
  }), [router]);
  return <ToastProvider><BookableCatalogue {...props} actions={actions} /></ToastProvider>;
}
