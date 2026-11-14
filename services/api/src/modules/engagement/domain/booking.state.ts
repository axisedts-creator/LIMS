// Booking state machine (03-APP-FLOW §4.1 B-2..B-7; 05-SCHEMA bookings__status__ck). Pure.

export const BOOKING_STATUSES = ['confirmed', 'checked_in', 'completed', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

const NEXT: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  confirmed: ['checked_in', 'cancelled', 'completed'],
  checked_in: ['cancelled', 'completed'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: BookingStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;

/** Patient self-cancel: confirmed only (03-APP-FLOW §4.1 forbidden list; US-EN-14.1). */
export const canPatientCancel = (s: BookingStatus): boolean => s === 'confirmed';
