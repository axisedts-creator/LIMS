// @vitest-environment jsdom
// Verification test for receiving mobile app mock bookings in the web app.
// Asserts that bookings created by the patient app ('created_via: app') are displayed accurately
// with all required data, auto-refreshed via polling, and correctly detailed without privacy leaks.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './t-b6.harness';
import type { StaffBooking } from '../components/booking-model';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/engagement/bookings',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('server-only', () => ({}));

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.useRealTimers();
});

const grid = () => screen.getByRole('grid', { name: /booking/i });
const row = (re: RegExp) => {
  const r = H.rowOf(grid(), re);
  if (!r) throw new Error(`no row ${re}; rows: ${JSON.stringify(H.dataRows(grid()).map((x) => H.norm(x.textContent)))}`);
  return r;
};

describe('Web App: Receiving & Displaying Mobile App Mock Bookings', () => {
  it('displays a booking submitted from mobile app with Source: App, Patient name, and Home Collection type', async () => {
    const mockMobileBooking: StaffBooking = {
      id: H.id(881),
      booking_no: 'BK26000881',
      booking_kind: 'home_collection',
      centre_id: H.CENTRE2,
      centre_display_name: 'Synthetic Home Hub',
      slot_start: '2026-01-15T01:15:00.000Z', // 07:00 in Kathmandu
      slot_end: '2026-01-15T02:15:00.000Z',
      status: 'confirmed',
      created_via: 'app', // created via patient mobile app
      items: [
        { orderable_id: H.id(201), display_name: 'Synthetic CBC', indicative_price: { amount_paisa: 35000, currency: 'NPR' } },
        { orderable_id: H.id(202), display_name: 'Synthetic Glucose', indicative_price: { amount_paisa: 20000, currency: 'NPR' } },
      ],
      patient_id: H.id(771),
      patient_name: 'Sunita Sharma',
      home_address_id: H.id(661),
      account_present: true,
      version: 1,
    };

    const actions = H.bookingsActions({
      listBookings: vi.fn(async () => [mockMobileBooking]),
    });

    await H.showBookings(actions, { rows: [mockMobileBooking] });

    const r = row(/BK26000881/);
    const text = H.norm(r.textContent);

    // Verify Time in local Kathmandu time (07:00)
    expect(text).toContain('07:00');
    // Verify Booking Number
    expect(text).toContain('BK26000881');
    // Verify Patient Name
    expect(text).toContain('Sunita Sharma');
    // Verify Type: Home collection
    expect(text).toMatch(/home collection/i);
    // Verify Tests: 2 tests
    expect(text).toMatch(/\b2\b/);
    expect(text).toContain('Synthetic CBC, Synthetic Glucose');
    // Verify Source: App (indicating origin from patient mobile app)
    expect(text).toContain('App');
    // Verify Status Chip
    expect(H.hasChip(/^confirmed$/i)).toBe(true);
  });

  it('provides "All centres" option and queries without centre_id to see bookings across all centres', async () => {
    const actions = H.bookingsActions();
    await H.showBookings(actions);
    const user = userEvent.setup();

    // Pick "All centres" from the centre filter
    await H.pick(user, /centre/i, /all centres/i);
    await waitFor(() => expect(actions.listBookings).toHaveBeenCalled());

    const lastCall = actions.listBookings.mock.calls.at(-1)![0] as Record<string, any>;
    // When "All centres" is chosen, centre_id is omitted from the query
    expect(lastCall.centre_id).toBeUndefined();
    expect(lastCall.status).toEqual(expect.arrayContaining(['confirmed', 'checked_in']));
  });

  it('auto-refreshes periodically in the background so mobile bookings appear without manual refresh', async () => {
    vi.useFakeTimers();

    const initialRows = [H.booking(1)];
    const mockMobileBooking: StaffBooking = {
      id: H.id(992),
      booking_no: 'BK26000992',
      booking_kind: 'centre_visit',
      centre_id: H.CENTRE,
      centre_display_name: 'Synthetic Centre A',
      slot_start: '2026-01-15T02:00:00.000Z',
      slot_end: '2026-01-15T02:15:00.000Z',
      status: 'confirmed',
      created_via: 'app',
      items: [{ orderable_id: H.id(201), display_name: 'Synthetic CBC' }],
      patient_id: H.id(301),
      patient_name: 'Aarav Adhikari',
      account_present: true,
      version: 1,
    };

    const actions = H.bookingsActions({
      listBookings: vi.fn().mockResolvedValue([initialRows[0], mockMobileBooking]),
    });

    await H.showBookings(actions, { rows: initialRows });

    // Initially, newly arrived mobile booking is not yet in the DOM
    expect(screen.queryByText(/BK26000992/)).toBeNull();

    // Advance timer by 12,000ms (auto-refresh interval)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    // Verify actions.listBookings was called automatically by background timer
    expect(actions.listBookings).toHaveBeenCalled();

    // Switch back to real timers for testing-library assertions
    vi.useRealTimers();

    expect(screen.getByText(/BK26000992/)).toBeTruthy();
    expect(H.norm(row(/BK26000992/).textContent)).toContain('App');
  });

  it('renders booking detail with Created via: App, home collection address note, and timeline actor: Patient', async () => {
    const mockMobileDetail: StaffBooking = {
      id: H.id(882),
      booking_no: 'BK26000882',
      booking_kind: 'home_collection',
      centre_id: H.CENTRE2,
      centre_display_name: 'Synthetic Home Hub',
      slot_start: '2026-01-15T01:15:00.000Z',
      slot_end: '2026-01-15T02:15:00.000Z',
      status: 'confirmed',
      created_via: 'app',
      items: [
        { orderable_id: H.id(201), display_name: 'Synthetic CBC', indicative_price: { amount_paisa: 35000, currency: 'NPR' } },
      ],
      patient_id: H.id(772),
      patient_name: 'Sunita Sharma',
      home_address_id: H.id(662),
      account_present: true,
      version: 1,
    };

    const mockTimeline = [
      { status: 'confirmed', at: '2026-01-14T05:00:00.000Z', actor_kind: 'patient' },
    ];

    await H.showDetail(H.bookingsActions(), {
      booking: mockMobileDetail,
      timeline: mockTimeline,
    });

    const page = H.pageText();

    // Verify detail fields
    expect(page).toContain('BK26000882');
    expect(page).toContain('Sunita Sharma');
    expect(page).toMatch(/home collection/i);
    expect(page).toContain('Synthetic Home Hub');
    // Privacy-safe address label: indicates registered address on file without exposing raw unauthenticated text
    expect(page).toContain('Registered address on file');
    // Origin source badge
    expect(page).toContain('App');
    // Timeline actor
    expect(page).toContain('Patient');
  });
});
