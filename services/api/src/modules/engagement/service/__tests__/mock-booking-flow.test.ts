// End-to-end mock data test: sending bookings from the mobile patient app and receiving them in the web app.
// Verifies data completeness, source attribution ('app'), 'All centres' visibility, home collection address, and strict multi-tenant / account separation.
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import {
  A, B, C1, CH, ID, MON, NOW, O, PERMS, S, makeBookingWorld, plus, type Row,
} from '../../__tests__/mybooking.world.js';

describe('End-to-End Mock Data Flow: Mobile Patient App -> Web App Staff Portal', () => {
  it('sends a home-collection booking from mobile app, receives it in the web app with all required data, and verifies strict separation', async () => {
    const w = makeBookingWorld();
    const PATIENT_X = ID(0x801);
    const PATIENT_OTHER = ID(0x802);

    // 1. Setup Patient Accounts
    // Account A1 (Mobile app user 1)
    const accountA1 = w.seedAccount({ phone_e164: '+9779800000001' });
    const profileA1 = w.seedLink(accountA1, PATIENT_X, { display_name: 'Sunita Sharma', sex_snapshot: 'female' });
    const homeAddressA1 = w.seedAddress(accountA1, PATIENT_X, {
      label: 'home',
      address_text: 'Ward 4, Lazimpat, Kathmandu',
      landmark: 'Near Hotel Ambassador',
      municipality: 'Kathmandu Metropolitan',
      ward_no: 4,
      district: 'Kathmandu',
    });

    // Account A2 (Another mobile app user in Tenant A)
    const accountA2 = w.seedAccount({ phone_e164: '+9779800000002' });
    const profileA2 = w.seedLink(accountA2, PATIENT_OTHER, { display_name: 'Bikash Thapa', sex_snapshot: 'male' });

    // 2. Setup Staff Contexts
    const staffUserA = { id: ID(0x901), user_id: ID(0x901), membership_id: ID(0x902) };
    const staffUserB = { id: ID(0x903), user_id: ID(0x903), membership_id: ID(0x904) };

    const slotStartHome = S('01:15'); // Mon 07:00 NPT (matches 60-min home template)
    w.seedOccupancy(slotStartHome, 0, { centre_id: CH, booking_kind: 'home_collection', slot_end: plus(slotStartHome, 60) });

    // ---------------------------------------------------------------------------------------------
    // PHASE 1: Patient Mobile App submits Home Collection booking (POST /v1/engagement/me/bookings)
    // ---------------------------------------------------------------------------------------------
    const mobileSubmissionPayload = {
      profile_id: profileA1['id'],
      booking_kind: 'home_collection',
      home_address_id: homeAddressA1['id'],
      slot_start: slotStartHome,
      orderable_ids: [O.CBC, O.GLU],
    };

    const mobileAppResult = await w.call(
      handlers as any,
      'createMyBooking',
      { account: accountA1, actorType: 'patient', grants: [PERMS.CREATE, PERMS.READ] },
      { body: mobileSubmissionPayload, headers: { 'idempotency-key': 'idemp-mobile-001' } },
    );

    expect(mobileAppResult.error).toBeUndefined();
    expect(mobileAppResult.out).toBeDefined();
    expect(mobileAppResult.out.status).toBe(201);

    const createdBooking = mobileAppResult.out.body;
    expect(createdBooking.id).toBeDefined();
    expect(createdBooking.booking_no).toMatch(/^BK26\d{6}$/);
    expect(createdBooking.status).toBe('confirmed');
    expect(createdBooking.booking_kind).toBe('home_collection');
    expect(createdBooking.created_via).toBe('app'); // strictly stamped as 'app'
    expect(createdBooking.home_address_id).toBe(homeAddressA1['id']);
    expect(createdBooking.items).toHaveLength(2);

    const bookingId = createdBooking.id;
    const bookingNo = createdBooking.booking_no;

    // ---------------------------------------------------------------------------------------------
    // PHASE 2: Web App Staff loads Bookings List (GET /v1/engagement/bookings)
    // ---------------------------------------------------------------------------------------------
    // Staff opens Web App with "All centres" selected (centre_id omitted)
    const webAppListResult = await w.call(
      handlers as any,
      'listBookings',
      { account: staffUserA as any, actorType: 'staff', grants: ['engagement.booking.read'] },
      {
        query: {
          slot_start_from: '2026-11-16T00:00:00.000Z',
          slot_start_to: '2026-11-17T00:00:00.000Z',
          status: 'confirmed,checked_in',
          sort: 'slot_start',
        },
      },
    );

    expect(webAppListResult.error).toBeUndefined();
    expect(webAppListResult.out).toBeDefined();
    expect(webAppListResult.out.status).toBe(200);

    const webListBookings: any[] = webAppListResult.out.body.data;
    expect(webListBookings.length).toBeGreaterThanOrEqual(1);

    // Locate the exact booking submitted from the mobile app
    const foundInWeb = webListBookings.find((b) => b.id === bookingId);
    expect(foundInWeb).toBeDefined();

    // Verify all required data elements are present and accurate for web display:
    expect(foundInWeb.booking_no).toBe(bookingNo);
    expect(foundInWeb.booking_kind).toBe('home_collection');
    expect(foundInWeb.created_via).toBe('app'); // Web displays "App" badge
    expect(foundInWeb.status).toBe('confirmed');
    expect(foundInWeb.slot_start).toBe(slotStartHome);
    expect(foundInWeb.slot_end).toBe(plus(slotStartHome, 60));
    expect(foundInWeb.patient_id).toBe(PATIENT_X);
    expect(foundInWeb.home_address_id).toBe(homeAddressA1['id']); // Available for detail card
    expect(foundInWeb.items).toHaveLength(2);
    expect(foundInWeb.items[0].display_name).toBeDefined();
    expect(foundInWeb.items[0].indicative_price).toBeDefined();

    // ---------------------------------------------------------------------------------------------
    // PHASE 3: Web App Staff views Booking Detail (GET /v1/engagement/bookings/{id})
    // ---------------------------------------------------------------------------------------------
    const webAppDetailResult = await w.call(
      handlers as any,
      'getBooking',
      { account: staffUserA as any, actorType: 'staff', grants: ['engagement.booking.read'] },
      { params: { booking_id: bookingId } },
    );

    expect(webAppDetailResult.error).toBeUndefined();
    expect(webAppDetailResult.out.status).toBe(200);
    const detail = webAppDetailResult.out.body;
    expect(detail.id).toBe(bookingId);
    expect(detail.booking_no).toBe(bookingNo);
    expect(detail.created_via).toBe('app');
    expect(detail.home_address_id).toBe(homeAddressA1['id']);
    expect(detail.transitions).toBeDefined();
    expect(detail.transitions.length).toBeGreaterThanOrEqual(1);
    expect(detail.transitions[0].to).toBe('confirmed');
    expect(detail.transitions[0].actor_type).toBe('patient'); // recorded as created by patient

    // ---------------------------------------------------------------------------------------------
    // PHASE 4: Patient Mobile App also receives its booking in My Bookings (GET /v1/engagement/me/bookings)
    // ---------------------------------------------------------------------------------------------
    const patientBookingsResult = await w.call(
      handlers as any,
      'listMyBookings',
      { account: accountA1, actorType: 'patient', grants: [PERMS.READ] },
      { query: {} },
    );

    expect(patientBookingsResult.error).toBeUndefined();
    const myBookings: any[] = patientBookingsResult.out.body.data;
    expect(myBookings.some((b) => b.id === bookingId)).toBe(true);

    // ---------------------------------------------------------------------------------------------
    // PHASE 5: Strict Multi-Tenant Separation
    // ---------------------------------------------------------------------------------------------
    // Staff in Tenant B queries bookings -> Must NOT see Tenant A's mobile booking!
    const tenantBListResult = await w.call(
      handlers as any,
      'listBookings',
      { account: staffUserB as any, actorType: 'staff', tenant: B, grants: ['engagement.booking.read'] },
      {
        query: {
          slot_start_from: '2026-11-16T00:00:00.000Z',
          slot_start_to: '2026-11-17T00:00:00.000Z',
          status: 'confirmed,checked_in',
          sort: 'slot_start',
        },
      },
    );

    expect(tenantBListResult.out.status).toBe(200);
    const tenantBBookings: any[] = tenantBListResult.out.body.data;
    expect(tenantBBookings.some((b) => b.id === bookingId)).toBe(false);

    // ---------------------------------------------------------------------------------------------
    // PHASE 6: Strict Patient Account Isolation
    // ---------------------------------------------------------------------------------------------
    // Another patient (Account A2) in Tenant A queries their bookings -> Must NOT see Account A1's booking!
    const accountA2ListResult = await w.call(
      handlers as any,
      'listMyBookings',
      { account: accountA2, actorType: 'patient', grants: [PERMS.READ] },
      { query: {} },
    );

    expect(accountA2ListResult.out.status).toBe(200);
    const accountA2Bookings: any[] = accountA2ListResult.out.body.data;
    expect(accountA2Bookings.some((b) => b.id === bookingId)).toBe(false);
  });

  it('sends a centre-visit booking from mobile app, receives it when webapp filters by that centre', async () => {
    const w = makeBookingWorld();
    const PATIENT_X = ID(0x803);
    const accountA1 = w.seedAccount({ phone_e164: '+9779800000003' });
    const profileA1 = w.seedLink(accountA1, PATIENT_X, { display_name: 'Aarav Adhikari', sex_snapshot: 'male' });
    const staffUserA = { id: ID(0x905), user_id: ID(0x905), membership_id: ID(0x906) };

    const slotStartCentre = S('02:00'); // Mon 07:45 NPT at C1
    w.seedOccupancy(slotStartCentre, 0, { centre_id: C1, booking_kind: 'centre_visit' });

    // 1. Mobile app creates Centre Visit booking
    const mobileSubmission = {
      profile_id: profileA1['id'],
      booking_kind: 'centre_visit',
      centre_id: C1,
      slot_start: slotStartCentre,
      orderable_ids: [O.CBC],
    };

    const mobileRes = await w.call(
      handlers as any,
      'createMyBooking',
      { account: accountA1, actorType: 'patient', grants: [PERMS.CREATE, PERMS.READ] },
      { body: mobileSubmission, headers: { 'idempotency-key': 'idemp-mobile-002' } },
    );

    expect(mobileRes.out.status).toBe(201);
    const created = mobileRes.out.body;
    expect(created.booking_kind).toBe('centre_visit');
    expect(created.centre_id).toBe(C1);
    expect(created.created_via).toBe('app');

    // 2. Web app queries specifically for centre C1
    const webRes = await w.call(
      handlers as any,
      'listBookings',
      { account: staffUserA as any, actorType: 'staff', grants: ['engagement.booking.read'] },
      {
        query: {
          centre_id: C1,
          slot_start_from: '2026-11-16T00:00:00.000Z',
          slot_start_to: '2026-11-17T00:00:00.000Z',
          status: 'confirmed',
          sort: 'slot_start',
        },
      },
    );

    expect(webRes.out.status).toBe(200);
    const bookings: any[] = webRes.out.body.data;
    const found = bookings.find((b) => b.id === created.id);
    expect(found).toBeDefined();
    expect(found.booking_no).toBe(created.booking_no);
    expect(found.created_via).toBe('app');
    expect(found.booking_kind).toBe('centre_visit');
    expect(found.centre_id).toBe(C1);
  });
});
