// T0D-NAV-COMPLETE-1 (LD-250): engagement manifest = C16 04-UI-UX s1.3 (9 entries, group engagement; ids, routeIds, permissions,
// orders and phases are spec-fixed). Chords are NOT compared: the spec says the build check decides (g m is taken by
// instruments.messages); build-nav uniqueness is asserted in nav-complete.build.test.ts.
// ADMINPAGE-ENG-1 (LD-255): /engagement/settings is now built (T1/T2 exist in contracts/openapi/engagement.yaml) -> entry present (unconditional below).
import { describe, expect, it } from 'vitest';
import { loadManifest, pageExists, specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

const row = (id: string, name: string, path: string, permission: string, order: number, phase: string) =>
  ({ name, path, permission, group: 'engagement', order, phase, id: `engagement.${id}`, routeId: `staff.engagement.${id}` }) as const;

specSuite({
  module: 'engagement',
  owner: 'C16',
  section: 'C16 04-UI-UX s1.3',
  rows: [
    row('queue', 'Queue', '/engagement/queue', 'engagement.queue.operate', 10, '2'),
    row('bookings', 'Bookings', '/engagement/bookings', 'engagement.booking.read', 20, '3'),
    row('reminders', 'Reminders', '/engagement/reminders', 'engagement.reminder.read', 30, '2'),
    row('enquiries', 'Enquiries', '/engagement/enquiries', 'engagement.enquiry.read', 40, '3'),
    row('memberships', 'Memberships', '/engagement/memberships', 'engagement.membership.read', 50, '3'),
    row('slots', 'Booking slots', '/engagement/slots', 'engagement.slot.manage', 60, '3'),
    row('bookable', 'Bookable tests', '/engagement/bookable-items', 'engagement.bookable_item.manage', 70, '3'),
    row('queue_setup', 'Queue setup', '/engagement/queue/setup', 'engagement.queue.manage', 80, '2'),
    row('settings', 'Engagement settings', '/engagement/settings', 'engagement.settings.manage', 90, '2'),
  ],
});

describe('ADMINPAGE-ENG-1 (LD-255): Engagement settings entry is present', () => {
  it('page /engagement/settings exists and the manifest has the entry (no longer "absent + CR")', async () => {
    expect(pageExists('/engagement/settings'), 'page /engagement/settings exists').toBe(true);
    const m = await loadManifest('engagement');
    expect(m.entries.filter((e) => e.routeId === 'staff.engagement.settings')).toHaveLength(1);
    expect(m.entries).toHaveLength(9);
  });
});

describe('engagement nav labels (C16 s1.3 label keys)', () => {
  it('label keys are engagement.nav.<id suffix>', async () => {
    const m = await loadManifest('engagement');
    for (const e of m.entries) expect(e.label).toBe(`engagement.nav.${e.id.slice('engagement.'.length)}`);
  });
  it('app access (path parameter) is not a nav entry', async () => {
    const m = await loadManifest('engagement');
    expect(m.entries.some((e) => e.routeId === 'staff.engagement.app_access')).toBe(false);
  });
});
